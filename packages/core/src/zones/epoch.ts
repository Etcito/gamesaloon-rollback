// The epoch boundary S = E*K, as pure logic: the confirmed control words assign() samples at S-L, and the plan that
// tells the local peer which domains continue, rebuild, travel by DOMAIN_SNAPSHOT or drop. session.ts applies it.

import { CONTROL_BITS, CONTROL_NO_CELL } from './control.ts'
import type { Assignment, ControlSample, DomainId, DomainSpec, SeatId } from './types.ts'
import type { ZoneTuning } from './tuning.ts'

/** An observer's word: no cell, every class zero. */
const OBSERVER_WORD = (CONTROL_NO_CELL << CONTROL_BITS.cell.shift) >>> 0
/** i32 sentinel for an empty ring slot; no real tick reaches it. */
const EMPTY_TICK = -0x80000000

/** The tick whose confirmed control words decide epoch E. */
export function sampleTickOf(epoch: number, tuning: ZoneTuning): number {
  return epoch * tuning.epochTicks - tuning.leadTicks
}

/**
 * Confirmed control words per seat by tick. The ring spans leadTicks plus one epoch: a word arrives at most that far
 * ahead of the sampling tick that still needs it. A seat is expected by default; a seat that is not expected (its
 * peer dropped or never played) does not hold up confirmation.
 */
export class ControlStore {
  readonly seatCount: number
  readonly size: number
  private readonly tuning: ZoneTuning
  private readonly words: Uint32Array
  private readonly ticks: Int32Array
  private readonly expected: Uint8Array
  private readonly out: { epoch: number; words: Uint32Array }

  constructor(seatCount: number, tuning: ZoneTuning) {
    this.seatCount = seatCount
    this.tuning = tuning
    this.size = tuning.leadTicks + tuning.epochTicks
    this.words = new Uint32Array(this.size * seatCount)
    this.ticks = new Int32Array(this.size * seatCount).fill(EMPTY_TICK)
    this.expected = new Uint8Array(seatCount).fill(1)
    this.out = { epoch: 0, words: new Uint32Array(seatCount).fill(OBSERVER_WORD) }
  }

  private slot(seat: SeatId, tick: number): number {
    return (((tick % this.size) + this.size) % this.size) * this.seatCount + seat
  }

  /** Whether confirmation of a sampling tick waits for this seat's word. */
  expect(seat: SeatId, on: boolean): void {
    if (seat >= 0 && seat < this.seatCount) this.expected[seat] = on ? 1 : 0
  }

  /** Stores a confirmed word. A tick older than one the slot already holds is ignored. */
  set(seat: SeatId, tick: number, word: number): void {
    if (seat < 0 || seat >= this.seatCount) return
    const i = this.slot(seat, tick)
    if (this.ticks[i] > tick) return
    this.ticks[i] = tick
    this.words[i] = word >>> 0
  }

  /** The confirmed word of a seat at exactly this tick, or -1. */
  get(seat: SeatId, tick: number): number {
    if (seat < 0 || seat >= this.seatCount) return -1
    const i = this.slot(seat, tick)
    return this.ticks[i] === tick ? this.words[i] : -1
  }

  /** Every expected seat has its confirmed word at `tick`. */
  confirmedAt(tick: number): boolean {
    for (let s = 0; s < this.seatCount; s++) {
      if (this.expected[s] === 1 && this.ticks[this.slot(s, tick)] !== tick) return false
    }
    return true
  }

  /** Every expected word that epoch E samples is confirmed. */
  ready(epoch: number): boolean {
    return this.confirmedAt(sampleTickOf(epoch, this.tuning))
  }

  /**
   * Fills the reused sample for epoch E. A seat takes its word at the sampling tick, else its latest word before it
   * still in the ring, else the observer word. The returned object is overwritten by the next call.
   */
  sample(epoch: number): ControlSample {
    const tick = sampleTickOf(epoch, this.tuning)
    this.out.epoch = epoch
    for (let s = 0; s < this.seatCount; s++) {
      let word = OBSERVER_WORD
      let best = EMPTY_TICK
      for (let k = 0; k < this.size; k++) {
        const i = k * this.seatCount + s
        const t = this.ticks[i]
        if (t <= tick && t > best) {
          best = t
          word = this.words[i]
        }
      }
      this.out.words[s] = word
    }
    return this.out
  }
}

/** One seat changing domain at the boundary; -1 is no domain (observer, or no previous epoch). */
export interface SeatMove {
  readonly seat: SeatId
  readonly from: DomainId
  readonly to: DomainId
}

/** A new domain the local peer replicates and rebuilds from sources it holds. */
export interface DomainRebuild {
  readonly domain: DomainId
  /** Old domains sharing a seat or cell with it, ascending. */
  readonly sources: DomainId[]
  /** The only source is the same domain with the same seats and cells (or the global domain): keep the running sim. */
  readonly inPlace: boolean
}

/**
 * A DOMAIN_SNAPSHOT sent at S. `source === domain`: the sender is a new replica holding every source and sends the
 * new domain whole. Otherwise no new replica holds every source, and the sender sends that one source's export.
 */
export interface DomainTransfer {
  readonly domain: DomainId
  readonly source: DomainId
  readonly sender: number
  /** New replicas that lack it, ascending. */
  readonly targets: number[]
}

/** A new domain the local peer replicates but cannot build alone. */
export interface DomainReceive {
  readonly domain: DomainId
  readonly sources: DomainId[]
  /** What arrives: one whole transfer, or one per source the local peer lacks; the other sources are local. */
  readonly transfers: DomainTransfer[]
}

/** What the local peer does at S = E*K. Every list is in ascending domain id (then source) order. */
export interface EpochPlan {
  readonly epoch: number
  readonly tick: number
  /** Old domains in `drop` are kept until this tick, then dropped. */
  readonly dropTick: number
  /** Same id, seats, cells and replica set. */
  readonly continued: DomainId[]
  /** No source at all: factory.create. */
  readonly create: DomainId[]
  readonly rebuild: DomainRebuild[]
  readonly receive: DomainReceive[]
  readonly send: DomainTransfer[]
  /** Old domains the local peer held that neither continue nor stay in place. */
  readonly drop: DomainId[]
  readonly moves: SeatMove[]
}

function sameMembers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (const x of a) if (!b.includes(x)) return false
  return true
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Old non-global domains sharing a seat or cell with `spec`; the global domain's only source is the old global. */
function sourcesOf(spec: DomainSpec, prev: Assignment, cellOwners: Map<number, DomainId[]>, prevById: Map<DomainId, DomainSpec>): DomainId[] {
  if (spec.kind === 'global') return prevById.has(spec.id) ? [spec.id] : []
  const out: DomainId[] = []
  for (const s of spec.seats) {
    const d = s < prev.seatDomain.length ? prev.seatDomain[s] : -1
    if (d > 0 && !out.includes(d)) out.push(d)
  }
  for (const c of spec.cells) {
    const owners = cellOwners.get(c)
    if (owners !== undefined) for (const d of owners) if (!out.includes(d)) out.push(d)
  }
  return out.sort((a, b) => a - b)
}

/** The lowest-ranked (last) peer of `order` that passes `ok`, or -1. */
function lowestRanked(order: readonly number[], ok: (peer: number) => boolean): number {
  for (let i = order.length - 1; i >= 0; i--) if (ok(order[i])) return order[i]
  return -1
}

/** Seats whose domain differs between two assignments, ascending seat. */
export function seatMoves(prev: Assignment | null, next: Assignment): SeatMove[] {
  const moves: SeatMove[] = []
  for (let s = 0; s < next.seatDomain.length; s++) {
    const from = prev !== null && s < prev.seatDomain.length ? prev.seatDomain[s] : -1
    const to = next.seatDomain[s]
    if (from !== to) moves.push({ seat: s, from, to })
  }
  return moves
}

/**
 * The local peer's plan for the boundary from `prev` to `next` (both from assign()). A source of a new domain is an
 * old domain sharing a seat or cell with it. A new replica that lacks a source is sent the domain whole by the
 * lowest-ranked new replica holding every source; when no new replica holds them all, each lacking source is sent
 * by its own lowest-ranked live old replica. Every peer computes the same transfers, so senders and receivers agree.
 */
export function planEpoch(prev: Assignment | null, next: Assignment, local: number, tuning: ZoneTuning): EpochPlan {
  const tick = next.epoch * tuning.epochTicks
  const plan: EpochPlan = {
    epoch: next.epoch,
    tick,
    dropTick: tick + tuning.handoffGraceTicks,
    continued: [],
    create: [],
    rebuild: [],
    receive: [],
    send: [],
    drop: [],
    moves: seatMoves(prev, next),
  }

  const prevById = new Map<DomainId, DomainSpec>()
  const cellOwners = new Map<number, DomainId[]>()
  if (prev !== null) {
    for (const d of prev.domains) {
      prevById.set(d.id, d)
      if (d.kind === 'global') continue
      for (const c of d.cells) {
        const owners = cellOwners.get(c)
        if (owners === undefined) cellOwners.set(c, [d.id])
        else owners.push(d.id)
      }
    }
  }
  // The global domain is replicated by every live peer.
  const liveSpec = next.domains.find((d) => d.kind === 'global')
  const live = (p: number): boolean => liveSpec !== undefined && liveSpec.replicas.includes(p)
  const holds = (peer: number, src: DomainId): boolean => prevById.get(src)!.replicas.includes(peer)
  const kept = new Set<DomainId>()

  for (const spec of next.domains) {
    const old = prevById.get(spec.id)
    const replica = spec.replicas.includes(local)
    if (old !== undefined && sameList(old.seats, spec.seats) && sameList(old.cells, spec.cells) && sameMembers(old.replicas, spec.replicas)) {
      if (replica) plan.continued.push(spec.id)
      kept.add(spec.id)
      continue
    }
    const sources = prev === null ? [] : sourcesOf(spec, prev, cellOwners, prevById)
    if (sources.length === 0) {
      if (replica) plan.create.push(spec.id)
      continue
    }
    const holdsAll = (peer: number): boolean => sources.every((src) => holds(peer, src))

    const transfers: DomainTransfer[] = []
    const lacking = spec.replicas.filter((p) => !holdsAll(p)).sort((a, b) => a - b)
    if (lacking.length > 0) {
      const whole = lowestRanked(spec.replicas, holdsAll)
      if (whole >= 0) {
        transfers.push({ domain: spec.id, source: spec.id, sender: whole, targets: lacking })
      } else {
        for (const src of sources) {
          const targets = lacking.filter((p) => !holds(p, src))
          if (targets.length === 0) continue
          // A source with no live replica left is lost; the domain is built from the others.
          const sender = lowestRanked(prevById.get(src)!.replicas, live)
          if (sender >= 0) transfers.push({ domain: spec.id, source: src, sender, targets })
        }
      }
    }
    for (const t of transfers) if (t.sender === local) plan.send.push(t)

    if (!replica) continue
    if (holdsAll(local)) {
      const inPlace = old !== undefined && sources.length === 1 && sources[0] === spec.id &&
        (spec.kind === 'global' || (sameList(old.seats, spec.seats) && sameList(old.cells, spec.cells)))
      if (inPlace) kept.add(spec.id)
      plan.rebuild.push({ domain: spec.id, sources, inPlace })
    } else {
      plan.receive.push({ domain: spec.id, sources, transfers: transfers.filter((t) => t.targets.includes(local)) })
    }
  }

  if (prev !== null) {
    for (const d of prev.domains) if (d.replicas.includes(local) && !kept.has(d.id)) plan.drop.push(d.id)
  }
  return plan
}
