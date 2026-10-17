// Rollback netcode core: the rollback session. Pure, no DOM, no Node APIs, no clock besides NetTransport.now().
// Tick numbering: tick t is the step that runs with sim.tick === t. The snapshot of tick t is the state saved just
// before that step, and the hash of tick t is the hash of that state (sim.hash(), or fnv1a32 of the snapshot).
import { SnapReader, SnapWriter, fnv1a32 } from './snap.ts'
import { bytesToBase64, chooseAuthority } from './desync.ts'
import type { DesyncDump } from './desync.ts'
import { InputBuffer } from './inputBuffer.ts'
import { CorrectionSmoother } from './smoothing.ts'
import {
  DEFAULT_DELAY_HIDDEN_TICKS,
  DEFAULT_DROP_WAIT_MS,
  DEFAULT_LOST_AFTER_MS,
  DEFAULT_MAX_DELAY,
  DEFAULT_MAX_PREDICTION,
  DEFAULT_MIN_DELAY,
  DEFAULT_SNAPSHOT_RING,
  DEFAULT_TICK_RATE,
  DelayController,
  MAX_PEERS,
  RttEstimator,
  TimeSync,
} from './timing.ts'
import type { DelayParams } from './timing.ts'
import { MAX_WIRE_PLAYERS, MAX_WIRE_TICKS, MSG, SnapshotAssembler, WireWriter, decode } from './wire.ts'
import type { DesyncMsg, DropMsg, InputMsg, InputWireMsg, SnapshotMsg } from './wire.ts'
import type { InputCodec, NetChannel, NetTransport, RollbackConfig, Simulation } from './types.ts'

export interface NetStats {
  tick: number
  confirmedTick: number
  delay: number
  rtt: Record<number, number>
  rollbacks: number
  maxRollback: number
  resimTicks: number
  stallFrames: number
  frames: number
  desyncs: number
  malformed: number
  lostPeers: number[]
  lastFrameSimMs: number
}

/** PING period per live peer (ms). */
export const PING_INTERVAL_MS = 250
/** Ticks of used codes kept per player (at least snapshotRing and dumpTicks). */
export const USED_RING = 256
/** A resync snapshot older than this many ticks is not loaded (its inputs may have left the buffers). */
export const RESYNC_MAX_TICKS = 240
/** A peer that lost a desync episode and never sends a matching hash is trusted again after this many ticks. */
export const RESYNC_TIMEOUT_TICKS = 600
/** Confirmed hashes kept, locally and per remote peer. */
export const HASH_RING = 128
/** Each confirmed checksum is sent in this many INPUT packets per peer. */
export const CHECK_REPEATS = 3
/** Checksums carried by one INPUT at most. */
export const MAX_CHECKS_PER_INPUT = 32
/** Longest frame interval accumulated (s). */
export const MAX_FRAME_DT = 0.1

/** dropLast value of a DROP not received yet. */
const DROP_UNKNOWN = -2

type DrainEntry = { peer: number; ch: NetChannel; data: Uint8Array }

/**
 * The rollback session of one peer: input delay, prediction, a snapshot ring, rollback and re-simulation, stalls,
 * time sync and checksum exchange. Every player listed in cfg.peers is driven by the session; players owned by
 * nobody get the codec's neutral input.
 *
 * Tick numbering: tick t is the step that runs with sim.tick === t. The snapshot of tick t is the state saved just
 * before that step, and the hash of tick t is the hash of that state.
 */
export class RollbackSession<TInput> {
  readonly stats: NetStats
  /** Null when the simulation has no `view`. */
  readonly smoother: CorrectionSmoother | null
  onDesync: ((d: DesyncDump) => void) | null = null
  onPeerLost: ((peer: number, switchTick: number) => void) | null = null

  private sim: Simulation<TInput> | null
  private net: NetTransport | null
  private readonly codec: InputCodec<TInput>
  private readonly dumpInfo: (() => unknown) | null
  private readonly cpuMs: () => number
  private readonly localPeer: number
  private readonly nPlayers: number
  // ---- tuning
  private readonly fixedDt: number
  private readonly maxSubsteps: number
  private readonly maxPrediction: number
  private readonly ringSize: number
  private readonly dumpTicks: number
  private readonly lostAfterMs: number
  private readonly dropWaitMs: number
  private disposed = false
  private isStalled = false
  private acc = 0

  // ---- players and peers
  /** One InputBuffer per net player (listed in cfg.peers and human), null otherwise. */
  private buffers: (InputBuffer | null)[]
  /** Every net player, ascending. */
  private readonly netPlayers: number[] = []
  /** The local peer's players, by localSlot. */
  private readonly localPlayers: number[]
  /** The remote net players, ascending. */
  private readonly remotePlayers: number[] = []
  /** Remote peer ids, ascending. */
  private readonly remotes: number[] = []
  /** Players of each peer id by localSlot (index = peer id); null for peers not in the config. */
  private readonly peerPlayers: (number[] | null)[] = []
  /** Player k's inputs are no longer awaited (set by the disconnect procedure). */
  private readonly dropped: Uint8Array
  /** Tick at whose start player k becomes AI, or -1. */
  private readonly switchAt: Int32Array
  /** The decoded input of every player, handed to sim.step(). */
  private netInputs: TInput[]

  // ---- local input
  private readonly delayCtl: DelayController
  private readonly localIn: TInput[] = []
  private readonly localCodes: Uint32Array

  // ---- snapshots and used codes
  private ring: SnapWriter[] = []
  private readonly ringTick: Int32Array
  /** sim.hash() of each ring slot, when the simulation provides one. */
  private readonly ringHash: Uint32Array
  private readonly useSimHash: boolean
  private readonly usedCode: Uint32Array
  private readonly usedTick: Int32Array
  /** Earliest simulated tick whose known input differs from the used one; Infinity when none. */
  private rollbackTick = Infinity

  // ---- peers: liveness, acks, rtt, time sync
  private readonly live: Uint8Array
  private readonly byeFrom: Uint8Array
  private readonly lastRecvMs: Float64Array
  /** Highest contiguous tick of the local inputs each peer holds (from its packets). */
  private readonly peerAck: Int32Array
  private readonly rttEst: RttEstimator[] = []
  private readonly timeSync: TimeSync
  private lastPingMs = -Infinity
  private pingId = 0

  // ---- checksums
  private confirmed = -1
  private readonly hashTick: Int32Array
  private readonly hashVal: Uint32Array
  /** Sends of each local hash slot per peer (peer * HASH_RING + slot). */
  private readonly hashSent: Uint8Array
  private readonly rHashTick: Int32Array
  private readonly rHashVal: Uint32Array
  private firstDesync = -1

  // ---- desync episodes
  /** Earliest mismatching tick seen outside an episode (Infinity when none), and the local hash there. */
  private mismatchTick = Infinity
  private mismatchLocal = 0
  private epActive = false
  private epTick = -1
  private epLocal = 0
  private epDecided = false
  private epAuthority = -1
  private epLosers: number[] = []
  /** Hash of each peer at epTick, known when epKnown[peer] is 1. */
  private readonly epHash = new Uint32Array(MAX_PEERS)
  private readonly epKnown = new Uint8Array(MAX_PEERS)
  /** Peers that lost an episode and have not sent a matching hash since: their mismatches are ignored. */
  private readonly resyncing = new Uint8Array(MAX_PEERS)
  /** Local tick at which resyncing[p] expires. */
  private readonly resyncUntil = new Int32Array(MAX_PEERS)
  /** The episode tick at which peer p was marked resyncing: a DESYNC of p for a later tick is a new episode. */
  private readonly resyncMark = new Int32Array(MAX_PEERS)
  /** Mismatches from peer p at ticks below trustFrom[p] are stale (sent before its resync) and ignored. */
  private readonly trustFrom = new Int32Array(MAX_PEERS)
  /** Rollbacks never reload below this tick (the last resync tick: older snapshots are gone). */
  private floorTick = 0
  /** Checksums below this tick are not sent (the pre-resync hashes of those ticks went out already). */
  private checkFloor = 0
  /** A complete authority snapshot waiting to be loaded. */
  private pendingSnap: { from: number; tick: number; hash: number; bytes: Uint8Array } | null = null
  private lastAuthority = -1
  private resyncCount = 0

  // ---- disconnect agreement (index = lost peer id)
  /** 0 = not lost, 1 = lost and agreeing on the switch tick, 2 = switch tick agreed. */
  private readonly lostState = new Uint8Array(MAX_PEERS)
  /** The lastTick this peer announced in its DROP for each lost peer. */
  private readonly dropOwn = new Int32Array(MAX_PEERS)
  /** lastTick of the DROP of sender q about lost peer L at L * MAX_PEERS + q; DROP_UNKNOWN when not received. */
  private readonly dropLast = new Int32Array(MAX_PEERS * MAX_PEERS).fill(DROP_UNKNOWN)
  /** Local time at which the agreement on each lost peer started or last restarted. */
  private readonly dropStart = new Float64Array(MAX_PEERS)
  /** The agreed switch tick S of each lost peer, or -1. */
  private readonly switchTickOf = new Int32Array(MAX_PEERS).fill(-1)
  private readonly dropSendCodes = new Uint32Array(MAX_WIRE_TICKS * MAX_WIRE_PLAYERS)

  // ---- wire
  private readonly writer = new WireWriter()
  private readonly assembler = new SnapshotAssembler()
  private readonly inbox: DrainEntry[] = []
  private readonly sendCodes = new Uint32Array(MAX_WIRE_TICKS * MAX_WIRE_PLAYERS)
  private readonly checkPool: { tick: number; hash: number }[] = []
  private readonly out: InputMsg

  constructor(sim: Simulation<TInput>, cfg: RollbackConfig<TInput>, net: NetTransport) {
    this.sim = sim
    this.net = net
    this.codec = cfg.codec
    this.dumpInfo = cfg.dumpInfo ?? null
    this.cpuMs = cfg.cpuMs ?? (() => 0)
    this.localPeer = cfg.localPeer
    const tickRate = cfg.tickRate ?? DEFAULT_TICK_RATE
    if (!(tickRate > 0 && tickRate < Infinity)) throw new Error('[rollback] bad tickRate')
    this.fixedDt = 1 / tickRate
    this.maxSubsteps = cfg.maxSubsteps ?? 8
    this.maxPrediction = cfg.maxPrediction ?? DEFAULT_MAX_PREDICTION
    this.ringSize = cfg.snapshotRing ?? DEFAULT_SNAPSHOT_RING
    if (!(this.ringSize > this.maxPrediction && this.ringSize <= USED_RING)) throw new Error('[rollback] snapshotRing must be in (maxPrediction, 256]')
    this.dumpTicks = Math.min(cfg.dumpTicks ?? 240, USED_RING)
    this.lostAfterMs = cfg.lostAfterMs ?? DEFAULT_LOST_AFTER_MS
    this.dropWaitMs = cfg.dropWaitMs ?? DEFAULT_DROP_WAIT_MS
    const n = cfg.playerCount
    if (!(Number.isInteger(n) && n >= 1 && n <= 255)) throw new Error('[rollback] bad playerCount')
    this.nPlayers = n
    const delayParams: DelayParams = {
      tickRate,
      minDelay: cfg.minDelay ?? DEFAULT_MIN_DELAY,
      maxDelay: cfg.maxDelay ?? DEFAULT_MAX_DELAY,
      hiddenTicks: cfg.delayHiddenTicks ?? DEFAULT_DELAY_HIDDEN_TICKS,
    }
    this.timeSync = new TimeSync(tickRate)
    const view = sim.view
    this.smoother = view ? new CorrectionSmoother(view.entities, view.stride) : null
    const neutral = cfg.codec.neutral >>> 0

    // Player ownership from the config.
    this.buffers = []
    for (let k = 0; k < n; k++) this.buffers.push(null)
    for (let p = 0; p < MAX_PEERS; p++) this.peerPlayers.push(null)
    let local: number[] | null = null
    for (let i = 0; i < cfg.peers.length; i++) {
      const pc = cfg.peers[i]
      if (!(Number.isInteger(pc.peer) && pc.peer >= 0 && pc.peer < MAX_PEERS)) throw new Error(`[rollback] bad peer id ${pc.peer}`)
      if (this.peerPlayers[pc.peer]) throw new Error(`[rollback] duplicate peer ${pc.peer}`)
      if (pc.players.length > MAX_WIRE_PLAYERS) throw new Error(`[rollback] peer ${pc.peer} has too many players`)
      const players: number[] = []
      for (let j = 0; j < pc.players.length; j++) {
        const k = pc.players[j]
        if (!(Number.isInteger(k) && k >= 0 && k < n)) throw new Error(`[rollback] peer ${pc.peer}: bad player ${k}`)
        if (this.buffers[k]) throw new Error(`[rollback] player ${k} owned twice`)
        this.buffers[k] = new InputBuffer(neutral)
        players.push(k)
      }
      this.peerPlayers[pc.peer] = players
      if (pc.peer === cfg.localPeer) local = players
      else this.remotes.push(pc.peer)
    }
    if (!local) throw new Error(`[rollback] local peer ${cfg.localPeer} is not in the config`)
    this.localPlayers = local
    this.remotes.sort((a, b) => a - b)
    for (let k = 0; k < n; k++) {
      if (!this.buffers[k]) continue
      this.netPlayers.push(k)
      if (local.indexOf(k) < 0) this.remotePlayers.push(k)
    }
    this.dropped = new Uint8Array(n)
    this.switchAt = new Int32Array(n).fill(-1)

    // One decoded input per player; players nobody owns stay neutral.
    this.netInputs = []
    for (let k = 0; k < n; k++) this.netInputs.push(cfg.codec.decode(neutral, cfg.codec.create()))

    // Local input: ticks 0..delay-1 are neutral.
    this.delayCtl = new DelayController(cfg.initialDelay, delayParams)
    for (let i = 0; i < local.length; i++) this.localIn.push(cfg.codec.create())
    this.localCodes = new Uint32Array(local.length)
    for (let t = 0; t < this.delayCtl.current; t++) {
      for (let i = 0; i < local.length; i++) this.buffers[local[i]]!.set(t, neutral)
    }

    for (let i = 0; i < this.ringSize; i++) this.ring.push(new SnapWriter())
    this.ringTick = new Int32Array(this.ringSize).fill(-1)
    this.ringHash = new Uint32Array(this.ringSize)
    this.useSimHash = typeof sim.hash === 'function'
    this.usedCode = new Uint32Array(n * USED_RING)
    this.usedTick = new Int32Array(n * USED_RING).fill(-1)

    const now = net.now()
    this.live = new Uint8Array(MAX_PEERS)
    this.byeFrom = new Uint8Array(MAX_PEERS)
    this.lastRecvMs = new Float64Array(MAX_PEERS).fill(now)
    this.peerAck = new Int32Array(MAX_PEERS).fill(-1)
    for (let p = 0; p < MAX_PEERS; p++) this.rttEst.push(new RttEstimator())
    const rtt: Record<number, number> = {}
    for (let i = 0; i < this.remotes.length; i++) {
      this.live[this.remotes[i]] = 1
      rtt[this.remotes[i]] = 0
    }

    this.hashTick = new Int32Array(HASH_RING).fill(-1)
    this.hashVal = new Uint32Array(HASH_RING)
    this.hashSent = new Uint8Array(MAX_PEERS * HASH_RING)
    this.rHashTick = new Int32Array(MAX_PEERS * HASH_RING).fill(-1)
    this.rHashVal = new Uint32Array(MAX_PEERS * HASH_RING)
    for (let i = 0; i < MAX_CHECKS_PER_INPUT; i++) this.checkPool.push({ tick: 0, hash: 0 })
    this.out = { from: this.localPeer, ackTick: -1, firstTick: 0, count: 1, players: local.length, codes: this.sendCodes, senderTick: 0, checks: [] }

    this.stats = {
      tick: sim.tick,
      confirmedTick: -1,
      delay: this.delayCtl.current,
      rtt,
      rollbacks: 0,
      maxRollback: 0,
      resimTicks: 0,
      stallFrames: 0,
      frames: 0,
      desyncs: 0,
      malformed: 0,
      lostPeers: [],
      lastFrameSimMs: 0,
    }
  }

  get stalled(): boolean {
    return this.isStalled
  }

  /** The first tick whose checksums disagreed (the tick of the first desync episode), or -1. */
  get desyncTick(): number {
    return this.firstDesync
  }

  /** The authority chosen in the last decided desync episode (or the peer whose snapshot was loaded), or -1. */
  get desyncAuthority(): number {
    return this.lastAuthority
  }

  /** Authority snapshots loaded by this peer. */
  get resyncs(): number {
    return this.resyncCount
  }

  /** The agreed switch tick S of a lost peer (its players are AI from tick S + 1), or -1. */
  switchTick(peer: number): number {
    return peer >= 0 && peer < MAX_PEERS ? this.switchTickOf[peer] : -1
  }

  /** The local confirmed hash of a tick still in the hash ring, or undefined. */
  confirmedHash(tick: number): number | undefined {
    if (tick < 0) return undefined
    const s = tick % HASH_RING
    return this.hashTick[s] === tick ? this.hashVal[s] : undefined
  }

  /**
   * One rendered frame: receive, detect lost peers, roll back when needed, run the due ticks (unless stalled), send
   * INPUT and PING, and return the interpolation alpha. The smoother is decayed here; the view only applies it.
   */
  frame(frameDt: number, sampleLocal: (out: TInput[]) => void): number {
    const sim = this.sim
    const net = this.net
    const stats = this.stats
    stats.frames++
    if (!sim || !net || this.disposed) return 0
    const dt = frameDt > 0 ? (frameDt < MAX_FRAME_DT ? frameDt : MAX_FRAME_DT) : 0
    const now = net.now()

    // 1. Drain and decode.
    this.receive(sim, net, now)
    // 2. Lost peers and the switch tick agreement.
    this.detectLost(net, now)
    this.disconnectStep(sim, net, now)

    if (this.smoother) this.smoother.decay(dt)
    const t0 = this.cpuMs()
    // 3. Rollback, or a resync from an authority snapshot.
    if (!this.resync(sim)) this.rollback(sim)

    // 4. Due ticks.
    const delay = this.updateDelay(now)
    this.acc += dt
    let due = Math.floor(this.acc / this.fixedDt)
    if (due > this.maxSubsteps) due = this.maxSubsteps
    if (due > 0 && this.timeSync.shouldSkip(sim.tick)) {
      this.acc -= this.fixedDt
      due--
    }
    this.isStalled = false
    for (let i = 0; i < due; i++) {
      if (sim.tick >= this.oldestMissing() + this.maxPrediction) {
        this.isStalled = true
        break
      }
      sampleLocal(this.localIn)
      this.storeLocal(sim.tick, delay)
      this.simulate(sim, sim.tick)
      this.acc -= this.fixedDt
    }
    if (this.isStalled) stats.stallFrames++
    if (this.acc > this.maxSubsteps * this.fixedDt) this.acc = this.maxSubsteps * this.fixedDt
    this.recordConfirmed()
    stats.lastFrameSimMs = this.cpuMs() - t0
    // Desync procedure: detection, dump, DESYNC, authority and snapshot.
    this.desyncStep(sim, net)

    // 5. INPUT and PING.
    this.sendInputs(sim, net)
    if (now - this.lastPingMs >= PING_INTERVAL_MS) {
      this.lastPingMs = now
      const ping = this.writer.ping(this.localPeer, this.pingId++ >>> 0, now)
      for (let i = 0; i < this.remotes.length; i++) {
        const p = this.remotes[i]
        if (this.live[p]) net.send(p, 'fast', ping)
      }
    }

    stats.tick = sim.tick
    stats.delay = delay
    stats.confirmedTick = this.confirmed
    for (let i = 0; i < this.remotes.length; i++) stats.rtt[this.remotes[i]] = this.rttEst[this.remotes[i]].rtt

    // 6. Alpha.
    const a = this.acc / this.fixedDt
    return a > 0 ? (a < 1 ? a : 1) : 0
  }

  /** Sends BYE on the reliable channel to every live peer. */
  leave(): void {
    const net = this.net
    if (!net) return
    const bye = this.writer.bye(this.localPeer)
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (this.live[p]) net.send(p, 'reliable', bye)
      // Nothing more goes out after a BYE.
      this.live[p] = 0
    }
  }

  /** Releases the sim, the transport and the buffers. frame() returns 0 afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sim = null
    this.net = null
    this.ring = []
    this.buffers = []
    this.netInputs = []
    this.inbox.length = 0
    this.assembler.reset()
    this.pendingSnap = null
    this.onDesync = null
    this.onPeerLost = null
  }

  // ---------------------------------------------------------------- receive

  private receive(sim: Simulation<TInput>, net: NetTransport, now: number): void {
    const inbox = this.inbox
    net.drain(inbox)
    for (let i = 0; i < inbox.length; i++) {
      const e = inbox[i]
      const m = decode(e.data)
      const from = e.peer
      if (!m || m.from !== from || from === this.localPeer || !this.peerPlayers[from]) {
        this.stats.malformed++
        continue
      }
      if (!this.live[from]) continue
      this.lastRecvMs[from] = now
      switch (m.type) {
        case MSG.INPUT:
          this.onInput(sim, m)
          break
        case MSG.PING:
          net.send(from, 'fast', this.writer.pong(this.localPeer, m.id, m.ms))
          break
        case MSG.PONG:
          if (now >= m.ms) this.rttEst[from].sample(now - m.ms)
          break
        case MSG.SNAPSHOT:
          this.onSnapshot(m)
          break
        case MSG.DESYNC:
          this.onDesyncMsg(m)
          break
        case MSG.BYE:
          this.byeFrom[from] = 1
          break
        case MSG.DROP:
          this.onDrop(sim, net, m, now)
          break
        // READY is handled before the sim.
        default:
          break
      }
    }
  }

  private onInput(sim: Simulation<TInput>, m: InputWireMsg): void {
    const from = m.from
    const players = this.peerPlayers[from]!
    if (m.players !== players.length || m.firstTick < 0) {
      this.stats.malformed++
      return
    }
    if (m.ackTick > this.peerAck[from]) this.peerAck[from] = m.ackTick
    this.timeSync.observe(from, m.senderTick, sim.tick, this.rttEst[from].rtt)

    const nk = players.length
    const codes = m.codes
    const simulated = sim.tick
    for (let i = 0; i < m.count; i++) {
      const t = m.firstTick + i
      for (let j = 0; j < nk; j++) {
        const k = players[j]
        this.storeRemote(k, t, codes[i * nk + j], simulated)
      }
    }

    const checks = m.checks
    for (let i = 0; i < checks.length; i++) this.onRemoteHash(from, checks[i].tick, checks[i].hash)
  }

  /** Stores a remote code; a simulated tick that used another code marks the rollback tick. */
  private storeRemote(k: number, t: number, code: number, simulated: number): void {
    if (!this.buffers[k]!.set(t, code) || t >= simulated) return
    const s = k * USED_RING + (t % USED_RING)
    if (this.usedTick[s] === t && this.usedCode[s] !== code >>> 0 && t < this.rollbackTick) this.rollbackTick = t
  }

  /**
   * A DROP from a remaining peer: its announced lastTick for the lost peer is recorded and the carried inputs are
   * merged into the lost players' buffers. A DROP about a peer still live here makes it lost here too.
   */
  private onDrop(sim: Simulation<TInput>, net: NetTransport, m: DropMsg, now: number): void {
    const L = m.lostPeer
    if (L === this.localPeer) return
    const players = L < MAX_PEERS ? this.peerPlayers[L] : null
    if (!players || L === m.from || m.players !== players.length || (m.count > 0 && m.lastTick - m.firstTick + 1 !== m.count) || m.lastTick < -1) {
      this.stats.malformed++
      return
    }
    if (this.lostState[L] === 2) return
    this.dropLast[L * MAX_PEERS + m.from] = m.lastTick
    const nk = players.length
    const simulated = sim.tick
    for (let i = 0; i < m.count; i++) {
      const t = m.firstTick + i
      for (let j = 0; j < nk; j++) this.storeRemote(players[j], t, m.codes[i * nk + j], simulated)
    }
    if (this.lostState[L] === 0) this.peerLost(net, L, now)
  }

  /** Collects SNAPSHOT parts; a complete one waits in pendingSnap for resync(). */
  private onSnapshot(m: SnapshotMsg): void {
    const r = this.assembler.push(m)
    if (r) this.pendingSnap = { from: m.from, tick: r.tick, hash: r.hash, bytes: r.bytes }
  }

  /**
   * A DESYNC: the sender's hash at its mismatch tick, used like a checksum and as an episode hash. From a resyncing
   * peer, a DESYNC for a tick after the episode that marked it starts trusting it again (it desynced anew).
   */
  private onDesyncMsg(m: DesyncMsg): void {
    const p = m.from
    const tick = m.tick
    if (tick < 0) return
    let renewed = false
    if (this.resyncing[p] && tick > this.resyncMark[p]) {
      this.resyncing[p] = 0
      if (tick > this.trustFrom[p]) this.trustFrom[p] = tick
      renewed = true
    }
    this.onRemoteHash(p, tick, m.hash)
    // Its hash of that tick may have been stored (and ignored) before.
    const s = tick % HASH_RING
    if (renewed && this.hashTick[s] === tick) this.compareHash(p, tick, this.hashVal[s], m.hash)
  }

  // ---------------------------------------------------------------- peers

  private detectLost(net: NetTransport, now: number): void {
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (!this.live[p]) continue
      if (this.byeFrom[p] || net.closed(p) || now - this.lastRecvMs[p] > this.lostAfterMs) this.peerLost(net, p, now)
    }
  }

  /**
   * Marks a peer lost: no more sends to it, no time sync against it and its checksums are ignored. It broadcasts
   * DROP for it, starts the agreement on its switch tick and restarts the agreements in progress (smaller set).
   */
  private peerLost(net: NetTransport, p: number, now: number): void {
    if (this.lostState[p]) return
    this.live[p] = 0
    this.timeSync.forget(p)
    for (let i = 0; i < this.remotes.length; i++) {
      const q = this.remotes[i]
      if (this.lostState[q] === 1) this.dropStart[q] = now
    }
    this.lostState[p] = 1
    this.dropStart[p] = now
    this.sendDrop(net, p)
  }

  /** DROP to every live peer: the lost peer's last (up to 64) contiguous inputs held here; lastTick is announced. */
  private sendDrop(net: NetTransport, L: number): void {
    const players = this.peerPlayers[L]!
    const nk = players.length
    let last = nk > 0 ? Infinity : -1
    for (let j = 0; j < nk; j++) {
      const t = this.buffers[players[j]]!.lastTick
      if (t < last) last = t
    }
    let first = last - MAX_WIRE_TICKS + 1
    if (first < 0) first = 0
    const count = last >= first ? last - first + 1 : 0
    const codes = this.dropSendCodes
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < nk; j++) {
        const c = this.buffers[players[j]]!.get(first + i)
        codes[i * nk + j] = c !== undefined ? c : this.codec.neutral >>> 0
      }
    }
    this.dropOwn[L] = last
    const msg = this.writer.drop(this.localPeer, L, last, first, nk, count, codes)
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (this.live[p]) net.send(p, 'reliable', msg)
    }
  }

  /**
   * The agreement on each lost peer's switch tick: once a DROP is held from every remaining peer, S = the max
   * announced lastTick (this peer's included). A remaining peer still silent DROP_WAIT_MS after the (re)start is lost
   * too, which restarts the agreement over the smaller set.
   */
  private disconnectStep(sim: Simulation<TInput>, net: NetTransport, now: number): void {
    for (let i = 0; i < this.remotes.length; i++) {
      const L = this.remotes[i]
      if (this.lostState[L] !== 1) continue
      let S = this.dropOwn[L]
      let all = true
      for (let j = 0; j < this.remotes.length; j++) {
        const p = this.remotes[j]
        if (!this.live[p]) continue
        const v = this.dropLast[L * MAX_PEERS + p]
        if (v === DROP_UNKNOWN) all = false
        else if (v > S) S = v
      }
      if (all) {
        this.agree(sim, L, S)
      } else if (now - this.dropStart[L] > this.dropWaitMs) {
        for (let j = 0; j < this.remotes.length; j++) {
          const p = this.remotes[j]
          if (this.live[p] && this.dropLast[L * MAX_PEERS + p] === DROP_UNKNOWN) this.peerLost(net, p, now)
        }
        // The agreements restarted over the smaller set (timers reset to now): evaluate them all again.
        i = -1
      }
    }
  }

  /**
   * S is agreed for lost peer L: its players need no input past S and become AI at the start of tick S + 1. Ticks past
   * S already simulated are re-simulated from S + 1 (reloading a tick <= S + 1 restores 'net' and switches again).
   */
  private agree(sim: Simulation<TInput>, L: number, S: number): void {
    this.lostState[L] = 2
    this.switchTickOf[L] = S
    const players = this.peerPlayers[L]!
    for (let j = 0; j < players.length; j++) {
      this.dropped[players[j]] = 1
      this.switchAt[players[j]] = S + 1
    }
    if (S + 1 < sim.tick && S + 1 < this.rollbackTick) this.rollbackTick = S + 1 > 0 ? S + 1 : 0
    this.stats.lostPeers.push(L)
    const cb = this.onPeerLost
    if (cb) cb(L, S)
  }

  /** The last tick of player k's awaited inputs: Infinity for a dropped player known up to its switch tick. */
  private lastAwaited(k: number): number {
    const t = this.buffers[k]!.lastTick
    return this.dropped[k] && t >= this.switchAt[k] - 1 ? Infinity : t
  }

  /** The delay controller fed with the max RTT and max jitter of the live peers that have RTT samples. */
  private updateDelay(now: number): number {
    let maxRtt = 0
    let maxJitter = 0
    let any = false
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      const e = this.rttEst[p]
      if (!this.live[p] || e.samples === 0) continue
      any = true
      if (e.rtt > maxRtt) maxRtt = e.rtt
      if (e.jitter > maxJitter) maxJitter = e.jitter
    }
    return any ? this.delayCtl.update(now, maxRtt, maxJitter) : this.delayCtl.current
  }

  // ---------------------------------------------------------------- simulation

  /** The oldest tick with a missing awaited remote input (see lastAwaited); Infinity when none is awaited. */
  private oldestMissing(): number {
    let m = Infinity
    const players = this.remotePlayers
    for (let i = 0; i < players.length; i++) {
      const t = this.lastAwaited(players[i]) + 1
      if (t < m) m = t
    }
    return m
  }

  /**
   * Stores the sampled local codes at tick + delay. When the delay grew, the gap ticks get the same code; when it
   * shrank, ticks already stored (and maybe sent) are never overwritten, so this sample is dropped.
   */
  private storeLocal(tick: number, delay: number): void {
    const players = this.localPlayers
    if (players.length === 0) return
    for (let i = 0; i < players.length; i++) this.localCodes[i] = this.codec.encode(this.localIn[i]) >>> 0
    const target = tick + delay
    let next = this.buffers[players[0]]!.lastTick + 1
    if (next < tick) next = tick
    for (let t = next; t <= target; t++) {
      for (let i = 0; i < players.length; i++) this.buffers[players[i]]!.set(t, this.localCodes[i])
    }
  }

  /**
   * Runs tick t: decodes the known or predicted code of every net player into the input array (recording the used
   * codes), saves the snapshot of t into the ring, applies the drop hook and steps.
   */
  private simulate(sim: Simulation<TInput>, t: number): void {
    const players = this.netPlayers
    const slot = t % USED_RING
    const neutral = this.codec.neutral >>> 0
    for (let i = 0; i < players.length; i++) {
      const k = players[i]
      const buf = this.buffers[k]!
      const at = this.switchAt[k]
      let code: number
      if (at >= 0 && t >= at) {
        code = neutral
      } else {
        const known = buf.get(t)
        code = known !== undefined ? known : buf.predict(t)
      }
      const s = k * USED_RING + slot
      this.usedCode[s] = code
      this.usedTick[s] = t
      this.codec.decode(code, this.netInputs[k])
    }
    const r = t % this.ringSize
    const w = this.ring[r]
    w.reset()
    sim.snapshot(w)
    this.ringTick[r] = t
    if (this.useSimHash) this.ringHash[r] = sim.hash!() >>> 0
    // The drop hook applies after the snapshot of t, so the snapshot and hash of S + 1 (which may be confirmed before
    // the loss is known) do not depend on it; a reload at t <= S + 1 re-applies it here.
    if (sim.playerDropped) {
      for (let k = 0; k < this.nPlayers; k++) {
        const at = this.switchAt[k]
        if (at >= 0 && t >= at) sim.playerDropped(k)
      }
    }
    sim.step(this.netInputs)
  }

  /** Step 3: reload the earliest differing tick and re-simulate to the present, view events muted. */
  private rollback(sim: Simulation<TInput>): void {
    let rb = this.rollbackTick
    this.rollbackTick = Infinity
    if (rb < this.floorTick) rb = this.floorTick
    const present = sim.tick
    if (!(rb < present)) return
    const r = rb % this.ringSize
    // Older than the ring: cannot happen within the prediction window; the checksums would report it.
    if (present - rb > this.ringSize || this.ringTick[r] !== rb) return
    const view = sim.view
    if (view && this.smoother) this.smoother.capture(view)
    if (sim.beginResim) sim.beginResim()
    try {
      sim.restore(new SnapReader(this.ring[r].bytes()))
      for (let t = rb; t < present; t++) this.simulate(sim, t)
    } finally {
      if (sim.endResim) sim.endResim()
    }
    if (view && this.smoother) this.smoother.settle(view)
    const depth = present - rb
    const stats = this.stats
    stats.rollbacks++
    if (depth > stats.maxRollback) stats.maxRollback = depth
    stats.resimTicks += depth
  }

  // ---------------------------------------------------------------- checksums

  /**
   * Records the hash of every newly confirmed tick c: all inputs of the ticks before c are known and c was simulated
   * with them (its snapshot is in the ring).
   */
  private recordConfirmed(): void {
    const sim = this.sim!
    let known = Infinity
    const players = this.netPlayers
    for (let i = 0; i < players.length; i++) {
      const t = this.lastAwaited(players[i])
      if (t < known) known = t
    }
    let c = known + 1
    if (c > sim.tick - 1) c = sim.tick - 1
    for (let t = this.confirmed + 1; t <= c; t++) {
      const r = t % this.ringSize
      if (this.ringTick[r] !== t) continue
      const hash = this.useSimHash ? this.ringHash[r] : fnv1a32(this.ring[r].bytes())
      const s = t % HASH_RING
      this.hashTick[s] = t
      this.hashVal[s] = hash
      for (let p = 0; p < MAX_PEERS; p++) {
        this.hashSent[p * HASH_RING + s] = 0
        if (this.rHashTick[p * HASH_RING + s] === t) this.compareHash(p, t, hash, this.rHashVal[p * HASH_RING + s])
      }
    }
    if (c > this.confirmed) this.confirmed = c
  }

  /** A remote confirmed checksum: stored once per (peer, tick) and compared with the local one when known. */
  private onRemoteHash(peer: number, tick: number, hash: number): void {
    if (tick < 0) return
    const s = tick % HASH_RING
    const i = peer * HASH_RING + s
    if (this.epActive && !this.epDecided && tick === this.epTick) {
      this.epHash[peer] = hash >>> 0
      this.epKnown[peer] = 1
    }
    if (this.rHashTick[i] === tick) return
    this.rHashTick[i] = tick
    this.rHashVal[i] = hash
    if (this.hashTick[s] === tick) this.compareHash(peer, tick, this.hashVal[s], hash)
  }

  /**
   * Compares a local and a remote confirmed hash of peer's tick. A match brings a resyncing peer back; a mismatch
   * outside an episode (and not stale) records the earliest mismatching tick for desyncStep.
   */
  private compareHash(peer: number, tick: number, local: number, remote: number): void {
    // Checksums from a lost peer are ignored.
    if (this.lostState[peer]) return
    if (local >>> 0 === remote >>> 0) {
      if (this.resyncing[peer]) {
        this.resyncing[peer] = 0
        if (tick > this.trustFrom[peer]) this.trustFrom[peer] = tick
      }
      return
    }
    if (this.epActive || this.resyncing[peer] || tick < this.trustFrom[peer]) return
    if (tick < this.mismatchTick) {
      this.mismatchTick = tick
      this.mismatchLocal = local >>> 0
    }
  }

  // ---------------------------------------------------------------- desync procedure

  /**
   * Runs after the ticks of a frame: expires stale resync marks, starts an episode on the first mismatch (dump, then
   * DESYNC), decides the authority once every live peer's hash at the episode tick is known and, as the authority,
   * sends the snapshot of its latest confirmed tick to the losers.
   */
  private desyncStep(sim: Simulation<TInput>, net: NetTransport): void {
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (this.resyncing[p] && sim.tick >= this.resyncUntil[p]) {
        this.resyncing[p] = 0
        if (this.confirmed + 1 > this.trustFrom[p]) this.trustFrom[p] = this.confirmed + 1
      }
    }
    if (!this.epActive) {
      if (this.mismatchTick === Infinity) return
      this.startEpisode(sim, net)
    }
    // A loser whose authority got lost decides again among the live peers.
    if (this.epDecided && this.epAuthority !== this.localPeer && !this.live[this.epAuthority]) this.epDecided = false
    if (!this.epDecided) this.decide(sim)
    if (this.epActive && this.epDecided && this.epAuthority === this.localPeer) this.sendSnapshot(net)
  }

  /** Steps 1 and 2: the dump (onDesync) and the DESYNC broadcast for the earliest mismatching tick. */
  private startEpisode(sim: Simulation<TInput>, net: NetTransport): void {
    const T = this.mismatchTick
    this.mismatchTick = Infinity
    this.epActive = true
    this.epTick = T
    this.epLocal = this.mismatchLocal
    this.epDecided = false
    this.epAuthority = -1
    this.epLosers = []
    this.epKnown.fill(0)
    this.epHash[this.localPeer] = this.epLocal
    this.epKnown[this.localPeer] = 1
    const remote: { peer: number; hash: number }[] = []
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      const j = p * HASH_RING + (T % HASH_RING)
      if (this.rHashTick[j] !== T) continue
      this.epHash[p] = this.rHashVal[j]
      this.epKnown[p] = 1
      remote.push({ peer: p, hash: this.rHashVal[j] })
    }
    this.stats.desyncs++
    if (this.firstDesync < 0) this.firstDesync = T

    // 1. The dump.
    const cb = this.onDesync
    if (cb) cb(this.buildDump(sim, T, remote))
    // 2. DESYNC on reliable.
    const msg = this.writer.desync(this.localPeer, T, this.epLocal)
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (this.live[p]) net.send(p, 'reliable', msg)
    }
  }

  /** The dump of tick T: hashes, the ring snapshot of T, the used codes of the last dumpTicks ticks and the info. */
  private buildDump(sim: Simulation<TInput>, T: number, remote: { peer: number; hash: number }[]): DesyncDump {
    const r = T % this.ringSize
    const snapshotB64 = this.ringTick[r] === T ? bytesToBase64(this.ring[r].bytes()) : null
    const players = this.netPlayers
    const inputs: { tick: number; codes: number[] }[] = []
    const end = sim.tick
    const from = end - this.dumpTicks > 0 ? end - this.dumpTicks : 0
    for (let t = from; t < end; t++) {
      const codes: number[] = []
      for (let i = 0; i < players.length; i++) {
        const s = players[i] * USED_RING + (t % USED_RING)
        if (this.usedTick[s] !== t) break
        codes.push(this.usedCode[s])
      }
      if (codes.length === players.length) inputs.push({ tick: t, codes })
    }
    return { tick: T, localHash: this.epLocal, remote, snapshotB64, inputs, players: players.slice(), info: this.dumpInfo ? this.dumpInfo() : null }
  }

  /**
   * Step 3: once the hash at the episode tick is known from every live peer, chooseAuthority. Losers other than this
   * peer are marked resyncing (their stale hashes are ignored). A winner that is not the authority is done.
   */
  private decide(sim: Simulation<TInput>): void {
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (this.live[p] && !this.epKnown[p]) return
    }
    const list: { peer: number; hash: number }[] = []
    for (let p = 0; p < MAX_PEERS; p++) {
      if (!this.epKnown[p] || (p !== this.localPeer && (!this.peerPlayers[p] || !this.live[p]))) continue
      list.push({ peer: p, hash: this.epHash[p] })
    }
    const d = chooseAuthority(list)
    this.epDecided = true
    this.epAuthority = d.authority
    this.epLosers = d.losers
    this.lastAuthority = d.authority
    let lost = false
    for (let i = 0; i < d.losers.length; i++) {
      const p = d.losers[i]
      if (p === this.localPeer) {
        lost = true
        continue
      }
      this.resyncing[p] = 1
      this.resyncUntil[p] = sim.tick + RESYNC_TIMEOUT_TICKS
      this.resyncMark[p] = this.epTick
    }
    if (!lost && d.authority !== this.localPeer) this.epActive = false
    if (d.losers.length === 0) this.epActive = false
  }

  /** Step 4: the authority sends SNAPSHOT of its latest confirmed tick C >= T (still in the ring) to every loser. */
  private sendSnapshot(net: NetTransport): void {
    let c = this.confirmed
    while (c >= this.epTick && this.ringTick[c % this.ringSize] !== c) c--
    if (c < this.epTick) return
    const bytes = this.ring[c % this.ringSize].bytes()
    const parts = this.writer.snapshotParts(this.localPeer, c, fnv1a32(bytes), bytes)
    for (let i = 0; i < this.epLosers.length; i++) {
      const p = this.epLosers[i]
      if (p === this.localPeer || !this.live[p]) continue
      for (let j = 0; j < parts.length; j++) net.send(p, 'reliable', parts[j])
    }
    this.epActive = false
  }

  /**
   * Step 5: a loser holding the authority snapshot of tick C loads it and re-simulates to the present with its
   * buffered inputs (events muted, smoother capture/settle), then resets its hash ring from C. Returns true when it
   * did (the rollback of this frame is covered by the re-simulation).
   */
  private resync(sim: Simulation<TInput>): boolean {
    const snap = this.pendingSnap
    if (!snap) return false
    const present = sim.tick
    if (present - snap.tick > RESYNC_MAX_TICKS) {
      this.pendingSnap = null
      return false
    }
    // Kept until this peer's own episode starts (the snapshot may overtake the checksums).
    if (!this.epActive || (this.epDecided && this.epAuthority === this.localPeer)) return false
    this.pendingSnap = null
    if (snap.tick < this.epTick || (this.epDecided && snap.from !== this.epAuthority)) return false

    const C = snap.tick
    const view = sim.view
    if (view && this.smoother) this.smoother.capture(view)
    if (sim.beginResim) sim.beginResim()
    try {
      sim.restore(new SnapReader(snap.bytes))
      this.ringTick.fill(-1)
      if (C >= present) {
        const r = C % this.ringSize
        this.ring[r].reset()
        sim.snapshot(this.ring[r])
        this.ringTick[r] = C
        if (this.useSimHash) this.ringHash[r] = sim.hash!() >>> 0
      }
      for (let t = C; t < present; t++) this.simulate(sim, t)
    } catch {
      return false
    } finally {
      if (sim.endResim) sim.endResim()
    }
    if (view && this.smoother) this.smoother.settle(view)
    if (present > C) this.stats.resimTicks += present - C
    this.rollbackTick = Infinity
    this.floorTick = C

    // The hash ring restarts at C; the ticks up to the old confirmed tick are not re-sent (their old hashes went out).
    const oldConfirmed = this.confirmed
    this.hashTick.fill(-1)
    this.confirmed = C - 1
    if (oldConfirmed + 1 > this.checkFloor) this.checkFloor = oldConfirmed + 1
    // The other peers that held this peer's hash at T lost too: their pre-resync hashes are stale.
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (p === snap.from || !this.epKnown[p] || this.epHash[p] !== this.epLocal) continue
      this.resyncing[p] = 1
      this.resyncUntil[p] = sim.tick + RESYNC_TIMEOUT_TICKS
      this.resyncMark[p] = this.epTick
    }
    this.lastAuthority = snap.from
    this.resyncCount++
    this.epActive = false
    this.mismatchTick = Infinity
    return true
  }

  // ---------------------------------------------------------------- send

  /**
   * INPUT per live peer: every local tick newer than its ack (at most 64; at least the newest one), the ack of its
   * own inputs, and the confirmed checksums not yet sent CHECK_REPEATS times to it.
   */
  private sendInputs(sim: Simulation<TInput>, net: NetTransport): void {
    const local = this.localPlayers
    const nk = local.length
    const localLast = nk > 0 ? this.buffers[local[0]]!.lastTick : sim.tick
    if (localLast < 0) return
    const cap = nk > 0 ? this.buffers[local[0]]!.capacity : MAX_WIRE_TICKS
    const out = this.out
    out.senderTick = sim.tick
    out.players = nk
    for (let i = 0; i < this.remotes.length; i++) {
      const p = this.remotes[i]
      if (!this.live[p]) continue
      let first = this.peerAck[p] + 1
      if (first > localLast) first = localLast
      if (first <= localLast - cap) first = localLast - MAX_WIRE_TICKS + 1
      if (first < 0) first = 0
      let count = localLast - first + 1
      if (count > MAX_WIRE_TICKS) count = MAX_WIRE_TICKS
      const codes = this.sendCodes
      for (let t = 0; t < count; t++) {
        for (let j = 0; j < nk; j++) {
          const c = this.buffers[local[j]]!.get(first + t)
          codes[t * nk + j] = c !== undefined ? c : this.codec.neutral >>> 0
        }
      }
      out.firstTick = first
      out.count = count
      out.ackTick = this.ackFor(p)
      this.fillChecks(p)
      net.send(p, 'fast', this.writer.input(out))
    }
  }

  /** The highest contiguous tick of peer p's inputs held here. */
  private ackFor(p: number): number {
    const players = this.peerPlayers[p]!
    if (players.length === 0) return -1
    let ack = Infinity
    for (let j = 0; j < players.length; j++) {
      const t = this.buffers[players[j]]!.lastTick
      if (t < ack) ack = t
    }
    return ack
  }

  /** Fills out.checks, oldest first, with the confirmed hashes sent fewer than CHECK_REPEATS times to peer p. */
  private fillChecks(p: number): void {
    const checks = this.out.checks
    let n = 0
    let from = this.confirmed - HASH_RING + 1
    if (from < this.checkFloor) from = this.checkFloor
    if (from < 0) from = 0
    for (let t = from; t <= this.confirmed && n < MAX_CHECKS_PER_INPUT; t++) {
      const s = t % HASH_RING
      const i = p * HASH_RING + s
      if (this.hashTick[s] !== t || this.hashSent[i] >= CHECK_REPEATS) continue
      this.hashSent[i]++
      const c = this.checkPool[n]
      c.tick = t
      c.hash = this.hashVal[s]
      checks[n++] = c
    }
    checks.length = n
  }
}
