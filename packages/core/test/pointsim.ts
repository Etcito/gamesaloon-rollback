// Reference simulation for the tests: N point masses in a bounded square arena, integer math only, driven by input
// bitmasks. Players interact (colliding masses swap velocities) and a seeded wind couples everybody, so a wrong
// prediction for one player changes the others and rollback is really exercised.
import { Rng, SnapReader, SnapWriter } from '../src/index.ts'
import type { InputCodec, SimView, Simulation } from '../src/index.ts'

export const LEFT = 1
export const RIGHT = 2
export const UP = 4
export const DOWN = 8
export const BOOST = 16

export interface PointInput {
  mask: number
}

export const pointCodec: InputCodec<PointInput> = {
  create: () => ({ mask: 0 }),
  encode: (i) => i.mask & 0x1f,
  decode: (code, out) => {
    out.mask = code & 0x1f
    return out
  },
  neutral: 0,
}

const WORLD = 20000
const RADIUS = 600

export class PointSim implements Simulation<PointInput> {
  tick = 0
  readonly n: number
  readonly x: Int32Array
  readonly y: Int32Array
  readonly vx: Int32Array
  readonly vy: Int32Array
  readonly dead: Uint8Array
  private rng: Rng
  /** Not simulation state: counts playerDropped calls (test observation only). */
  droppedCalls = 0
  /** Not simulation state: counts muted re-simulations. */
  resims = 0
  readonly view: SimView
  hash?: () => number

  constructor(n: number, seed: number, provideHash = false) {
    this.n = n
    this.x = new Int32Array(n)
    this.y = new Int32Array(n)
    this.vx = new Int32Array(n)
    this.vy = new Int32Array(n)
    this.dead = new Uint8Array(n)
    this.rng = new Rng(seed)
    for (let i = 0; i < n; i++) {
      this.x[i] = this.rng.int(-WORLD / 2, WORLD / 2)
      this.y[i] = this.rng.int(-WORLD / 2, WORLD / 2)
    }
    const self = this
    this.view = {
      entities: n,
      stride: 2,
      read(out: Float64Array): void {
        for (let i = 0; i < n; i++) {
          out[i * 2] = self.x[i]
          out[i * 2 + 1] = self.y[i]
        }
      },
    }
    if (provideHash) this.hash = () => this.stateHash()
  }

  step(inputs: readonly PointInput[]): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      if (this.dead[i]) continue
      const m = inputs[i].mask
      const ax = (m & RIGHT ? 1 : 0) - (m & LEFT ? 1 : 0)
      const ay = (m & DOWN ? 1 : 0) - (m & UP ? 1 : 0)
      const k = m & BOOST ? 5 : 2
      this.vx[i] = (this.vx[i] + ax * k) | 0
      this.vy[i] = (this.vy[i] + ay * k) | 0
    }
    // Seeded wind every 32 ticks: applies to everybody.
    if ((this.tick & 31) === 0) {
      const wx = this.rng.int(-3, 3)
      const wy = this.rng.int(-3, 3)
      for (let i = 0; i < n; i++) {
        this.vx[i] = (this.vx[i] + wx) | 0
        this.vy[i] = (this.vy[i] + wy) | 0
      }
    }
    for (let i = 0; i < n; i++) {
      this.vx[i] -= this.vx[i] >> 4
      this.vy[i] -= this.vy[i] >> 4
      this.x[i] = (this.x[i] + this.vx[i]) | 0
      this.y[i] = (this.y[i] + this.vy[i]) | 0
      if (this.x[i] > WORLD || this.x[i] < -WORLD) {
        this.x[i] = this.x[i] > 0 ? WORLD : -WORLD
        this.vx[i] = -this.vx[i]
      }
      if (this.y[i] > WORLD || this.y[i] < -WORLD) {
        this.y[i] = this.y[i] > 0 ? WORLD : -WORLD
        this.vy[i] = -this.vy[i]
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = this.x[j] - this.x[i]
        const dy = this.y[j] - this.y[i]
        if (dx < RADIUS && dx > -RADIUS && dy < RADIUS && dy > -RADIUS) {
          const tx = this.vx[i]
          const ty = this.vy[i]
          this.vx[i] = this.vx[j]
          this.vy[i] = this.vy[j]
          this.vx[j] = tx
          this.vy[j] = ty
        }
      }
    }
    this.tick++
  }

  snapshot(w: SnapWriter): void {
    w.u32(this.tick)
    w.u32(this.rng.state)
    for (let i = 0; i < this.n; i++) {
      w.i32(this.x[i])
      w.i32(this.y[i])
      w.i32(this.vx[i])
      w.i32(this.vy[i])
      w.u8(this.dead[i])
    }
  }

  restore(r: SnapReader): void {
    this.tick = r.u32()
    this.rng.state = r.u32()
    for (let i = 0; i < this.n; i++) {
      this.x[i] = r.i32()
      this.y[i] = r.i32()
      this.vx[i] = r.i32()
      this.vy[i] = r.i32()
      this.dead[i] = r.u8()
    }
  }

  playerDropped(player: number): void {
    this.dead[player] = 1
    this.vx[player] = 0
    this.vy[player] = 0
    this.droppedCalls++
  }

  beginResim(): void {
    this.resims++
  }

  private stateHash(): number {
    let h = 0x811c9dc5 ^ this.rng.state
    for (let i = 0; i < this.n; i++) {
      h = Math.imul(h ^ this.x[i], 0x01000193)
      h = Math.imul(h ^ this.y[i], 0x01000193)
      h = Math.imul(h ^ this.vx[i], 0x01000193)
      h = Math.imul(h ^ this.vy[i], 0x01000193)
      h = Math.imul(h ^ this.dead[i], 0x01000193)
    }
    return Math.imul(h ^ this.tick, 0x01000193) >>> 0
  }
}
