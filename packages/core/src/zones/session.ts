// The zone session of one peer: a fixed-tick accumulator over the domains it replicates. Each domain keeps its own
// inputs, frontier, snapshot ring and rollback, so a missing input stalls only the domains that wait for it.
// Tick numbering follows RollbackSession: the snapshot and hash of tick t are those of the state before step t.
import { InputBuffer } from '../inputBuffer.ts'
import { MAX_FRAME_DT } from '../rollback.ts'
import { SnapReader, SnapWriter } from '../snap.ts'
import { CorrectionSmoother } from '../smoothing.ts'
import { DEFAULT_DELAY_HIDDEN_TICKS, DEFAULT_MAX_DELAY, DEFAULT_MAX_PREDICTION, DEFAULT_MIN_DELAY, DEFAULT_TICK_RATE, DelayController, MAX_PEERS } from '../timing.ts'
import type { InputCodec, NetChannel, RollbackTuning } from '../types.ts'
import { MAX_WIRE_PLAYERS, MAX_WIRE_TICKS, SnapshotAssembler } from '../wire.ts'
import type { SnapshotMsg } from '../wire.ts'
import { assign } from './assign.ts'
import { DomainRing } from './domainRing.ts'
import { ControlStore, planEpoch } from './epoch.ts'
import type { DomainTransfer } from './epoch.ts'
import { DomainFrontier } from './frontier.ts'
import { validateZoneTuning } from './tuning.ts'
import type { ZoneTuning } from './tuning.ts'
import type { Assignment, DomainFactory, DomainId, DomainSim, DomainSpec, GroupTransport, Roster, SeatId } from './types.ts'
import { decodeZone, ZMSG, ZoneWireWriter } from './wire.ts'
import type { ZControlMsg, ZDomainSnapshotMsg, ZInputMsg, ZShadowMsg } from './wire.ts'

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
  /** The other replicas: ZINPUT goes to them. */
  readonly peers: number[]
  /** Per peer, the highest contiguous tick of the local seats it acknowledged for this domain, or start - 1. */
  readonly peerAck: Int32Array
  /** First tick this state steps: 0, or the boundary S it was created at. */
  readonly start: number
  /** First tick it no longer steps: Infinity, or the boundary that replaced it (it is then kept for the grace). */
  end: number
  /** How its state at `start` is derived, while that can still change; else null. */
  build: DomainBuild<TInput> | null
}

/** The derivation of a state created at S, run again when a source re-simulates across S. */
export interface DomainBuild<TInput> {
  /** Old domains sharing a seat or cell with it, ascending. */
  readonly sources: DomainId[]
  /** Local old states read live at S, ascending id; empty when the whole domain arrives by DOMAIN_SNAPSHOT. */
  readonly srcs: DomainState<TInput>[]
  /** The only source is the same domain: its snapshot is copied rather than rebuilt. */
  readonly inPlace: boolean
  readonly whole: boolean
  /** DOMAIN_SNAPSHOTs this peer waits for: one whole, or one export per source it lacks. */
  readonly transfers: DomainTransfer[]
  /** Received payloads: the whole snapshot at -1, else each source export by source id. */
  readonly got: Map<number, Uint8Array>
  /** One assembler per sender: ordered reliable parts, fnv-checked. */
  readonly asm: Map<number, SnapshotAssembler>
  /** The derivation must run (again) at the next step of `start`. */
  dirty: boolean
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
  private readonly controls: ControlStore
  /** Codes of each local seat by tick: they seed the domains a boundary creates. */
  private readonly localBufs: InputBuffer[] = []
  /** The first epoch not planned yet, and its boundary: no state steps that tick before the plan. */
  private nextEpoch = 1
  private limit: number
  private prevAssign: Assignment | null = null
  /** Old states kept after a boundary until graceUntil: they step to their end and keep answering. */
  private readonly grace: DomainState<TInput>[] = []
  /** DOMAIN_SNAPSHOTs this peer sends at S, once what they carry is final. */
  private readonly owed: { t: DomainTransfer; x: DomainState<TInput>; whole: boolean }[] = []
  /** Reliable messages for a boundary not planned yet; replayed after the plan. */
  private early: { peer: number; ch: NetChannel; data: Uint8Array }[] = []
  private readonly buildW = new SnapWriter()
  private readonly delayCtl: DelayController
  private readonly writer = new ZoneWireWriter()
  private readonly inbox: { peer: number; ch: NetChannel; data: Uint8Array }[] = []
  /** Roster peer of each seat: only it may send the seat's CONTROL and ZINPUT words. */
  private readonly seatOwner: Int16Array
  private readonly isPeer = new Uint8Array(MAX_PEERS)
  /** Every other roster peer, ascending: CONTROL goes to all of them. */
  private readonly others: number[] = []
  /** Last control tick sent; CONTROL travels reliably, each tick once. */
  private controlSent = -1
  private readonly ctlOut: ZControlMsg = {
    type: ZMSG.CONTROL, from: 0, firstTick: 0, count: 0, seats: 0,
    seatIds: new Uint16Array(MAX_WIRE_PLAYERS), words: new Uint32Array(MAX_WIRE_TICKS * MAX_WIRE_PLAYERS),
  }
  private readonly zinOut: ZInputMsg = {
    type: ZMSG.ZINPUT, from: 0, domain: 0, ackTick: -1, firstTick: 0, count: 0, seats: 0,
    seatIds: new Uint16Array(MAX_WIRE_PLAYERS), codes: new Uint32Array(MAX_WIRE_TICKS * MAX_WIRE_PLAYERS), senderTick: 0, checks: [],
  }
  /** Buffer index in DomainFrontier of each seat in zinOut.seatIds. */
  private readonly zinIdx = new Int32Array(MAX_WIRE_PLAYERS)
  /** Outbound shadow and event links of the domains the local peer produces, by state (an old and a new one can share an id). */
  private readonly shadowOut = new Map<DomainState<TInput>, ShadowOutRing[]>()
  private readonly shadowW = new SnapWriter()
  private readonly shadowPayloads: Uint8Array[] = []

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
    this.seatOwner = new Int16Array(roster.seatCount).fill(-1)
    for (const p of roster.peers) {
      if (!(p.peer >= 0 && p.peer < MAX_PEERS)) throw new Error(`[zones] session: bad roster peer ${p.peer}`)
      this.isPeer[p.peer] = 1
      if (p.peer !== cfg.localPeer) this.others.push(p.peer)
      for (const s of p.seats) if (s >= 0 && s < roster.seatCount) this.seatOwner[s] = p.peer
    }
    this.others.sort((a, b) => a - b)
    this.inputCapacity = cfg.tuning.snapshotRing + cfg.tuning.leadTicks + this.maxPrediction + maxDelay
    const minDelay = cfg.minDelay ?? DEFAULT_MIN_DELAY
    const hiddenTicks = cfg.delayHiddenTicks ?? DEFAULT_DELAY_HIDDEN_TICKS
    this.delayCtl = new DelayController(cfg.initialDelay, { tickRate, minDelay, maxDelay, hiddenTicks })
    const n = this.localSeats.length
    for (let i = 0; i < n; i++) this.localIn.push(cfg.codec.create())
    this.localCodes = new Uint32Array(n)
    this.localControls = new Uint32Array(n)
    this.controls = new ControlStore(roster.seatCount, cfg.tuning)
    // A seat no live peer drives sends no control words; its sample falls back to the latest word or an observer.
    for (let s = 0; s < roster.seatCount; s++) if (this.seatOwner[s] < 0 || !roster.live[this.seatOwner[s]]) this.controls.expect(s, false)
    for (let i = 0; i < n; i++) this.localBufs.push(new InputBuffer(cfg.codec.neutral, this.inputCapacity))
    this.limit = cfg.tuning.epochTicks
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
      for (let i = 0; i < n; i++) {
        const seat = this.localSeats[i]
        this.controls.set(seat, t, cfg.controls[seat])
        this.localBufs[i].set(t, cfg.codec.neutral)
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
    const d = this.stateFor(domain, tick)
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
    // Old states first: one that re-simulates marks what was derived from it at S.
    for (let i = 0; i < this.grace.length; i++) this.rollback(this.grace[i])
    const list = this.list
    for (let i = 0; i < list.length; i++) {
      if (list[i].smoother) list[i].smoother!.decay(dt)
      this.rollback(list[i])
    }
    this.plan()

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
    for (let i = 0; i < this.grace.length; i++) this.advance(this.grace[i])
    for (let i = 0; i < list.length; i++) this.advance(list[i])
    this.send(now)
    this.dropGrace()
    stats.tick = this.tick
    stats.delay = delay
    const a = this.acc / this.fixedDt
    return a > 0 ? (a < 1 ? a : 1) : 0
  }

  /** Adds a domain replicated here in ascending id order, starting at sim.tick: epoch 0, or a boundary. */
  private addDomain(spec: DomainSpec, sim: DomainSim<TInput>, build: DomainBuild<TInput> | null = null): DomainState<TInput> {
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
      peers: spec.replicas.filter((p) => p !== this.cfg.localPeer),
      peerAck: new Int32Array(MAX_PEERS).fill(sim.tick - 1),
      start: sim.tick,
      end: Infinity,
      build,
    }
    let at = this.list.length
    while (at > 0 && this.list[at - 1].spec.id > spec.id) at--
    this.list.splice(at, 0, d)
    this.byId.set(spec.id, d)
    this.stats.confirmedTick[spec.id] = d.confirmed
    this.bindShadowOut(d)
    return d
  }

  /** Maps each local seat to its seat domain; run again whenever the assignment changes. */
  private bindLocal(): void {
    this.localDomain.length = 0
    const prev = this.prevAssign
    const s = this.current.epoch * this.tuning.epochTicks
    for (const seat of this.localSeats) {
      const id = this.current.seatDomain[seat]
      this.localDomain.push(id >= 0 ? (this.byId.get(id) ?? null) : null)
      // Until S the seat still runs in its old seat domain, kept for the grace.
      const pid = prev ? prev.seatDomain[seat] : -1
      for (const g of this.grace) if (g.spec.id === pid && g.end === s) this.localDomain.push(g)
    }
  }

  /** True when a domain holding a local seat cannot step the session tick: the local seats wait. */
  private localStalled(): boolean {
    const doms = this.localDomain
    for (let i = 0; i < doms.length; i++) {
      const d = doms[i]
      if (d && this.tick < d.end && !this.canStep(d, this.tick)) return true
    }
    return false
  }

  /**
   * Whether a state may step tick t: inside its ticks, before the next unplanned boundary, within prediction of its
   * frontier. A pending build steps S once every local source reached S and every payload arrived, then stays within
   * maxPrediction of S, so a re-derive at S is still in the ring.
   */
  private canStep(d: DomainState<TInput>, t: number): boolean {
    if (t >= d.end || t >= this.limit || !d.inputs.canStep(t, this.maxPrediction)) return false
    const b = d.build
    if (b === null) return true
    if (t !== d.start) return t - d.start < this.maxPrediction
    if (b.got.size < b.transfers.length) return false
    for (let i = 0; i < b.srcs.length; i++) if (b.srcs[i].sim.tick < b.srcs[i].end) return false
    return true
  }

  /** Steps one state toward the session tick, releases its build once nothing it read can change, and confirms. */
  private advance(d: DomainState<TInput>): void {
    for (let k = 0; k < this.maxSubsteps && d.sim.tick < this.tick && this.canStep(d, d.sim.tick); k++) this.simulate(d, d.sim.tick)
    const b = d.build
    if (b !== null && !b.dirty && d.sim.tick > d.start && b.got.size >= b.transfers.length) {
      let done = true
      for (let i = 0; i < b.srcs.length; i++) if (!this.final(b.srcs[i])) done = false
      if (done) d.build = null
    }
    this.confirm(d)
  }

  /** An old state at its end, with every input known and nothing left to re-simulate: it no longer changes. */
  private final(x: DomainState<TInput>): boolean {
    return x.sim.tick >= x.end && x.build === null && x.rollbackTick === Infinity && x.inputs.frontier() >= x.end - 1
  }

  /**
   * Runs tick t of one domain: a pending boundary derivation (before the snapshot, so the snapshot of S holds it), the
   * snapshot and hash of t, the known or predicted code of every member seat (recorded as used), then the step.
   */
  private simulate(d: DomainState<TInput>, t: number): void {
    if (t === d.start && d.build !== null && d.build.dirty) this.epochStep(d, t)
    const size = d.ring.size
    const slot = t % size
    d.ring.save(d.sim, t)
    d.hashes[slot] = d.sim.hash() >>> 0
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
    if (d.end !== Infinity) this.invalidate(d)
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
    // Tick S of a new state is not confirmed while its build can still change.
    if (d.build !== null && c > d.start - 1) c = d.start - 1
    let t = d.confirmed + 1
    if (t < c - d.ring.size + 1) t = c - d.ring.size + 1
    for (; t <= c; t++) if (d.ring.has(t)) d.ring.recordHash(t, d.hashes[t % d.ring.size])
    if (c > d.confirmed) {
      d.confirmed = c
      if (d.end === Infinity) this.stats.confirmedTick[d.spec.id] = c
    }
  }

  /** A source re-simulated: whatever was derived from it derives again, by a rollback to S once it stepped S. */
  private invalidate(x: DomainState<TInput>): void {
    const n = this.list.length
    for (let i = 0; i < n + this.grace.length; i++) {
      const d = i < n ? this.list[i] : this.grace[i - n]
      if (d.build === null || d.build.srcs.indexOf(x) < 0) continue
      d.build.dirty = true
      if (d.sim.tick > d.start && d.start < d.rollbackTick) d.rollbackTick = d.start
    }
  }

  /**
   * The boundary of a state created at S, run at its step S and again after a source re-simulated: a whole
   * DOMAIN_SNAPSHOT is restored; a domain kept in place copies its old state; else factory.rebuild merges the exports
   * of every source, ascending id (local ones read live at S, the others received). The result is restored into the
   * running sim, so a rollback in progress keeps its object.
   */
  private epochStep(d: DomainState<TInput>, t: number): void {
    const b = d.build!
    b.dirty = false
    const w = this.buildW
    let bytes = b.got.get(-1)
    if (!bytes && b.inPlace) {
      w.reset()
      b.srcs[0].sim.snapshot(w)
      bytes = w.bytes()
    } else if (!bytes) {
      const readers: SnapReader[] = []
      for (const id of b.sources) {
        const src = b.srcs.find((x) => x.spec.id === id)
        const got = b.got.get(id)
        if (src) {
          const ew = new SnapWriter()
          src.sim.exportEntities(ew)
          readers.push(new SnapReader(ew.bytes()))
        } else if (got) {
          readers.push(new SnapReader(got))
        }
      }
      w.reset()
      this.cfg.factory.rebuild(d.spec, t, readers).snapshot(w)
      bytes = w.bytes()
    }
    d.sim.restore(new SnapReader(bytes))
    d.sim.tick = t
    this.captureShadows(d, t)
  }

  /**
   * Stores the sampled codes and control words of the local seats at tick + delay. A grown delay fills the gap with
   * this sample; a shrunk one never overwrites a stored tick, as in RollbackSession.
   */
  private storeLocal(tick: number, delay: number): void {
    const seats = this.localSeats
    if (seats.length === 0) return
    for (let i = 0; i < seats.length; i++) this.localCodes[i] = this.codec.encode(this.localIn[i]) >>> 0
    let next = this.localBufs[0].lastTick + 1
    if (next < tick) next = tick
    for (let t = next; t <= tick + delay; t++) {
      for (let i = 0; i < seats.length; i++) {
        this.controls.set(seats[i], t, this.localControls[i])
        this.localBufs[i].set(t, this.localCodes[i])
        this.storeLocalSeat(seats[i], t, this.localCodes[i])
      }
    }
  }

  /** A local code goes to every state listing the seat that holds tick t: its seat domain and the global domain. */
  private storeLocalSeat(seat: SeatId, t: number, code: number): void {
    for (let i = 0; i < this.list.length; i++) if (t >= this.list[i].start) this.storeSeat(this.list[i], seat, t, code)
    for (let i = 0; i < this.grace.length; i++) if (t < this.grace[i].end) this.storeSeat(this.grace[i], seat, t, code)
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

  // ---- Networking. ZINPUT goes on the fast channel with a redundant unacked window, as in RollbackSession. CONTROL
  // and SHADOW have no ack field, so they go reliably and in order, each tick once; in-order shadow ticks also keep
  // ShadowInput's prediction equal to the payload a step used, so a changed payload always schedules the rollback.

  /** Drains the transport and routes each message to what it names; messages for unreplicated domains are dropped. */
  private receive(_now: number): void {
    this.net.drain(this.inbox)
    this.dispatch(this.inbox)
  }

  private dispatch(inbox: { peer: number; ch: NetChannel; data: Uint8Array }[]): void {
    for (let i = 0; i < inbox.length; i++) {
      const e = inbox[i]
      const m = decodeZone(e.data)
      const from = e.peer
      if (!m || m.from !== from || from === this.cfg.localPeer || this.isPeer[from] !== 1) {
        this.stats.malformed++
        continue
      }
      // SHADOW and DOMAIN_SNAPSHOT arrive once: one reaching past a boundary not planned here yet waits for the plan.
      if ((m.type === ZMSG.SHADOW && m.firstTick + m.count > this.limit) || (m.type === ZMSG.DOMAIN_SNAPSHOT && m.tick >= this.limit)) {
        this.early.push({ peer: from, ch: e.ch, data: e.data.slice() })
        continue
      }
      switch (m.type) {
        case ZMSG.CONTROL:
          this.onControl(m)
          break
        case ZMSG.ZINPUT:
          this.onInput(m)
          break
        case ZMSG.SHADOW:
          this.onShadow(m)
          break
        case ZMSG.DOMAIN_SNAPSHOT:
          this.onSnapshot(m)
          break
        default:
          break
      }
    }
  }

  /** True when every listed seat belongs to the sender. */
  private owns(from: number, seatIds: Uint16Array, n: number): boolean {
    for (let j = 0; j < n; j++) if (this.seatOwner[seatIds[j]] !== from) return false
    return true
  }

  private onControl(m: ZControlMsg): void {
    const n = m.seats
    if (m.firstTick < 0 || !this.owns(m.from, m.seatIds, n)) {
      this.stats.malformed++
      return
    }
    for (let t = 0; t < m.count; t++) {
      for (let j = 0; j < n; j++) this.controls.set(m.seatIds[j], m.firstTick + t, m.words[t * n + j])
    }
  }

  /** The state of a domain id that holds tick t: the current one from its start, else an old one kept for the grace. */
  private stateFor(id: DomainId, t: number): DomainState<TInput> | undefined {
    const d = this.byId.get(id)
    if (d && t >= d.start) return d
    for (let i = 0; i < this.grace.length; i++) {
      const g = this.grace[i]
      if (g.spec.id === id && t >= g.start && t < g.end) return g
    }
    return undefined
  }

  private onInput(m: ZInputMsg): void {
    const n = m.seats
    if (m.firstTick < 0 || !this.owns(m.from, m.seatIds, n)) {
      this.stats.malformed++
      return
    }
    // A window past a boundary not planned here comes from a state not built yet; it is sent again until acked.
    const d = m.firstTick < this.limit ? this.stateFor(m.domain, m.firstTick) : undefined
    if (!d) return
    if (m.ackTick > d.peerAck[m.from]) d.peerAck[m.from] = m.ackTick
    // storeSeat schedules the domain's rollback from the earliest tick that ran with another code.
    for (let t = 0; t < m.count; t++) {
      for (let j = 0; j < n; j++) this.storeSeat(d, m.seatIds[j], m.firstTick + t, m.codes[t * n + j])
    }
  }

  private onShadow(m: ZShadowMsg): void {
    if (m.firstTick < 0) {
      this.stats.malformed++
      return
    }
    for (let i = 0; i < m.count; i++) {
      const d = this.stateFor(m.toDomain, m.firstTick + i)
      if (d) this.storeShadow(d, m.fromDomain, m.firstTick + i, m.payloads[i])
    }
  }

  /** Reassembles a DOMAIN_SNAPSHOT for a state waiting at S; a source export starts with its u16 source id. */
  private onSnapshot(m: ZDomainSnapshotMsg): void {
    const n = this.byId.get(m.domain)
    if (!n || n.build === null || n.start !== m.tick) return
    const b = n.build
    const asm = b.asm.get(m.from)
    // push() reads only the part fields, which the zone message shares with SnapshotMsg.
    const done = asm ? asm.push(m as unknown as SnapshotMsg) : null
    if (!done) return
    if (b.whole) {
      b.got.set(-1, done.bytes)
      return
    }
    const src = done.bytes.length >= 2 ? done.bytes[0] | (done.bytes[1] << 8) : -1
    let ok = false
    for (const t of b.transfers) if (t.source === src && t.sender === m.from) ok = true
    if (ok) b.got.set(src, done.bytes.subarray(2))
    else this.stats.malformed++
  }

  private storeShadow(d: DomainState<TInput>, from: DomainId, t: number, data: Uint8Array): void {
    const r = d.inputs.setShadow(from, t, data)
    if (r < d.sim.tick && r < d.rollbackTick) d.rollbackTick = r
  }

  private send(_now: number): void {
    this.sendControl()
    const n = this.list.length
    for (let i = 0; i < n + this.grace.length; i++) {
      const d = i < n ? this.list[i] : this.grace[i - n]
      this.sendInputs(d)
      const links = this.shadowOut.get(d)
      if (links) for (let k = 0; k < links.length; k++) this.sendShadow(d, links[k])
    }
    this.sendOwed()
  }

  /**
   * The DOMAIN_SNAPSHOTs of S, in SNAPSHOT_CHUNK parts on the reliable channel: a whole domain once its build is
   * released (its snapshot of S is final), a source export (u16 source id first) once that old source is final.
   */
  private sendOwed(): void {
    for (let i = this.owed.length - 1; i >= 0; i--) {
      const { t, x, whole } = this.owed[i]
      if (whole ? x.build !== null || x.sim.tick <= x.start : !this.final(x)) continue
      this.owed.splice(i, 1)
      let bytes: Uint8Array | null
      if (whole) {
        bytes = x.ring.bytesAt(x.start)
      } else {
        const w = this.buildW
        w.reset()
        w.u16(t.source)
        x.sim.exportEntities(w)
        bytes = w.bytes()
      }
      if (!bytes) continue
      const parts = this.writer.domainSnapshotParts(this.cfg.localPeer, t.domain, whole ? x.start : x.end, bytes)
      for (let k = 0; k < parts.length; k++) this.fanOut(t.targets, 'reliable', parts[k])
    }
  }

  /** One send per message: sendMany when the transport has it, else a send per peer. */
  private fanOut(peers: readonly number[], ch: NetChannel, data: Uint8Array): void {
    const net = this.net
    if (net.sendMany) {
      if (peers.length > 0) net.sendMany(peers, ch, data)
      return
    }
    for (let i = 0; i < peers.length; i++) net.send(peers[i], ch, data)
  }

  /** The local seats' control words of every tick stored since the last send, to every other peer. */
  private sendControl(): void {
    const seats = this.localSeats
    const ns = seats.length < MAX_WIRE_PLAYERS ? seats.length : MAX_WIRE_PLAYERS
    if (ns === 0 || this.others.length === 0) return
    const last = this.localBufs[0].lastTick
    const m = this.ctlOut
    m.from = this.cfg.localPeer
    m.seats = ns
    for (let j = 0; j < ns; j++) m.seatIds[j] = seats[j]
    while (this.controlSent < last) {
      const first = this.controlSent + 1
      let count = last - first + 1
      if (count > MAX_WIRE_TICKS) count = MAX_WIRE_TICKS
      for (let t = 0; t < count; t++) {
        for (let j = 0; j < ns; j++) m.words[t * ns + j] = this.controls.get(seats[j], first + t) >>> 0
      }
      m.firstTick = first
      m.count = count
      this.fanOut(this.others, 'reliable', this.writer.control(m))
      this.controlSent = first + count - 1
    }
  }

  /**
   * One ZINPUT per domain for all its other replicas, so it suits sendMany: the window starts after the lowest ack
   * among them, and ackTick is the lowest contiguous tick held of the other seats, a safe ack for each sender. A
   * replica with no local seat in the domain still sends it, with no seats, for its ack (the recovery task adds checks).
   */
  private sendInputs(d: DomainState<TInput>): void {
    const peers = d.peers
    if (peers.length === 0) return
    const m = this.zinOut
    const seats = d.inputs.seats
    const bufs = d.inputs.buffers
    const local = this.cfg.localPeer
    let nk = 0
    let ack = Infinity
    for (let i = 0; i < seats.length; i++) {
      if (this.seatOwner[seats[i]] !== local) {
        if (bufs[i].lastTick < ack) ack = bufs[i].lastTick
      } else if (nk < MAX_WIRE_PLAYERS) {
        m.seatIds[nk] = seats[i]
        this.zinIdx[nk++] = i
      }
    }
    let localLast = nk > 0 ? bufs[this.zinIdx[0]].lastTick : d.sim.tick
    // A state answers for its own ticks only, never past an unplanned boundary, so receivers route by firstTick.
    const end = d.end < this.limit ? d.end : this.limit
    if (localLast > end - 1) localLast = end - 1
    if (localLast < d.start) return
    let first = Infinity
    for (let i = 0; i < peers.length; i++) if (d.peerAck[peers[i]] + 1 < first) first = d.peerAck[peers[i]] + 1
    if (first > localLast) first = localLast
    if (first <= localLast - this.inputCapacity) first = localLast - MAX_WIRE_TICKS + 1
    if (first < d.start) first = d.start
    let count = localLast - first + 1
    if (count > MAX_WIRE_TICKS) count = MAX_WIRE_TICKS
    for (let t = 0; t < count; t++) {
      for (let j = 0; j < nk; j++) {
        const c = bufs[this.zinIdx[j]].get(first + t)
        m.codes[t * nk + j] = c !== undefined ? c : this.codec.neutral >>> 0
      }
    }
    m.from = local
    m.domain = d.spec.id
    m.ackTick = ack === Infinity ? -1 : ack
    m.firstTick = first
    m.count = count
    m.seats = nk
    m.senderTick = this.tick
    this.fanOut(peers, 'fast', this.writer.zinput(m))
  }

  /**
   * The confirmed payloads of one outbound link not sent yet: a payload of tick t is final once t is confirmed. The
   * local replica of the target, if any, takes them directly, since the peers list excludes the local peer.
   */
  private sendShadow(d: DomainState<TInput>, link: ShadowOutRing): void {
    const last = d.confirmed
    const out = this.shadowPayloads
    while (link.sent < last) {
      const first = link.sent + 1
      let count = last - first + 1
      if (count > MAX_WIRE_TICKS) count = MAX_WIRE_TICKS
      out.length = count
      for (let i = 0; i < count; i++) {
        out[i] = link.payload(first + i)
        const target = this.stateFor(link.to, first + i)
        if (target) this.storeShadow(target, d.spec.id, first + i, out[i])
      }
      const data = this.writer.shadow(this.cfg.localPeer, d.spec.id, link.to, first, out)
      if (!data) throw new Error(`[zones] session: a shadow payload of domain ${d.spec.id} exceeds 65535 bytes`)
      this.fanOut(link.peers, 'reliable', data)
      link.sent = first + count - 1
    }
  }

  /**
   * The producer of a domain sends its shadowOut over each explicit link and its events to the global domain. The
   * payload of tick t is written from the state before step t, like the snapshot and hash of t, so two linked domains
   * never wait on each other's same tick. The epoch task calls this again when links or producers change.
   */
  private bindShadowOut(d: DomainState<TInput>): void {
    this.shadowOut.delete(d)
    if (!d.producer) return
    const local = this.cfg.localPeer
    const domains = this.current.domains
    const links: ShadowOutRing[] = []
    for (const l of this.current.shadows) {
      if (l.from !== d.spec.id) continue
      const to = domains.find((s) => s.id === l.to)
      if (to) links.push(new ShadowOutRing(l.to, false, to.replicas.filter((p) => p !== local), this.inputCapacity, d.sim.tick - 1))
    }
    const global = domains.find((s) => s.kind === 'global')
    if (global && global.id !== d.spec.id) {
      links.push(new ShadowOutRing(global.id, true, global.replicas.filter((p) => p !== local), this.inputCapacity, d.sim.tick - 1))
    }
    if (links.length === 0) return
    this.shadowOut.set(d, links)
    this.captureShadows(d, d.sim.tick)
  }

  /** Writes the outbound payloads of tick `tick` from the domain's current state; a resimulation rewrites them. */
  private captureShadows(d: DomainState<TInput>, tick: number): void {
    const links = this.shadowOut.get(d)
    if (!links) return
    const w = this.shadowW
    for (let i = 0; i < links.length; i++) {
      w.reset()
      if (links[i].events) d.sim.events(w)
      else d.sim.shadowOut(w, links[i].to)
      links[i].store(tick, w)
    }
  }

  private afterStep(d: DomainState<TInput>, t: number): void {
    this.captureShadows(d, t + 1)
  }

  // ---- Epoch boundary S = E*K. Once the control sample of S-L is confirmed, assign() and planEpoch decide the
  // domains of epoch E. A domain continues (same state) only when nothing it depends on changes; every other local
  // domain of E is a new state starting at S, whose build epochStep runs at its step S; the old states become grace.

  /** Plans the next boundary when its control sample is confirmed; until then no state steps it. */
  private plan(): void {
    const E = this.nextEpoch
    if (!this.controls.ready(E)) return
    const prev = this.current
    const next = assign(this.cfg.roster, this.controls.sample(E), prev, this.tuning)
    const local = this.cfg.localPeer
    const plan = planEpoch(prev, next, local, this.tuning)
    const S = plan.tick
    const cont = continuedSet(prev, next)
    const old = new Map(this.byId)
    let k = 0
    for (const d of this.list) {
      if (cont.has(d.spec.id)) {
        this.list[k++] = d
        continue
      }
      this.byId.delete(d.spec.id)
      d.end = S
      d.replica = false
      d.graceUntil = plan.dropTick
      this.grace.push(d)
    }
    this.list.length = k
    this.prevAssign = prev
    this.current = next
    const prevById = new Map(prev.domains.map((s) => [s.id, s]))
    for (const spec of next.domains) {
      if (spec.replicas.indexOf(local) < 0) continue
      if (cont.has(spec.id)) {
        this.byId.get(spec.id)!.spec = spec
        continue
      }
      const r = plan.rebuild.find((x) => x.domain === spec.id)
      const rc = plan.receive.find((x) => x.domain === spec.id)
      let build: DomainBuild<TInput> | null = null
      // Neither rebuilt, received nor created: unchanged in planEpoch but not continued here, so copied in place.
      if (r || rc || plan.create.indexOf(spec.id) < 0) {
        const sources = r ? r.sources : rc ? rc.sources : [spec.id]
        const transfers = rc ? rc.transfers : []
        // epoch.ts marks a whole transfer by source === domain, which a source export can match too: whole means
        // some new replica held every source.
        const whole = rc !== undefined && spec.replicas.some((p) => sources.every((s) => prevById.get(s)!.replicas.includes(p)))
        const srcs: DomainState<TInput>[] = []
        if (!whole) for (const s of sources) if (old.has(s)) srcs.push(old.get(s)!)
        build = { sources, srcs, inPlace: r ? r.inPlace : !rc, whole, transfers, got: new Map(), asm: new Map(), dirty: true }
        for (const t of transfers) if (!build.asm.has(t.sender)) build.asm.set(t.sender, new SnapshotAssembler())
      }
      this.seed(this.addDomain(spec, this.cfg.factory.create(spec, S), build), old)
    }
    for (const t of plan.send) {
      // A whole sender rebuilds the domain itself; a source sender sends the export of its old state.
      const whole = plan.rebuild.some((x) => x.domain === t.domain)
      const x = whole ? this.byId.get(t.domain) : old.get(t.source)
      if (x) this.owed.push({ t, x, whole })
    }
    this.nextEpoch = E + 1
    this.limit = this.nextEpoch * this.tuning.epochTicks
    this.bindLocal()
    const early = this.early
    this.early = []
    this.dispatch(early)
  }

  /**
   * Inputs of a state created at S: each seat buffer starts at S-1 with the best prediction held and takes every code
   * known from S on (local seats from localBufs, the others from the old state that knows most); shadows start at S-1.
   */
  private seed(n: DomainState<TInput>, old: Map<DomainId, DomainState<TInput>>): void {
    const S = n.start
    const seats = n.inputs.seats
    for (let i = 0; i < seats.length; i++) {
      const li = this.localSeats.indexOf(seats[i])
      let from: InputBuffer | null = li >= 0 ? this.localBufs[li] : null
      if (from === null) {
        for (const d of old.values()) {
          const j = d.inputs.seats.indexOf(seats[i])
          if (j >= 0 && (from === null || d.inputs.buffers[j].lastTick > from.lastTick)) from = d.inputs.buffers[j]
        }
      }
      const buf = n.inputs.buffers[i]
      buf.lastTick = S - 2
      buf.set(S - 1, from ? from.predict(S - 1) : this.codec.neutral)
      for (let t = S; from && t < S + this.inputCapacity; t++) {
        const c = from.get(t)
        if (c !== undefined) buf.set(t, c)
      }
    }
    for (const sh of n.inputs.shadows) sh.lastTick = S - 1
  }

  /** Drops the old states whose grace ended, once final and nothing derives from or still sends them. */
  private dropGrace(): void {
    for (let i = this.grace.length - 1; i >= 0; i--) {
      const x = this.grace[i]
      if (this.tick < x.graceUntil || !this.final(x) || this.held(x)) continue
      this.grace.splice(i, 1)
      this.shadowOut.delete(x)
      if (!this.byId.has(x.spec.id)) delete this.stats.confirmedTick[x.spec.id]
    }
  }

  private held(x: DomainState<TInput>): boolean {
    for (let i = 0; i < this.owed.length; i++) if (this.owed[i].x === x) return true
    const n = this.list.length
    for (let i = 0; i < n + this.grace.length; i++) {
      const d = i < n ? this.list[i] : this.grace[i - n]
      if (d.build !== null && d.build.srcs.indexOf(x) >= 0) return true
    }
    return false
  }

  // ---- Hooks the next session tasks fill. Networking: the delay from the replicas' RTT and the piggybacked
  // confirmed hashes. Recovery: lost peers, ZDROP agreement, hash comparison and cost-class responses. Far: FAR from
  // the producer.
  private updateDelay(_now: number): number {
    return this.delayCtl.current
  }
  private recover(_now: number): void {}
  private farOut(_d: DomainState<TInput>, _t: number): void {}
}

/**
 * Domain ids whose state runs on across a boundary: same seats, cells, ordered replicas and links, and not a source
 * of a new domain (a source is read at S, so it cannot step past S). Global, so every replica decides alike.
 */
function continuedSet(prev: Assignment, next: Assignment): Set<DomainId> {
  const out = new Set<DomainId>()
  for (const s of next.domains) if (prev.domains.some((o) => o.id === s.id) && wiring(prev, s.id) === wiring(next, s.id)) out.add(s.id)
  for (let changed = true; changed;) {
    changed = false
    for (const s of next.domains) {
      if (out.has(s.id) || s.kind === 'global') continue
      for (const o of prev.domains) {
        if (o.kind === 'global' || !out.has(o.id)) continue
        if (s.seats.some((x) => o.seats.includes(x)) || s.cells.some((c) => o.cells.includes(c))) {
          out.delete(o.id)
          changed = true
        }
      }
    }
  }
  return out
}

/** What a domain's state and messages depend on: seats, cells, replicas, inbound sources, links out and the global. */
function wiring(a: Assignment, id: DomainId): string {
  const s = a.domains.find((x) => x.id === id)!
  const out = a.shadows.filter((l) => l.from === id).map((l) => [l.to, a.domains.find((x) => x.id === l.to)?.replicas])
  const g = a.domains.find((x) => x.kind === 'global')
  return JSON.stringify([s.seats, s.cells, s.replicas, DomainFrontier.inbound(s, a.shadows, a.domains), out, g ? [g.id, g.replicas] : null])
}

const EMPTY_BYTES = new Uint8Array(0)

/** The payloads one produced domain sends over one link, by tick. Slots only grow and their views are cached. */
class ShadowOutRing {
  readonly to: DomainId
  /** True for the implicit link to the global domain, which carries sim.events. */
  readonly events: boolean
  readonly peers: number[]
  /** Last tick sent. */
  sent: number
  private readonly bufs: Uint8Array[] = []
  private readonly lens: Int32Array
  private readonly ticks: Int32Array
  /** Views per slot and length, dropped when the slot grows: no allocation once lengths repeat. */
  private readonly views: (Uint8Array | undefined)[][] = []

  constructor(to: DomainId, events: boolean, peers: number[], capacity: number, sent: number) {
    this.to = to
    this.events = events
    this.peers = peers
    this.sent = sent
    for (let i = 0; i < capacity; i++) {
      this.bufs.push(EMPTY_BYTES)
      this.views.push([])
    }
    this.lens = new Int32Array(capacity)
    this.ticks = new Int32Array(capacity).fill(-1)
  }

  store(tick: number, w: SnapWriter): void {
    const s = tick % this.ticks.length
    const n = w.length
    if (this.bufs[s].length < n) {
      this.bufs[s] = new Uint8Array(n > 2 * this.bufs[s].length ? n : 2 * this.bufs[s].length)
      this.views[s].length = 0
    }
    const src = writerBuf(w)
    const dst = this.bufs[s]
    for (let i = 0; i < n; i++) dst[i] = src[i]
    this.lens[s] = n
    this.ticks[s] = tick
  }

  /** The payload of a tick, or an empty one when it is no longer held. */
  payload(tick: number): Uint8Array {
    const s = tick % this.ticks.length
    if (this.ticks[s] !== tick) return EMPTY_BYTES
    const n = this.lens[s]
    let v = this.views[s][n]
    if (!v) {
      v = this.bufs[s].subarray(0, n)
      this.views[s][n] = v
    }
    return v
  }
}

// snap.ts is legacy core and bytes() allocates a view; read its buffer directly, as frontier.ts does for SnapReader.
function writerBuf(w: SnapWriter): Uint8Array {
  return (w as unknown as { buf: Uint8Array }).buf
}
