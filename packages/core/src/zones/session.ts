// The zone session of one peer: a fixed-tick accumulator over the domains it replicates. Each domain keeps its own
// inputs, frontier, snapshot ring and rollback, so a missing input stalls only the domains that wait for it.
// Tick numbering follows RollbackSession: the snapshot and hash of tick t are those of the state before step t.
import { InputBuffer } from '../inputBuffer.ts'
import { MAX_FRAME_DT } from '../rollback.ts'
import { CorrectionSmoother } from '../smoothing.ts'
import { DEFAULT_DELAY_HIDDEN_TICKS, DEFAULT_MAX_DELAY, DEFAULT_MAX_PREDICTION, DEFAULT_MIN_DELAY, DEFAULT_TICK_RATE, DelayController, MAX_PEERS } from '../timing.ts'
import type { InputCodec, RollbackTuning } from '../types.ts'
import { assign } from './assign.ts'
import { DomainRing } from './domainRing.ts'
import { DomainFrontier } from './frontier.ts'
import { validateZoneTuning } from './tuning.ts'
import type { ZoneTuning } from './tuning.ts'
import type { Assignment, DomainFactory, DomainId, DomainSim, DomainSpec, GroupTransport, Roster, SeatId } from './types.ts'

/** Receives the display-only far stream: poses of entities in domains the local peer does not replicate. */
export interface FarSink {
  /** `entries` is a view valid during the call; the producing domain's far() defines its layout. */
  far(domain: DomainId, tick: number, stride: number, n: number, entries: Uint8Array): void
}

export interface ZoneSessionConfig<TInput>
  extends Pick<RollbackTuning, 'tickRate' | 'maxPrediction' | 'minDelay' | 'maxDelay' | 'delayHiddenTicks' | 'lostAfterMs' | 'dropWaitMs'> {
  localPeer: number
  roster: Roster
  /** Identical on every peer; validated with validateZoneTuning. */
  tuning: ZoneTuning
  factory: DomainFactory<TInput>
  codec: InputCodec<TInput>
  /** Control word of every seat for epoch 0 (roster.seatCount words), predicted until a seat's own words arrive. */
  controls: Uint32Array
  /** Most ticks run per frame, by the session and by each lagging domain. Default: the ticks of one MAX_FRAME_DT. */
  maxSubsteps?: number
  initialDelay?: number
  far?: FarSink
}

export interface ZoneStats {
  /** Session tick: the next tick sampled for the local seats. */
  tick: number
  /** Last confirmed tick of each replicated domain, by domain id. */
  confirmedTick: Record<DomainId, number>
  delay: number
  frames: number
  rollbacks: number
  maxRollback: number
  resimTicks: number
  /** Frames in which a domain holding a local seat could not step, so the local seats waited. */
  stallFrames: number
  desyncs: number
  malformed: number
  lostPeers: number[]
}

/** One domain replicated by the local peer. */
export interface DomainState<TInput> {
  spec: DomainSpec
  sim: DomainSim<TInput>
  readonly inputs: DomainFrontier
  readonly ring: DomainRing
  /** Earliest simulated tick whose known input differs from the one used; Infinity when none. */
  rollbackTick: number
  /** replicas[0]: sends FAR, SLEEP/WAKE and the DOMAIN_SNAPSHOT of a handoff. */
  producer: boolean
  /** False while the domain is only kept for a handoff grace, until graceUntil (-1 outside a grace). */
  replica: boolean
  graceUntil: number
  /** Last tick whose hash is in the hash ring as confirmed, or -1. */
  confirmed: number
  smoother: CorrectionSmoother | null
  /** sim.hash() of each ring slot, moved to the hash ring once its tick is confirmed. */
  readonly hashes: Uint32Array
  /** Code each seat used at a tick, at seat * ring.size + tick % ring.size. */
  readonly usedCode: Uint32Array
  readonly usedTick: Int32Array
  /** Decoded inputs in spec.seats order, reused by every step. */
  readonly decoded: TInput[]
}

/**
 * The zone session of one peer. The session tick advances with the accumulator while every domain holding a local
 * seat can step it; each replicated domain then steps toward it on its own, bounded by its frontier.
 */
export class ZoneSession<TInput> {
  readonly stats: ZoneStats
  private readonly net: GroupTransport
  private readonly cfg: ZoneSessionConfig<TInput>
  private readonly codec: InputCodec<TInput>
  private readonly tuning: ZoneTuning
  private readonly fixedDt: number
  private readonly maxSubsteps: number
  private readonly maxPrediction: number
  /** Ring length of every seat, control and shadow input: a rollback over the ring, prediction and delay ahead, the lead back. */
  private readonly inputCapacity: number
  private acc = 0
  private tick = 0
  private isStalled = false
  private current: Assignment
  /** Replicated domains, ascending id. */
  private readonly list: DomainState<TInput>[] = []
  private readonly byId = new Map<DomainId, DomainState<TInput>>()
  private readonly localSeats: SeatId[]
  /** The seat domain of each local seat when replicated here (it decides the local stall), else null. */
  private readonly localDomain: (DomainState<TInput> | null)[] = []
  private readonly localIn: TInput[] = []
  private readonly localCodes: Uint32Array
  private readonly localControls: Uint32Array
  /** Control words of every seat by tick: the assignment of epoch E reads the confirmed ones at E*K-L. */
  private readonly controlBufs: InputBuffer[] = []
  private readonly delayCtl: DelayController

  constructor(cfg: ZoneSessionConfig<TInput>, net: GroupTransport) {
    this.cfg = cfg
    this.net = net
    this.codec = cfg.codec
    this.tuning = cfg.tuning
    const tickRate = cfg.tickRate ?? DEFAULT_TICK_RATE
    if (!(tickRate > 0 && tickRate < Infinity)) throw new Error('[zones] session: bad tickRate')
    this.fixedDt = 1 / tickRate
    this.maxSubsteps = cfg.maxSubsteps ?? Math.ceil(MAX_FRAME_DT * tickRate)
    if (!(Number.isInteger(this.maxSubsteps) && this.maxSubsteps >= 1)) throw new Error('[zones] session: bad maxSubsteps')
    this.maxPrediction = cfg.maxPrediction ?? DEFAULT_MAX_PREDICTION
    const maxDelay = cfg.maxDelay ?? DEFAULT_MAX_DELAY
    validateZoneTuning(cfg.tuning, { maxPrediction: this.maxPrediction, maxDelay })
    if (!(cfg.tuning.snapshotRing > this.maxPrediction)) throw new Error('[zones] session: snapshotRing must exceed maxPrediction')
    const roster = cfg.roster
    const local = roster.peers.find((p) => p.peer === cfg.localPeer)
    if (!(cfg.localPeer >= 0 && cfg.localPeer < MAX_PEERS && local)) throw new Error(`[zones] session: local peer ${cfg.localPeer} is not in the roster`)
    if (cfg.controls.length !== roster.seatCount) throw new Error('[zones] session: controls must hold one word per seat')
    for (const s of local.seats) {
      if (!(Number.isInteger(s) && s >= 0 && s < roster.seatCount)) throw new Error(`[zones] session: bad local seat ${s}`)
    }
    this.localSeats = local.seats.slice()
    this.inputCapacity = cfg.tuning.snapshotRing + cfg.tuning.leadTicks + this.maxPrediction + maxDelay
    const minDelay = cfg.minDelay ?? DEFAULT_MIN_DELAY
    const hiddenTicks = cfg.delayHiddenTicks ?? DEFAULT_DELAY_HIDDEN_TICKS
    this.delayCtl = new DelayController(cfg.initialDelay, { tickRate, minDelay, maxDelay, hiddenTicks })
    const n = this.localSeats.length
    for (let i = 0; i < n; i++) this.localIn.push(cfg.codec.create())
    this.localCodes = new Uint32Array(n)
    this.localControls = new Uint32Array(n)
    for (let s = 0; s < roster.seatCount; s++) this.controlBufs.push(new InputBuffer(cfg.controls[s], this.inputCapacity))
    this.stats = {
      tick: 0, confirmedTick: {}, delay: this.delayCtl.current, frames: 0, rollbacks: 0, maxRollback: 0, resimTicks: 0,
      stallFrames: 0, desyncs: 0, malformed: 0, lostPeers: [],
    }

    // Epoch 0: every domain the local peer replicates, created in ascending id order.
    this.current = assign(roster, { epoch: 0, words: cfg.controls.slice() }, null, cfg.tuning)
    for (const spec of this.current.domains) {
      if (spec.replicas.indexOf(cfg.localPeer) >= 0) this.addDomain(spec, cfg.factory.create(spec, 0))
    }
    this.bindLocal()

    // Ticks 0..delay-1 of the local seats: neutral inputs and the epoch 0 control words.
    for (let t = 0; t < this.delayCtl.current; t++) {
      for (const seat of this.localSeats) {
        this.controlBufs[seat].set(t, cfg.controls[seat])
        this.storeLocalSeat(seat, t, cfg.codec.neutral >>> 0)
      }
    }
  }

  get stalled(): boolean {
    return this.isStalled
  }

  get assignment(): Assignment {
    return this.current
  }

  /** A domain replicated by the local peer, or undefined. */
  domain(id: DomainId): DomainState<TInput> | undefined {
    return this.byId.get(id)
  }

  /** The local confirmed hash of a domain at a tick still in its hash ring, or undefined. */
  confirmedHash(domain: DomainId, tick: number): number | undefined {
    const d = this.byId.get(domain)
    return d ? d.ring.hashAt(tick) : undefined
  }

  /**
   * One rendered frame: receive, recover, roll back the domains that need it, sample and store the due local ticks
   * (unless a local seat's domain stalls), step every domain toward the session tick, confirm and send. Returns alpha.
   */
  frame(frameDt: number, sample: (inputs: TInput[], controls: Uint32Array) => void): number {
    const stats = this.stats
    stats.frames++
    const dt = frameDt > 0 ? (frameDt < MAX_FRAME_DT ? frameDt : MAX_FRAME_DT) : 0
    const now = this.net.now()
    this.receive(now)
    this.recover(now)
    const list = this.list
    for (let i = 0; i < list.length; i++) {
      if (list[i].smoother) list[i].smoother!.decay(dt)
      this.rollback(list[i])
    }

    const delay = this.updateDelay(now)
    this.acc += dt
    let due = Math.floor(this.acc / this.fixedDt)
    if (due > this.maxSubsteps) due = this.maxSubsteps
    this.isStalled = false
    for (let i = 0; i < due; i++) {
      if (this.localStalled()) {
        this.isStalled = true
        break
      }
      sample(this.localIn, this.localControls)
      this.storeLocal(this.tick, delay)
      this.tick++
      this.acc -= this.fixedDt
    }
    if (this.isStalled) stats.stallFrames++
    if (this.acc > this.maxSubsteps * this.fixedDt) this.acc = this.maxSubsteps * this.fixedDt

    // Each domain catches up on its own; one waiting for an input stalls alone.
    for (let i = 0; i < list.length; i++) {
      const d = list[i]
      for (let k = 0; k < this.maxSubsteps && d.sim.tick < this.tick && d.inputs.canStep(d.sim.tick, this.maxPrediction); k++) {
        this.simulate(d, d.sim.tick)
      }
      this.confirm(d)
    }
    this.send(now)
    stats.tick = this.tick
    stats.delay = delay
    const a = this.acc / this.fixedDt
    return a > 0 ? (a < 1 ? a : 1) : 0
  }

  /** Adds a domain replicated here in ascending id order; the epoch task adds rebuilt and joined ones too. */
  private addDomain(spec: DomainSpec, sim: DomainSim<TInput>): DomainState<TInput> {
    const ring = new DomainRing(this.tuning)
    const slots = this.cfg.roster.seatCount * ring.size
    const inbound = DomainFrontier.inbound(spec, this.current.shadows, this.current.domains)
    const frontierCfg = { capacity: this.inputCapacity, shadowSlotBytes: 0, neutral: this.codec.neutral >>> 0 }
    const d: DomainState<TInput> = {
      spec,
      sim,
      inputs: new DomainFrontier(frontierCfg, spec, inbound),
      ring,
      rollbackTick: Infinity,
      producer: spec.replicas[0] === this.cfg.localPeer,
      replica: true,
      graceUntil: -1,
      confirmed: sim.tick - 1,
      smoother: sim.view ? new CorrectionSmoother(sim.view.entities, sim.view.stride) : null,
      hashes: new Uint32Array(ring.size),
      usedCode: new Uint32Array(slots),
      usedTick: new Int32Array(slots).fill(-1),
      decoded: [],
    }
    let at = this.list.length
    while (at > 0 && this.list[at - 1].spec.id > spec.id) at--
    this.list.splice(at, 0, d)
    this.byId.set(spec.id, d)
    this.stats.confirmedTick[spec.id] = d.confirmed
    return d
  }

  /** Maps each local seat to its seat domain; run again whenever the assignment changes. */
  private bindLocal(): void {
    this.localDomain.length = 0
    for (const seat of this.localSeats) {
      const id = this.current.seatDomain[seat]
      this.localDomain.push(id >= 0 ? (this.byId.get(id) ?? null) : null)
    }
  }

  /** True when a domain holding a local seat cannot step the session tick: the local seats wait. */
  private localStalled(): boolean {
    const doms = this.localDomain
    for (let i = 0; i < doms.length; i++) {
      if (doms[i] && !doms[i]!.inputs.canStep(this.tick, this.maxPrediction)) return true
    }
    return false
  }

  /**
   * Runs tick t of one domain: the snapshot and hash of t, the epoch boundary (after the snapshot, so a rollback to t
   * replays it), the known or predicted code of every member seat (recorded as used), then the step.
   */
  private simulate(d: DomainState<TInput>, t: number): void {
    const size = d.ring.size
    const slot = t % size
    d.ring.save(d.sim, t)
    d.hashes[slot] = d.sim.hash() >>> 0
    if (t > 0 && t % this.tuning.epochTicks === 0) this.epochStep(d, t)
    const bufs = d.inputs.buffers
    const seats = d.inputs.seats
    const decoded = d.decoded
    // Resized only when an epoch boundary changed the seat list.
    while (decoded.length < bufs.length) decoded.push(this.codec.create())
    if (decoded.length > bufs.length) decoded.length = bufs.length
    for (let i = 0; i < bufs.length; i++) {
      const known = bufs[i].get(t)
      const code = known !== undefined ? known : bufs[i].predict(t)
      const s = seats[i] * size + slot
      d.usedCode[s] = code
      d.usedTick[s] = t
      this.codec.decode(code, decoded[i])
    }
    d.sim.step(decoded, d.inputs.view(t))
    this.afterStep(d, t)
    this.farOut(d, t)
  }

  /** Reloads the earliest changed tick of one domain and re-simulates it to its present, view events muted. */
  private rollback(d: DomainState<TInput>): void {
    const rb = d.rollbackTick
    d.rollbackTick = Infinity
    const present = d.sim.tick
    if (!(rb < present)) return
    // Older than the ring: cannot happen within the prediction window; the confirmed hashes would report it.
    if (present - rb > d.ring.size || !d.ring.has(rb)) return
    const sim = d.sim
    const view = sim.view
    if (view && d.smoother) d.smoother.capture(view)
    if (sim.beginResim) sim.beginResim()
    try {
      d.ring.restore(sim, rb)
      for (let t = rb; t < present; t++) this.simulate(d, t)
    } finally {
      if (sim.endResim) sim.endResim()
    }
    if (view && d.smoother) d.smoother.settle(view)
    const depth = present - rb
    this.stats.rollbacks++
    if (depth > this.stats.maxRollback) this.stats.maxRollback = depth
    this.stats.resimTicks += depth
  }

  /** Moves the hash of every newly confirmed tick to the hash ring: all its inputs are known and it ran with them. */
  private confirm(d: DomainState<TInput>): void {
    let c = d.inputs.frontier() + 1
    if (c > d.sim.tick - 1) c = d.sim.tick - 1
    if (c > d.rollbackTick) c = d.rollbackTick
    let t = d.confirmed + 1
    if (t < c - d.ring.size + 1) t = c - d.ring.size + 1
    for (; t <= c; t++) if (d.ring.has(t)) d.ring.recordHash(t, d.hashes[t % d.ring.size])
    if (c > d.confirmed) {
      d.confirmed = c
      this.stats.confirmedTick[d.spec.id] = c
    }
  }

  /**
   * Stores the sampled codes and control words of the local seats at tick + delay. A grown delay fills the gap with
   * this sample; a shrunk one never overwrites a stored tick, as in RollbackSession.
   */
  private storeLocal(tick: number, delay: number): void {
    const seats = this.localSeats
    if (seats.length === 0) return
    for (let i = 0; i < seats.length; i++) this.localCodes[i] = this.codec.encode(this.localIn[i]) >>> 0
    let next = this.controlBufs[seats[0]].lastTick + 1
    if (next < tick) next = tick
    for (let t = next; t <= tick + delay; t++) {
      for (let i = 0; i < seats.length; i++) {
        this.controlBufs[seats[i]].set(t, this.localControls[i])
        this.storeLocalSeat(seats[i], t, this.localCodes[i])
      }
    }
  }

  /** A local code goes to every replicated domain listing the seat: its seat domain and the global domain. */
  private storeLocalSeat(seat: SeatId, t: number, code: number): void {
    for (let i = 0; i < this.list.length; i++) this.storeSeat(this.list[i], seat, t, code)
  }

  /**
   * Stores a seat code in one domain. A simulated tick that used another code schedules the domain's rollback; so does
   * the first unknown tick when the store moved its prediction (a filled gap or a changed last code).
   */
  private storeSeat(d: DomainState<TInput>, seat: SeatId, t: number, code: number): void {
    const i = d.inputs.seats.indexOf(seat)
    if (i < 0) return
    d.inputs.setSeat(seat, t, code)
    this.checkUsed(d, seat, t, code >>> 0)
    const u = d.inputs.buffers[i].lastTick + 1
    this.checkUsed(d, seat, u, d.inputs.buffers[i].predict(u))
  }

  private checkUsed(d: DomainState<TInput>, seat: SeatId, t: number, code: number): void {
    if (t >= d.sim.tick || t >= d.rollbackTick) return
    const s = seat * d.ring.size + (t % d.ring.size)
    if (d.usedTick[s] === t && d.usedCode[s] !== code) d.rollbackTick = t
  }

  // ---- Hooks the next session tasks fill. Networking: the delay from the replicas' RTT; drain and store CONTROL,
  // ZINPUT and SHADOW through storeSeat and the frontier; send them with the piggybacked confirmed hashes; capture the
  // shadowOut and events payloads of each step. Epoch: apply assign() over the confirmed controls of S-L at S = E*K.
  // Recovery: lost peers, ZDROP agreement, hash comparison and cost-class responses. Far: FAR from the producer.
  private updateDelay(_now: number): number {
    return this.delayCtl.current
  }
  private receive(_now: number): void {}
  private send(_now: number): void {}
  private afterStep(_d: DomainState<TInput>, _t: number): void {}
  private epochStep(_d: DomainState<TInput>, _t: number): void {}
  private recover(_now: number): void {}
  private farOut(_d: DomainState<TInput>, _t: number): void {}
}
