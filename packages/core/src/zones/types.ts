// The contracts of the zone mode: what assignment produces, what a domain simulation implements, and the group
// transport. Pure types, no runtime code. Tuning lives in tuning.ts; tuning is configuration, not contract.
import type { NetChannel, NetTransport, SimView } from '../types.ts'
import type { SnapReader, SnapWriter } from '../snap.ts'

/** A domain: a PointSim island or one Rapier World. 0 is the global domain. */
export type DomainId = number

/** One player. Two bytes on the wire and in the control word. */
export type SeatId = number

/** A seat domain holds seats, a field domain an untouched interactive area, the global domain match-wide results. */
export type DomainKind = 'seat' | 'field' | 'global'

/** One simulated island: its kind, the cells and seats it covers, and its replica peers in rendezvous order. */
export interface DomainSpec {
  readonly id: DomainId
  readonly kind: DomainKind
  readonly cells: number[]
  readonly seats: SeatId[]
  /** Peers that simulate this domain; replicas[0] is the producer. */
  readonly replicas: number[]
}

/** A one-way boundary: the confirmed entities of `from` enter `to` as inputs. */
export interface ShadowLink {
  readonly from: DomainId
  readonly to: DomainId
}

/** One epoch of the assignment: domains in ascending id order, and the per-seat lookup arrays. */
export interface Assignment {
  readonly epoch: number
  readonly domains: DomainSpec[]
  readonly shadows: ShadowLink[]
  /** Domain of each seat, or -1 for a seat with no cell (observer). */
  readonly seatDomain: Int32Array
  /** Peer that drives each seat, or -1 when no live peer can host the seat. */
  readonly seatHost: Int16Array
  /** Epochs each seat has been in its current domain, for the minimum-residence rule. */
  readonly residence: Uint16Array
}

/** Who plays and who is still live at the tick the assignment is computed for. */
export interface Roster {
  readonly seatCount: number
  readonly peers: { readonly peer: number; readonly seats: SeatId[] }[]
  readonly live: boolean[]
}

/** The control words confirmed at the sampling tick of an epoch, one u32 per seat. */
export interface ControlSample {
  readonly epoch: number
  readonly words: Uint32Array
}

/**
 * The read side a DomainSim.step receives: for each inbound shadow link, the source domain id and a SnapReader over
 * its confirmed boundary payload for this tick. Iterate by index; no allocation per shadow.
 */
export interface ShadowView {
  /** Number of inbound shadow links this tick. */
  readonly count: number
  /** Source domain id of shadow i, in ascending link order. */
  fromDomain(i: number): DomainId
  /** A SnapReader over the boundary payload of shadow i; valid until the next step. */
  reader(i: number): SnapReader
}

/** A body falling asleep or waking; the producer sends one reliable message per transition. */
export interface SleepEvent {
  readonly id: number
  readonly tick: number
  readonly asleep: boolean
}

/**
 * One domain simulation. Identity rules: entity and joint ids are stable u32 and never reused; non-interactive moving
 * parts are kinematic by tick and are not part of the entity export.
 */
export interface DomainSim<TInput> {
  /** The tick the next step() runs. */
  tick: number
  /** Advances one tick; `inputs` is indexed in spec.seats order, shadows are the confirmed boundary of this tick. */
  step(inputs: readonly TInput[], shadows: ShadowView): void
  /** Writes the full restorable state. */
  snapshot(w: SnapWriter): void
  /** Reads what snapshot() wrote and replaces the state. */
  restore(r: SnapReader): void
  /** fnv1a32 over the awake-entity block followed by the u32 sleep digest (ascending id u32, sleepTick i32). */
  hash(): number
  /** Writes the boundary entities in ascending id order. */
  exportEntities(w: SnapWriter): void
  /** Writes what `to` consumes from this domain as its shadow input. */
  shadowOut(w: SnapWriter, to: DomainId): void
  /** Writes this domain's events for the implicit link to the global domain. */
  events(w: SnapWriter): void
  /** Writes the display-only far-stream poses at this tick's stride. */
  far(w: SnapWriter, stride: number): void
  /** Replaces playerDropped: the peer that drives a seat, or a bot host driving it. */
  seatHost(seat: SeatId, peer: number, bot: boolean): void
  /** Fills the caller-owned `out` with the sleep and wake transitions of this tick. */
  sleepEvents(out: SleepEvent[]): void
  /** Called before a resimulation starts: mute view events. */
  beginResim?(): void
  /** Called after the resimulation; always paired with beginResim. */
  endResim?(): void
  /** Optional smoothing view; a domain can be smoothed after a correction like a Simulation. */
  readonly view?: SimView
}

/** Creates, rebuilds and resets domains from an assignment spec. */
export interface DomainFactory<TInput> {
  /** A fresh domain at `tick`. */
  create(spec: DomainSpec, tick: number): DomainSim<TInput>
  /** A domain built from the exportEntities of each source domain, merged in ascending entity id order. */
  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): DomainSim<TInput>
  /** A deterministic reset from the spec alone. */
  reset(spec: DomainSpec, tick: number): DomainSim<TInput>
}

/** NetTransport plus an optional batched send; ZoneSession uses sendMany when present. */
export interface GroupTransport extends NetTransport {
  /** Sends the same bytes to several peers in one call; the data may be reused right after the call. */
  sendMany?(peers: readonly number[], ch: NetChannel, data: Uint8Array): void
}
