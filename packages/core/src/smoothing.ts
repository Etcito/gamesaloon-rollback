// Rollback correction smoothing: after a re-simulation moves an entity, the displayed pose keeps the old one and
// decays toward the simulated one. VIEW SIDE ONLY: it reads simulation state and never feeds back into it, so it may
// use Math.exp. No allocation after construction.
//
// The smoothed quantities are plain linear floats (positions, scalar angles that do not wrap...). Rotations as
// quaternions are a game concern: expose them as extra floats if a small-angle linear blend is acceptable.
import type { SimView } from './types.ts'

/** Exponential decay rate of the offsets (1/s). */
export const DECAY_RATE = 10
/** An entity whose offset vector is longer than this snaps to its simulated pose. In view units. */
export const SNAP_DIST = 6

export class CorrectionSmoother {
  readonly entities: number
  readonly stride: number
  readonly decayRate: number
  readonly snapDist: number
  private readonly captured: Float64Array
  private readonly current: Float64Array
  private readonly offset: Float64Array

  constructor(entities: number, stride: number, decayRate = DECAY_RATE, snapDist = SNAP_DIST) {
    this.entities = entities
    this.stride = stride
    this.decayRate = decayRate
    this.snapDist = snapDist
    this.captured = new Float64Array(entities * stride)
    this.current = new Float64Array(entities * stride)
    this.offset = new Float64Array(entities * stride)
  }

  /** Stores the displayed pose before a rollback. */
  capture(view: SimView): void {
    view.read(this.captured)
  }

  /** After re-simulation: offset += captured - new. An entity that moved further than snapDist is not smoothed. */
  settle(view: SimView): void {
    view.read(this.current)
    const s = this.stride
    const lim = this.snapDist * this.snapDist
    for (let e = 0; e < this.entities; e++) {
      const b = e * s
      let d2 = 0
      for (let i = 0; i < s; i++) {
        const o = this.offset[b + i] + this.captured[b + i] - this.current[b + i]
        this.offset[b + i] = o
        d2 += o * o
      }
      if (!(d2 <= lim)) this.reset(e)
    }
  }

  /** Decays every offset by exp(-decayRate * frameDt). */
  decay(frameDt: number): void {
    if (!(frameDt > 0)) return
    const f = Math.exp(-this.decayRate * frameDt)
    const o = this.offset
    for (let i = 0; i < o.length; i++) o[i] *= f
  }

  /** Adds the offsets to `pose` (entities * stride floats, the layout of SimView.read) in place. */
  apply(pose: Float64Array): void {
    const o = this.offset
    const n = o.length < pose.length ? o.length : pose.length
    for (let i = 0; i < n; i++) pose[i] += o[i]
  }

  /** Adds entity e's offset to out[0..stride). */
  applyEntity(e: number, out: Float64Array | number[]): void {
    if (e < 0 || e >= this.entities) return
    const b = e * this.stride
    for (let i = 0; i < this.stride; i++) out[i] += this.offset[b + i]
  }

  /** Zeroes one entity's offset. */
  reset(e: number): void {
    const b = e * this.stride
    for (let i = 0; i < this.stride; i++) this.offset[b + i] = 0
  }

  /** Zeroes every offset. */
  clear(): void {
    this.offset.fill(0)
  }
}
