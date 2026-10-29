// The input side of one domain: a buffer per member seat and a payload ring per inbound shadow link.
// The domain may step while tick <= frontier + maxPrediction, so stalls stay per domain.
// A seat or field domain reads a shadow payload `lag` ticks after its source tick. Shadow links come in pairs, and
// without the lag each tick of one domain waits for the other's confirmation of the tick before, one network trip
// per tick. The global domain sends nothing back, so it reads events with no lag.

import { InputBuffer } from '../inputBuffer.ts'
import { SnapReader } from '../snap.ts'
import type { DomainId, DomainSpec, SeatId, ShadowView } from './types.ts'

/** Ring of shadow payloads indexed by tick; slots are reused buffers that only grow. */
export class ShadowInput {
  readonly from: DomainId
  /** The highest contiguous tick received from 0, or -1. */
  lastTick = -1
  readonly capacity: number
  private readonly bufs: Uint8Array[]
  private readonly lens: Int32Array
  private readonly ticks: Int32Array
  private readonly readers: SnapReader[]
  private readonly readerLens: Int32Array
  private static readonly emptyReader = new SnapReader(new Uint8Array(0))

  constructor(from: DomainId, capacity: number, initialBytes: number) {
    this.from = from
    const cap = Math.max(1, Math.floor(capacity))
    this.capacity = cap
    this.bufs = new Array<Uint8Array>(cap)
    this.readers = new Array<SnapReader>(cap)
    for (let i = 0; i < cap; i++) {
      this.bufs[i] = new Uint8Array(Math.max(0, initialBytes))
      this.readers[i] = new SnapReader(this.bufs[i].subarray(0, 0))
    }
    this.lens = new Int32Array(cap)
    this.ticks = new Int32Array(cap).fill(-1)
    this.readerLens = new Int32Array(cap)
  }

  /** The tick whose payload stands in for `tick`: itself when known, else the frontier. */
  private source(tick: number): number {
    const s = tick % this.capacity
    if (tick >= 0 && this.ticks[s] === tick) return tick
    const last = this.lastTick
    if (last < 0) return -1
    return this.ticks[last % this.capacity] === last ? last : -1
  }

  private equals(src: number, data: Uint8Array): boolean {
    if (src < 0) return data.byteLength === 0
    const s = src % this.capacity
    const n = this.lens[s]
    if (n !== data.byteLength) return false
    const b = this.bufs[s]
    for (let i = 0; i < n; i++) if (b[i] !== data[i]) return false
    return true
  }

  /** Stores a payload; returns `tick` when the prediction for it changed, else Infinity. */
  set(tick: number, data: Uint8Array): number {
    if (!Number.isInteger(tick) || tick < 0) return Infinity
    const cap = this.capacity
    if (tick < this.lastTick - cap + 1 || tick >= this.lastTick + cap) return Infinity
    const s = tick % cap
    if (this.ticks[s] === tick && this.equals(tick, data)) return Infinity
    const predictedSame = this.equals(this.source(tick), data)
    const n = data.byteLength
    // Grow only when a larger payload arrives; the old buffer is dropped once.
    if (this.bufs[s].byteLength < n) this.bufs[s] = new Uint8Array(n)
    this.bufs[s].set(data)
    this.lens[s] = n
    this.ticks[s] = tick
    let next = this.lastTick + 1
    while (this.ticks[next % cap] === next) {
      this.lastTick = next
      next++
    }
    return predictedSame ? Infinity : tick
  }

  /** A rewound reader over the payload used for `tick` (empty before anything is known). */
  reader(tick: number): SnapReader {
    const src = this.source(tick)
    if (src < 0) return ShadowInput.emptyReader
    const s = src % this.capacity
    const n = this.lens[s]
    let r = this.readers[s]
    // Rebuild only when the slot's view changed; otherwise rewind the cached reader.
    if (this.readerLens[s] !== n || readerBuf(r) !== this.bufs[s].buffer) {
      r = new SnapReader(this.bufs[s].subarray(0, n))
      this.readers[s] = r
      this.readerLens[s] = n
    } else {
      rewind(r)
    }
    return r
  }

  reset(): void {
    this.lastTick = -1
    this.ticks.fill(-1)
    this.lens.fill(0)
  }
}

// SnapReader has no rewind; snap.ts belongs to legacy core, so reset its cursor here.
function rewind(r: SnapReader): void {
  (r as unknown as { pos: number }).pos = 0
}

function readerBuf(r: SnapReader): ArrayBufferLike {
  return (r as unknown as { buf: Uint8Array }).buf.buffer
}

const EMPTY = new Uint8Array(0)

export interface DomainFrontierConfig {
  /** Ring length of every seat buffer and shadow input (from RollbackTuning). */
  readonly capacity: number
  /** Initial bytes of each shadow slot; slots grow on demand. */
  readonly shadowSlotBytes: number
  /** Code a seat buffer predicts before anything is known. */
  readonly neutral: number
  /** Ticks between a shadow's source tick and the tick a seat or field domain steps with it. */
  readonly shadowLag: number
}

/** Seat buffers, shadow inputs and the frontier of one domain. */
export class DomainFrontier implements ShadowView {
  readonly cfg: DomainFrontierConfig
  /** Member seats in DomainSpec.seats order, with their buffers at the same index. */
  seats: SeatId[] = []
  buffers: InputBuffer[] = []
  /** Inbound shadow inputs in ascending source-domain order. */
  shadows: ShadowInput[] = []
  /** Source tick + lag is the tick that reads a payload; the shadow rings are indexed by that tick. */
  readonly lag: number
  private viewTick = 0

  constructor(cfg: DomainFrontierConfig, spec: DomainSpec, inbound: readonly DomainId[]) {
    this.cfg = cfg
    this.lag = spec.kind === 'global' ? 0 : cfg.shadowLag
    this.rebind(spec, inbound)
  }

  /** Inbound sources of `spec`: the explicit links, plus every other domain's events into the global domain. */
  static inbound(spec: DomainSpec, links: readonly { from: DomainId, to: DomainId }[], domains: readonly DomainSpec[]): DomainId[] {
    const out: DomainId[] = []
    if (spec.kind === 'global') {
      for (let i = 0; i < domains.length; i++) if (domains[i].id !== spec.id) out.push(domains[i].id)
    }
    for (let i = 0; i < links.length; i++) {
      const l = links[i]
      if (l.to === spec.id && out.indexOf(l.from) < 0) out.push(l.from)
    }
    return out.sort((a, b) => a - b)
  }

  /** Epoch boundary: adopt a new seat list and inbound set, keeping the buffers of what stays. */
  rebind(spec: DomainSpec, inbound: readonly DomainId[]): void {
    const { capacity, neutral, shadowSlotBytes } = this.cfg
    const seats = spec.seats.slice()
    const buffers = new Array<InputBuffer>(seats.length)
    for (let i = 0; i < seats.length; i++) {
      const old = this.seats.indexOf(seats[i])
      buffers[i] = old >= 0 ? this.buffers[old] : new InputBuffer(neutral, capacity)
    }
    const sorted = inbound.slice().sort((a, b) => a - b)
    const shadows = new Array<ShadowInput>(sorted.length)
    for (let i = 0; i < sorted.length; i++) {
      let keep: ShadowInput | undefined
      for (let j = 0; j < this.shadows.length; j++) if (this.shadows[j].from === sorted[i]) keep = this.shadows[j]
      shadows[i] = keep ?? new ShadowInput(sorted[i], capacity, shadowSlotBytes)
    }
    this.seats = seats
    this.buffers = buffers
    this.shadows = shadows
  }

  /** Same as rebind; kept as the name the session uses when only sizes change. */
  resize(spec: DomainSpec, inbound: readonly DomainId[]): void {
    this.rebind(spec, inbound)
  }

  /**
   * A state starting at `start` reads no payload from before it: its first `lag` ticks hold empty payloads. They are
   * stored, not only counted below lastTick, since an unstored tick reads the newest payload once a later one arrives.
   */
  startShadows(start: number): void {
    for (let i = 0; i < this.shadows.length; i++) {
      const sh = this.shadows[i]
      sh.lastTick = start - 1
      for (let t = start; t < start + this.lag; t++) sh.set(t, EMPTY)
    }
  }

  /** Lowest contiguous confirmed tick over every input; -1 when one has nothing yet. */
  frontier(): number {
    let f = Infinity
    const b = this.buffers
    for (let i = 0; i < b.length; i++) if (b[i].lastTick < f) f = b[i].lastTick
    const s = this.shadows
    for (let i = 0; i < s.length; i++) if (s[i].lastTick < f) f = s[i].lastTick
    return f
  }

  canStep(tick: number, maxPrediction: number): boolean {
    return tick <= this.frontier() + maxPrediction
  }

  /** Stores a seat code; returns the earliest tick whose prediction changed, or Infinity. */
  setSeat(seat: SeatId, tick: number, code: number): number {
    const i = this.seats.indexOf(seat)
    if (i < 0) return Infinity
    const buf = this.buffers[i]
    const before = buf.predict(tick)
    if (!buf.set(tick, code)) return Infinity
    return before === code >>> 0 ? Infinity : tick
  }

  /** Stores the shadow payload of source tick `tick`; returns the earliest tick whose prediction changed, or Infinity. */
  setShadow(from: DomainId, tick: number, data: Uint8Array): number {
    const s = this.shadows
    for (let i = 0; i < s.length; i++) if (s[i].from === from) return s[i].set(tick + this.lag, data)
    return Infinity
  }

  /** Fills `out` (spec.seats order) with the codes used to step `tick`. */
  inputs(tick: number, out: number[]): number[] {
    const b = this.buffers
    out.length = b.length
    for (let i = 0; i < b.length; i++) out[i] = b[i].predict(tick)
    return out
  }

  /** Points the ShadowView at `tick` and returns this; valid until the next call. */
  view(tick: number): ShadowView {
    this.viewTick = tick
    return this
  }

  get count(): number {
    return this.shadows.length
  }

  fromDomain(i: number): DomainId {
    return this.shadows[i].from
  }

  reader(i: number): SnapReader {
    return this.shadows[i].reader(this.viewTick)
  }
}
