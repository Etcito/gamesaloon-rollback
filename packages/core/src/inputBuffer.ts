// Per-player ring of input codes for the rollback session. Pure.
// Each slot stores its code and the tick it belongs to, so a stale slot is
// never read as a newer tick. No allocation after construction.
export class InputBuffer {
  /** The highest contiguous tick known from 0, or -1. */
  lastTick = -1
  readonly capacity: number
  /** The code predicted before anything is known. */
  readonly neutral: number
  private readonly codes: Uint32Array
  private readonly ticks: Int32Array

  constructor(neutral: number, capacity = 256) {
    this.neutral = neutral >>> 0
    const cap = Math.max(1, Math.floor(capacity))
    this.capacity = cap
    this.codes = new Uint32Array(cap)
    this.ticks = new Int32Array(cap).fill(-1)
  }

  private slot(tick: number): number {
    return tick % this.capacity
  }

  /** Stores a code. True when the tick was new or its code changed; false when ignored or unchanged. */
  set(tick: number, code: number): boolean {
    if (!Number.isInteger(tick) || tick < 0) return false
    const cap = this.capacity
    if (tick < this.lastTick - cap + 1 || tick >= this.lastTick + cap) return false
    const s = this.slot(tick)
    const c = code >>> 0
    if (this.ticks[s] === tick) {
      if (this.codes[s] === c) return false
    } else {
      this.ticks[s] = tick
    }
    this.codes[s] = c
    // Advance the contiguous frontier while the next tick is present.
    let next = this.lastTick + 1
    while (this.ticks[this.slot(next)] === next) {
      this.lastTick = next
      next++
    }
    return true
  }

  /** The stored code of a tick, or undefined when unknown or overwritten. */
  get(tick: number): number | undefined {
    if (!Number.isInteger(tick) || tick < 0) return undefined
    const s = this.slot(tick)
    return this.ticks[s] === tick ? this.codes[s] : undefined
  }

  /** The code at min(tick, lastTick); this.neutral when nothing is known yet. */
  predict(tick: number): number {
    const last = this.lastTick
    if (last < 0) return this.neutral
    const t = tick < last ? tick : last
    if (t < 0) return this.neutral
    const s = this.slot(t)
    if (this.ticks[s] === t) return this.codes[s]
    // Older than the ring: the frontier code is the best prediction left.
    return this.codes[this.slot(last)]
  }

  /** Forgets every stored tick. */
  reset(): void {
    this.lastTick = -1
    this.ticks.fill(-1)
    this.codes.fill(0)
  }
}
