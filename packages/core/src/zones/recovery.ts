// Pure recovery state. The session owns snapshots, smoothing and epoch-boundary resets.
import { MAX_PEERS } from '../timing.ts'
import { seatHostFor } from './rendezvous.ts'
import type { CostClass, ZoneTuning } from './tuning.ts'
import type { DomainId, DomainKind, SeatId } from './types.ts'

export interface HashCheck {
  domain: DomainId
  tick: number
  hash: number
}

export interface HashAgreement {
  tick: number
  status: 'pending' | 'agreement' | 'disagreement'
  complete: boolean
  /** Remote peers differing from the local hash; only the first differingCount entries are valid. */
  readonly differing: Int16Array
  differingCount: number
}

export interface RecoveryDecision {
  action: CostClass
  authority: number
  localAuthority: boolean
  localLoser: boolean
  /** The session brackets a tiebreak restore with CorrectionSmoother.capture/settle. */
  smooth: boolean
  /** Checkpoint to restore, or the next epoch boundary for reset. */
  tick: number
}

/** One instance per domain. Record, compare and selection reuse constructor-owned storage. */
export class DomainRecovery {
  readonly domain: DomainId
  readonly localPeer: number
  readonly checkCap: number
  private readonly tuning: ZoneTuning
  private readonly ticks: Int32Array
  private readonly hashes: Uint32Array
  private readonly cursors = new Uint32Array(MAX_PEERS)
  private readonly result: HashAgreement = {
    tick: -1, status: 'pending', complete: false,
    differing: new Int16Array(MAX_PEERS), differingCount: 0,
  }
  private floor = 0
  private keyframe = -1

  constructor(
    domain: DomainId,
    localPeer: number,
    tuning: ZoneTuning,
    checkCap: number,
  ) {
    if (!Number.isInteger(checkCap) || checkCap < 0) throw new RangeError('invalid check cap')
    this.domain = domain
    this.localPeer = localPeer
    this.tuning = tuning
    this.checkCap = checkCap
    this.ticks = new Int32Array(MAX_PEERS * tuning.snapshotRing).fill(-1)
    this.hashes = new Uint32Array(this.ticks.length)
  }

  /** Both local and remote confirmed hashes enter here; late packets cannot evict newer slots. */
  record(peer: number, tick: number, hash: number): void {
    if (peer < 0 || peer >= MAX_PEERS || tick < this.floor) return
    const i = peer * this.tuning.snapshotRing + tick % this.tuning.snapshotRing
    if (this.ticks[i] >= tick) return
    this.ticks[i] = tick
    this.hashes[i] = hash
  }

  /** Borrowed until the next check. A disagreement can be reported before all hashes arrive. */
  check(tick: number, replicas: readonly number[]): HashAgreement {
    const out = this.result
    out.tick = tick
    out.status = 'pending'
    out.complete = false
    out.differingCount = 0
    if (tick < this.floor || !replicas.includes(this.localPeer)) return out
    const size = this.tuning.snapshotRing
    const slot = tick % size
    const local = this.localPeer * size + slot
    if (this.ticks[local] !== tick) return out
    out.complete = true
    for (let i = 0; i < replicas.length; i++) {
      const peer = replicas[i]
      const index = peer * size + slot
      if (this.ticks[index] !== tick) out.complete = false
      else if (peer !== this.localPeer && this.hashes[index] !== this.hashes[local]) {
        out.differing[out.differingCount++] = peer
      }
    }
    if (out.differingCount) out.status = 'disagreement'
    else if (out.complete) out.status = 'agreement'
    return out
  }

  /** Fill preallocated wire check objects; the returned count is the valid prefix of out. */
  pickChecks(peer: number, replicas: readonly number[], out: HashCheck[]): number {
    if (peer === this.localPeer || !replicas.includes(peer) || !replicas.includes(this.localPeer)) return 0
    const size = this.tuning.snapshotRing
    const cap = Math.min(this.checkCap, out.length)
    let slot = this.cursors[peer]
    let count = 0
    // Rotate through retained checks on every send so loss does not permanently hide a hash.
    for (let visited = 0; visited < size && count < cap; visited++) {
      const index = this.localPeer * size + slot
      slot = (slot + 1) % size
      if (this.ticks[index] < this.floor) continue
      const check = out[count++]
      check.domain = this.domain
      check.tick = this.ticks[index]
      check.hash = this.hashes[index]
    }
    this.cursors[peer] = slot
    return count
  }

  get keyframeTick(): number { return this.keyframe }

  /** Call only after retaining the agreed snapshot. Keyframe cadence is in epochs. */
  markKeyframe(tick: number, replicas: readonly number[]): boolean {
    if (tick <= this.keyframe || tick % (this.tuning.epochTicks * this.tuning.keyframeEvery) !== 0) return false
    if (this.check(tick, replicas).status !== 'agreement') return false
    this.keyframe = tick
    return true
  }

  /** Cold path: unlike chooseAuthority, zone recovery always uses replicas[0], even against a majority. */
  decide(kind: DomainKind, tick: number, replicas: readonly number[], presentTick: number): RecoveryDecision | null {
    const result = this.check(tick, replicas)
    if (!result.complete || result.status !== 'disagreement') return null
    const authority = replicas[0]
    const size = this.tuning.snapshotRing
    const slot = tick % size
    const localLoser = this.hashes[this.localPeer * size + slot] !== this.hashes[authority * size + slot]
    const action = this.tuning.costClass[kind]
    return {
      action, authority, localAuthority: this.localPeer === authority, localLoser,
      smooth: action === 'tiebreak' && localLoser,
      tick: action === 'reset'
        ? (Math.floor(presentTick / this.tuning.epochTicks) + 1) * this.tuning.epochTicks
        : action === 'checkpoint' ? this.keyframe : tick,
    }
  }

  /** After correction, pre-correction packets and checks must not start another episode. */
  clear(fromTick: number): void {
    this.ticks.fill(-1)
    this.cursors.fill(0)
    this.floor = fromTick
    // The session retains the agreed keyframe separately from the rolling snapshots.
  }
}

/** One agreement per (domain, lostPeer). Each report is the last tick across that peer's seats. */
export class DropAgreement {
  readonly domain: DomainId
  readonly lostPeer: number
  private readonly reports = new Float64Array(MAX_PEERS).fill(-Infinity)
  private readonly live: number[] = []
  private agreed: number | null = null

  constructor(domain: DomainId, lostPeer: number, liveReplicas: readonly number[]) {
    this.domain = domain
    this.lostPeer = lostPeer
    this.setLiveReplicas(liveReplicas)
  }

  /** Membership changes are cold paths. Completed agreements keep their switch tick. */
  setLiveReplicas(replicas: readonly number[]): void {
    for (let peer = 0; peer < MAX_PEERS; peer++) {
      if (!replicas.includes(peer) || !this.live.includes(peer)) this.reports[peer] = -Infinity
    }
    this.live.length = 0
    for (let i = 0; i < replicas.length; i++) {
      if (replicas[i] !== this.lostPeer) this.live.push(replicas[i])
    }
  }

  /** The local replica reports through the same path as remote replicas. */
  report(peer: number, lastTick: number): void {
    if (this.agreed !== null || !this.live.includes(peer)) return
    this.reports[peer] = Math.max(this.reports[peer], lastTick)
  }

  /** Null until every live replica reports; -1 is a valid last tick (no seat input yet). */
  check(): number | null {
    if (this.agreed !== null) return this.agreed
    if (this.live.length === 0) return null
    let last = -Infinity
    for (let i = 0; i < this.live.length; i++) {
      const tick = this.reports[this.live[i]]
      if (tick === -Infinity) return null
      last = Math.max(last, tick)
    }
    this.agreed = last
    return last
  }

  get fromTick(): number | null {
    const tick = this.check()
    return tick === null ? null : tick + 1
  }

  /** Pass the assignment epoch at the switch; apply this host starting at fromTick. */
  botHost(seat: SeatId, epoch: number): number {
    return this.check() === null ? -1 : seatHostFor(seat, epoch, this.live)
  }
}

/** The session also gates takeover on drop agreement and the local peer being the bot host. */
export class BotTakeoverTimer {
  private readonly lastNews: Float64Array
  private readonly tuning: ZoneTuning

  constructor(seatCount: number, startMs: number, tuning: ZoneTuning) {
    this.tuning = tuning
    this.lastNews = new Float64Array(seatCount).fill(startMs)
  }

  record(seat: SeatId, nowMs: number): void {
    this.lastNews[seat] = Math.max(this.lastNews[seat], nowMs)
  }

  check(seat: SeatId, nowMs: number): boolean {
    return nowMs - this.lastNews[seat] > this.tuning.botTakeoverMs
  }
}

/** One instance per domain; register entities off the hot path, before processing transitions. */
export class SleepWakeDedupe {
  readonly domain: DomainId
  private readonly sent = new Map<number, { tick: number; asleep: boolean; known: boolean }>()

  constructor(domain: DomainId) { this.domain = domain }

  register(id: number): void {
    if (!this.sent.has(id)) this.sent.set(id, { tick: -1, asleep: false, known: false })
  }

  /** Call when sending a confirmed producer transition. Old resimulated transitions stay suppressed. */
  record(id: number, tick: number, asleep: boolean): boolean {
    const previous = this.sent.get(id)
    if (!previous || tick <= previous.tick) return false
    const changed = !previous.known || previous.asleep !== asleep
    previous.tick = tick
    previous.asleep = asleep
    previous.known = true
    return changed
  }

  /** Only forget entities permanently removed from this domain. */
  forget(id: number): void { this.sent.delete(id) }
}
