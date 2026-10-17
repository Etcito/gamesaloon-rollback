// The public contracts of the library: the Simulation a game implements, the input codec, the transport and the
// session configuration. Pure types (plus one tiny helper), no side effects.
import type { SnapReader, SnapWriter } from './snap.ts'

/** The two channels of a transport. `fast` may drop and reorder (UDP-like), `reliable` is ordered and lossless. */
export type NetChannel = 'fast' | 'reliable'

/**
 * A peer transport: a WebRTC mesh or WebSocket relay in production, NetSim in tests.
 * The data passed to send may be reused by the caller right after the call.
 * The only clock of the library is now() (milliseconds, monotonic).
 */
export interface NetTransport {
  send(peer: number, ch: NetChannel, data: Uint8Array): void
  /** Fills `out` with the packets received since the last call (reusing its entries). Entries stay valid until the next drain. */
  drain(out: { peer: number; ch: NetChannel; data: Uint8Array }[]): void
  /** True once the link to a peer is known to be closed. */
  closed(peer: number): boolean
  now(): number
}

/**
 * A view of the entities whose displayed position the session smooths after a rollback correction.
 * Optional: a Simulation without `view` is simply not smoothed. See CorrectionSmoother.
 */
export interface SimView {
  /** Number of smoothed entities. */
  readonly entities: number
  /** Floats per entity (for example 2 for x/y, 3 for x/y/z). Plain linear quantities only. */
  readonly stride: number
  /** Writes entities * stride floats into `out`: the pose the player would see right now. Must not allocate. */
  read(out: Float64Array): void
}

/**
 * Reserved seam for a future interest-managed mode (see docs/DESIGN.md, "Interest management"). The current
 * session ignores it completely. A simulation may already describe which region each player is in so that a later
 * session can restrict rollback to the entities near a peer.
 */
export interface RegionHints {
  /** Region id of a player right now (any stable integer), or -1 when unknown. */
  regionOf(player: number): number
  /** Whether activity in region a can influence region b within one tick. */
  adjacent(a: number, b: number): boolean
}

/**
 * What a game implements to be rolled back.
 *
 * Rules: step() must be a pure function of the restorable state and the inputs (see the determinism rules in
 * docs/DESIGN.md). snapshot() must write everything step() reads or writes; restore() must put the simulation in
 * exactly the state it had when snapshot() ran, including `tick`. Tick t is the step that runs while `tick === t`;
 * step() increments `tick` by one.
 */
export interface Simulation<TInput> {
  /** The tick the next step() runs. Starts at 0. */
  tick: number
  /** Advances one fixed tick. `inputs[p]` is the input of player p (length = RollbackConfig.playerCount). */
  step(inputs: readonly TInput[]): void
  /** Writes the full restorable state. */
  snapshot(w: SnapWriter): void
  /** Reads what snapshot() wrote and replaces the state. */
  restore(r: SnapReader): void
  /**
   * A 32-bit hash of the restorable state, used to detect desyncs. Optional: when absent the session uses
   * fnv1a32 of the snapshot bytes (always correct, one pass over the snapshot per confirmed tick). When present it
   * is called once per simulated tick right before step(), so it must be cheap and must cover the same state.
   */
  hash?(): number
  /**
   * Called before step() of every tick at or after the agreed switch tick of a lost player (idempotent: it is called
   * again on every re-simulation and every following tick). The player's input is the codec's neutral input from
   * then on; use this hook to let a bot take over or to remove the player. Its effect must be a function of the
   * restorable state.
   */
  playerDropped?(player: number): void
  /** Called before a rollback / resync re-simulation starts: mute sounds, particles and other view events. */
  beginResim?(): void
  /** Called after the re-simulation; always paired with beginResim. */
  endResim?(): void
  /** Optional smoothing view, see SimView. */
  readonly view?: SimView
  /** Reserved, ignored by the current session: see RegionHints. */
  readonly regions?: RegionHints
}

/**
 * Converts between the game's input value and the u32 that travels on the wire and sits in the input buffers.
 * Inputs are small: pack them in 32 bits (buttons as bits, axes quantised). The simulation must only ever see
 * decoded (quantised) inputs, also for the local player, so every peer steps with identical values; the session
 * guarantees this by always stepping with decode(encode(sample)).
 */
export interface InputCodec<TInput> {
  /** A fresh input value (the session preallocates and reuses these; decode() overwrites them). */
  create(): TInput
  /** Input to u32. Must not allocate. */
  encode(input: TInput): number
  /** u32 to input, written into `out` (returned). Must not allocate. */
  decode(code: number, out: TInput): TInput
  /** The code used before any input is known, for dropped players and for the first ticks. */
  readonly neutral: number
}

export interface PeerConfig {
  /** Peer id, 0 .. MAX_PEERS-1. */
  peer: number
  /** Global player indices this peer controls, in its local slot order. May be empty (a pure observer). */
  players: number[]
}

/** Tunables. Every field is optional. */
export interface RollbackTuning {
  /** Fixed simulation rate in Hz. Default 60. */
  tickRate?: number
  /** Most ticks run per frame. Default 8. */
  maxSubsteps?: number
  /** Ticks the simulation may run ahead of the oldest missing remote input before it stalls. Default 16. */
  maxPrediction?: number
  /** Snapshots kept (must exceed maxPrediction, at most 256). Default 40. */
  snapshotRing?: number
  /** Input delay bounds, ticks. Defaults 2 and 8. */
  minDelay?: number
  maxDelay?: number
  /** Ticks of latency the input delay leaves to rollback. Default 6. */
  delayHiddenTicks?: number
  /** A peer silent for this long (ms) is lost. Default 3000. */
  lostAfterMs?: number
  /** A peer not answering the drop agreement for this long (ms) is lost too. Default 1500. */
  dropWaitMs?: number
  /** Ticks of used inputs written into a desync dump. Default 240. */
  dumpTicks?: number
}

export interface RollbackConfig<TInput> extends RollbackTuning {
  localPeer: number
  /** Number of players in the simulation: length of the inputs array passed to step(). */
  playerCount: number
  /** The peers and the players they control. Players owned by nobody always get the neutral input. */
  peers: PeerConfig[]
  codec: InputCodec<TInput>
  /** Starting input delay in ticks. */
  initialDelay?: number
  /** Optional extra data copied verbatim into desync dumps (game setup, seed, content version...). */
  dumpInfo?: () => unknown
  /** Optional CPU timer (ms) for NetStats.lastFrameSimMs. */
  cpuMs?: () => number
}

/** `peers` peers with `playersPerPeer` players each: peer i controls players i*n .. i*n+n-1. */
export function evenPeers(peers: number, playersPerPeer = 1): PeerConfig[] {
  const out: PeerConfig[] = []
  for (let p = 0; p < peers; p++) {
    const players: number[] = []
    for (let j = 0; j < playersPerPeer; j++) players.push(p * playersPerPeer + j)
    out.push({ peer: p, players })
  }
  return out
}
