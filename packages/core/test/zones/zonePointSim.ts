// Zoned reference simulation: the point masses of test/pointsim.ts split into domains. Integer math only. Each domain
// owns the points of its seats (id = seat) and of its field cells (ids above seatCount); boundary points of the
// neighbour domains arrive as read-only ghosts through the shadows. The global domain only keeps an event ledger.
import { Rng, SnapReader, SnapWriter } from '../../src/index.ts'
import type { SimView } from '../../src/index.ts'
import type { DomainFactory, DomainId, DomainSim, DomainSpec, SeatId, ShadowView, SleepEvent } from '../../src/zones/types.ts'
import { LEFT, RIGHT, UP, DOWN, BOOST } from '../pointsim.ts'
import type { InputCodec } from '../../src/index.ts'
import type { PointInput } from '../pointsim.ts'

export interface ZonePointOptions {
  seatCount: number
  gridCols: number
  gridRows: number
  cellSize: number
  /** Field points per cell of a field domain. */
  fieldPerCell: number
  windEvery: number
  windMag: number
  radius: number
  /** Speeds below this snap to 0, so points can come to rest. */
  stopBelow: number
  sleepTicks: number
  /** Boundary width in cells for shadowOut. */
  shadowMargin: number
  /** A point crossing this y upward emits a goal event. */
  goalY: number
  maxGhosts: number
  maxEvents: number
  /** Event kinds the global ledger counts. */
  eventKinds: number
}

export const EVENT_GOAL = 0

const FNV = 0x01000193

function mix(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), FNV)
  h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV)
  h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV)
  return Math.imul(h ^ (v >>> 24), FNV)
}

interface MutSleep { id: number; tick: number; asleep: boolean }

export class ZonePointSim implements DomainSim<PointInput> {
  tick: number
  readonly spec: DomainSpec
  readonly opts: ZonePointOptions
  n = 0
  readonly id: Uint32Array
  readonly x: Int32Array
  readonly y: Int32Array
  readonly vx: Int32Array
  readonly vy: Int32Array
  readonly asleep: Uint8Array
  readonly sleepTick: Int32Array
  readonly still: Int32Array
  /** Global ledger: a count per event kind and a running digest. */
  readonly ledger: Uint32Array
  digest = 0x811c9dc5
  readonly host: Int16Array
  readonly bot: Uint8Array
  /** Not simulation state: counts resims (test observation only). */
  resims = 0
  readonly view: SimView
  /** Public so a rebuild can derive it from (domain id, tick). */
  rng: Rng
  private seatIndex: Int32Array
  private wind: Int32Array
  private gx: Int32Array
  private gy: Int32Array
  private gvx: Int32Array
  private gvy: Int32Array
  private evId: Uint32Array
  private evN = 0
  private sleepPool: MutSleep[] = []
  private sleepN = 0
  private minCol = 0
  private maxCol = 0
  private minRow = 0
  private maxRow = 0

  constructor(spec: DomainSpec, tick: number, opts: ZonePointOptions, extraCap = 0) {
    this.spec = spec
    this.tick = tick
    this.opts = opts
    const cap = spec.kind === 'global' ? 0 : spec.seats.length + spec.cells.length * opts.fieldPerCell + extraCap
    this.id = new Uint32Array(cap)
    this.x = new Int32Array(cap)
    this.y = new Int32Array(cap)
    this.vx = new Int32Array(cap)
    this.vy = new Int32Array(cap)
    this.asleep = new Uint8Array(cap)
    this.sleepTick = new Int32Array(cap)
    this.still = new Int32Array(cap)
    this.ledger = new Uint32Array(opts.eventKinds)
    this.host = new Int16Array(opts.seatCount).fill(-1)
    this.bot = new Uint8Array(opts.seatCount)
    this.seatIndex = new Int32Array(spec.seats.length)
    this.wind = new Int32Array(spec.cells.length * 2)
    this.gx = new Int32Array(opts.maxGhosts)
    this.gy = new Int32Array(opts.maxGhosts)
    this.gvx = new Int32Array(opts.maxGhosts)
    this.gvy = new Int32Array(opts.maxGhosts)
    this.evId = new Uint32Array(opts.maxEvents)
    for (let i = 0; i < cap; i++) this.sleepPool.push({ id: 0, tick: 0, asleep: false })
    let seed = mix(0x811c9dc5, spec.id)
    for (const c of spec.cells) seed = mix(seed, c)
    this.rng = new Rng(seed)
    if (spec.cells.length > 0) {
      this.minCol = this.minRow = 0xffff
      for (const c of spec.cells) {
        const col = c % opts.gridCols
        const row = (c / opts.gridCols) | 0
        if (col < this.minCol) this.minCol = col
        if (col > this.maxCol) this.maxCol = col
        if (row < this.minRow) this.minRow = row
        if (row > this.maxRow) this.maxRow = row
      }
    }
    if (spec.kind !== 'global') {
      // Ids ascending: seats first (id < seatCount), then field ids above seatCount.
      const seats = spec.seats.slice().sort((a, b) => a - b)
      for (const s of seats) this.place(s, -1)
      if (spec.kind === 'field') {
        const cells = spec.cells.slice().sort((a, b) => a - b)
        for (const c of cells) {
          for (let k = 0; k < opts.fieldPerCell; k++) this.place(opts.seatCount + c * opts.fieldPerCell + k, c)
        }
      }
      this.indexSeats()
    }
    const self = this
    this.view = {
      get entities() { return self.n },
      stride: 2,
      read(out: Float64Array): void {
        for (let i = 0; i < self.n; i++) {
          out[i * 2] = self.x[i]
          out[i * 2 + 1] = self.y[i]
        }
      },
    }
  }

  /** Deterministic start position: inside `cell`, or anywhere in the grid for a seat point. */
  private place(id: number, cell: number): void {
    const o = this.opts
    const r = new Rng(mix(0x811c9dc5, id))
    const i = this.n++
    this.id[i] = id
    if (cell < 0) {
      this.x[i] = r.int(0, o.gridCols * o.cellSize - 1)
      this.y[i] = r.int(0, o.gridRows * o.cellSize - 1)
    } else {
      this.x[i] = (cell % o.gridCols) * o.cellSize + r.int(0, o.cellSize - 1)
      this.y[i] = ((cell / o.gridCols) | 0) * o.cellSize + r.int(0, o.cellSize - 1)
    }
  }

  private indexSeats(): void {
    for (let s = 0; s < this.spec.seats.length; s++) {
      this.seatIndex[s] = -1
      for (let i = 0; i < this.n; i++) if (this.id[i] === this.spec.seats[s]) this.seatIndex[s] = i
    }
  }

  /** Replaces the entities with the merge of exportEntities readers (ascending id), as DomainFactory.rebuild does. */
  loadEntities(sources: SnapReader[]): void {
    this.n = 0
    for (const r of sources) {
      const m = r.u32()
      for (let k = 0; k < m; k++) {
        let i = this.n++
        const id = r.u32()
        while (i > 0 && this.id[i - 1] > id) {
          this.copy(i - 1, i)
          i--
        }
        this.id[i] = id
        this.x[i] = r.i32()
        this.y[i] = r.i32()
        this.vx[i] = r.i32()
        this.vy[i] = r.i32()
        this.asleep[i] = r.u8()
        this.sleepTick[i] = r.i32()
        this.still[i] = 0
      }
    }
    this.indexSeats()
  }

  private copy(a: number, b: number): void {
    this.id[b] = this.id[a]
    this.x[b] = this.x[a]
    this.y[b] = this.y[a]
    this.vx[b] = this.vx[a]
    this.vy[b] = this.vy[a]
    this.asleep[b] = this.asleep[a]
    this.sleepTick[b] = this.sleepTick[a]
    this.still[b] = this.still[a]
  }

  cellOf(i: number): number {
    const o = this.opts
    let col = Math.floor(this.x[i] / o.cellSize)
    let row = Math.floor(this.y[i] / o.cellSize)
    col = col < 0 ? 0 : col >= o.gridCols ? o.gridCols - 1 : col
    row = row < 0 ? 0 : row >= o.gridRows ? o.gridRows - 1 : row
    return row * o.gridCols + col
  }

  private wake(i: number): void {
    if (!this.asleep[i]) return
    this.asleep[i] = 0
    this.still[i] = 0
    this.pushSleep(this.id[i], false)
  }

  private pushSleep(id: number, asleep: boolean): void {
    if (this.sleepN >= this.sleepPool.length) return
    const e = this.sleepPool[this.sleepN++]
    e.id = id
    e.tick = this.tick
    e.asleep = asleep
  }

  step(inputs: readonly PointInput[], shadows: ShadowView): void {
    this.sleepN = 0
    this.evN = 0
    if (this.spec.kind === 'global') {
      this.stepGlobal(shadows)
      this.tick++
      return
    }
    const o = this.opts
    const n = this.n
    for (let s = 0; s < this.spec.seats.length; s++) {
      const i = this.seatIndex[s]
      if (i < 0) continue
      const m = inputs[s].mask
      if (m === 0) continue
      this.wake(i)
      const ax = (m & RIGHT ? 1 : 0) - (m & LEFT ? 1 : 0)
      const ay = (m & DOWN ? 1 : 0) - (m & UP ? 1 : 0)
      const k = m & BOOST ? 5 : 2
      this.vx[i] = (this.vx[i] + ax * k) | 0
      this.vy[i] = (this.vy[i] + ay * k) | 0
    }
    // Local wind per cell, from this domain's own Rng.
    if (this.tick % o.windEvery === 0) {
      const cells = this.spec.cells
      for (let c = 0; c < cells.length; c++) {
        this.wind[c * 2] = this.rng.int(-o.windMag, o.windMag)
        this.wind[c * 2 + 1] = this.rng.int(-o.windMag, o.windMag)
      }
      for (let i = 0; i < n; i++) {
        if (this.asleep[i]) continue
        const c = cells.indexOf(this.cellOf(i))
        if (c < 0) continue
        this.vx[i] = (this.vx[i] + this.wind[c * 2]) | 0
        this.vy[i] = (this.vy[i] + this.wind[c * 2 + 1]) | 0
      }
    }
    const maxX = o.gridCols * o.cellSize
    const maxY = o.gridRows * o.cellSize
    for (let i = 0; i < n; i++) {
      if (this.asleep[i]) continue
      this.vx[i] -= this.vx[i] >> 4
      this.vy[i] -= this.vy[i] >> 4
      if (this.vx[i] < o.stopBelow && this.vx[i] > -o.stopBelow) this.vx[i] = 0
      if (this.vy[i] < o.stopBelow && this.vy[i] > -o.stopBelow) this.vy[i] = 0
      const py = this.y[i]
      this.x[i] = (this.x[i] + this.vx[i]) | 0
      this.y[i] = (this.y[i] + this.vy[i]) | 0
      if (this.x[i] >= maxX || this.x[i] < 0) {
        this.x[i] = this.x[i] < 0 ? 0 : maxX - 1
        this.vx[i] = -this.vx[i]
      }
      if (this.y[i] >= maxY || this.y[i] < 0) {
        this.y[i] = this.y[i] < 0 ? 0 : maxY - 1
        this.vy[i] = -this.vy[i]
      }
      if (py < o.goalY && this.y[i] >= o.goalY && this.evN < o.maxEvents) this.evId[this.evN++] = this.id[i]
    }
    const r = o.radius
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = this.x[j] - this.x[i]
        const dy = this.y[j] - this.y[i]
        if (dx < r && dx > -r && dy < r && dy > -r) {
          if (this.asleep[i] && this.asleep[j]) continue
          this.wake(i)
          this.wake(j)
          const tx = this.vx[i]
          const ty = this.vy[i]
          this.vx[i] = this.vx[j]
          this.vy[i] = this.vy[j]
          this.vx[j] = tx
          this.vy[j] = ty
        }
      }
    }
    // Ghosts from the shadows are read-only: only the local point takes the ghost's velocity.
    let g = 0
    for (let s = 0; s < shadows.count; s++) {
      const rd = shadows.reader(s)
      const m = rd.u16()
      for (let k = 0; k < m; k++) {
        rd.u32()
        const gx = rd.i32()
        const gy = rd.i32()
        const gvx = rd.i32()
        const gvy = rd.i32()
        if (g < o.maxGhosts) {
          this.gx[g] = gx
          this.gy[g] = gy
          this.gvx[g] = gvx
          this.gvy[g] = gvy
          g++
        }
      }
    }
    for (let k = 0; k < g; k++) {
      for (let i = 0; i < n; i++) {
        const dx = this.gx[k] - this.x[i]
        const dy = this.gy[k] - this.y[i]
        if (dx < r && dx > -r && dy < r && dy > -r && (this.gvx[k] !== 0 || this.gvy[k] !== 0)) {
          this.wake(i)
          this.vx[i] = this.gvx[k]
          this.vy[i] = this.gvy[k]
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.asleep[i]) continue
      if (this.vx[i] === 0 && this.vy[i] === 0) {
        if (++this.still[i] >= o.sleepTicks) {
          this.asleep[i] = 1
          this.sleepTick[i] = this.tick
          this.pushSleep(this.id[i], true)
        }
      } else this.still[i] = 0
    }
    this.tick++
  }

  /** Shadows into the global domain carry events(): u16 n, then (kind u8, id u32, tick i32). */
  private stepGlobal(shadows: ShadowView): void {
    for (let s = 0; s < shadows.count; s++) {
      const rd = shadows.reader(s)
      const m = rd.u16()
      for (let k = 0; k < m; k++) {
        const kind = rd.u8()
        const id = rd.u32()
        const t = rd.i32()
        if (kind < this.ledger.length) this.ledger[kind]++
        this.digest = mix(mix(mix(this.digest, kind), id), t)
      }
    }
  }

  snapshot(w: SnapWriter): void {
    w.i32(this.tick)
    w.u32(this.rng.state)
    w.u32(this.digest)
    for (let k = 0; k < this.ledger.length; k++) w.u32(this.ledger[k])
    w.u32(this.n)
    for (let i = 0; i < this.n; i++) {
      w.u32(this.id[i])
      w.i32(this.x[i])
      w.i32(this.y[i])
      w.i32(this.vx[i])
      w.i32(this.vy[i])
      w.u8(this.asleep[i])
      w.i32(this.sleepTick[i])
      w.i32(this.still[i])
    }
  }

  restore(r: SnapReader): void {
    this.tick = r.i32()
    this.rng.state = r.u32()
    this.digest = r.u32()
    for (let k = 0; k < this.ledger.length; k++) this.ledger[k] = r.u32()
    this.n = r.u32()
    for (let i = 0; i < this.n; i++) {
      this.id[i] = r.u32()
      this.x[i] = r.i32()
      this.y[i] = r.i32()
      this.vx[i] = r.i32()
      this.vy[i] = r.i32()
      this.asleep[i] = r.u8()
      this.sleepTick[i] = r.i32()
      this.still[i] = r.i32()
    }
    this.indexSeats()
  }

  hash(): number {
    if (this.spec.kind === 'global') {
      let h = 0x811c9dc5
      for (let k = 0; k < this.ledger.length; k++) h = mix(h, this.ledger[k])
      return mix(h, this.digest) >>> 0
    }
    let h = 0x811c9dc5
    let sd = 0x811c9dc5
    for (let i = 0; i < this.n; i++) {
      if (this.asleep[i]) {
        sd = mix(mix(sd, this.id[i]), this.sleepTick[i])
        continue
      }
      h = mix(mix(mix(mix(mix(h, this.id[i]), this.x[i]), this.y[i]), this.vx[i]), this.vy[i])
    }
    return mix(h, sd >>> 0) >>> 0
  }

  exportEntities(w: SnapWriter): void {
    w.u32(this.n)
    for (let i = 0; i < this.n; i++) {
      w.u32(this.id[i])
      w.i32(this.x[i])
      w.i32(this.y[i])
      w.i32(this.vx[i])
      w.i32(this.vy[i])
      w.u8(this.asleep[i])
      w.i32(this.sleepTick[i])
    }
  }

  /** A point within shadowMargin cells of the domain's cell bounding box edge; every point without cells. */
  private boundary(i: number): boolean {
    if (this.spec.cells.length === 0) return true
    const o = this.opts
    const m = o.shadowMargin * o.cellSize
    return this.x[i] < this.minCol * o.cellSize + m || this.x[i] >= (this.maxCol + 1) * o.cellSize - m ||
      this.y[i] < this.minRow * o.cellSize + m || this.y[i] >= (this.maxRow + 1) * o.cellSize - m
  }

  /** u16 n, then (id u32, x, y, vx, vy i32): the same payload for every target. */
  shadowOut(w: SnapWriter, _to: DomainId): void {
    let m = 0
    for (let i = 0; i < this.n; i++) if (this.boundary(i)) m++
    w.u16(m)
    for (let i = 0; i < this.n; i++) {
      if (!this.boundary(i)) continue
      w.u32(this.id[i])
      w.i32(this.x[i])
      w.i32(this.y[i])
      w.i32(this.vx[i])
      w.i32(this.vy[i])
    }
  }

  /** The goal crossings of the last step: u16 n, then (kind u8, id u32, tick i32). */
  events(w: SnapWriter): void {
    w.u16(this.evN)
    for (let k = 0; k < this.evN; k++) {
      w.u8(EVENT_GOAL)
      w.u32(this.evId[k])
      w.i32(this.tick - 1)
    }
  }

  /** u16 n, then (x, y i32) of the awake points; the stride is the caller's cadence. */
  far(w: SnapWriter, _stride: number): void {
    let m = 0
    for (let i = 0; i < this.n; i++) if (!this.asleep[i]) m++
    w.u16(m)
    for (let i = 0; i < this.n; i++) {
      if (this.asleep[i]) continue
      w.i32(this.x[i])
      w.i32(this.y[i])
    }
  }

  /** Not simulation state: a bot seat keeps receiving inputs like any other. */
  seatHost(seat: SeatId, peer: number, bot: boolean): void {
    this.host[seat] = peer
    this.bot[seat] = bot ? 1 : 0
  }

  sleepEvents(out: SleepEvent[]): void {
    out.length = 0
    for (let k = 0; k < this.sleepN; k++) out.push(this.sleepPool[k])
  }

  beginResim(): void {
    this.resims++
  }

  endResim(): void {}
}

export const zonePointCodec: InputCodec<PointInput> = {
  create: () => ({ mask: 0 }),
  encode: (i) => i.mask & 0x1f,
  decode: (code, out) => {
    out.mask = code & 0x1f
    return out
  },
  neutral: 0,
}

/** The cell of a seat's point in `sim`, or 0xFFFF (no cell) when the domain does not hold it. */
export function seatCell(sim: ZonePointSim, seat: SeatId): number {
  for (let i = 0; i < sim.n; i++) if (sim.id[i] === seat) return sim.cellOf(i)
  return 0xffff
}

export class ZonePointFactory implements DomainFactory<PointInput> {
  readonly opts: ZonePointOptions

  constructor(opts: ZonePointOptions) {
    this.opts = opts
  }

  create(spec: DomainSpec, tick: number): ZonePointSim {
    return new ZonePointSim(spec, tick, this.opts)
  }

  /** Merge in ascending id, keep the entities in spec.cells or of spec.seats, rng from (domain id, tick). */
  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): ZonePointSim {
    const o = this.opts
    const recs: number[][] = []
    for (const r of sources) {
      const m = r.u32()
      for (let k = 0; k < m; k++) recs.push([r.u32(), r.i32(), r.i32(), r.i32(), r.i32(), r.u8(), r.i32()])
    }
    recs.sort((a, b) => a[0] - b[0])
    const kept: number[][] = []
    for (const e of recs) {
      if (kept.length > 0 && kept[kept.length - 1][0] === e[0]) continue
      const isSeat = e[0] < o.seatCount && spec.seats.includes(e[0])
      if (isSeat || (spec.kind !== 'global' && spec.cells.includes(cellAt(o, e[1], e[2])))) kept.push(e)
    }
    const sim = new ZonePointSim(spec, tick, o, kept.length)
    if (spec.kind !== 'global') {
      const w = new SnapWriter()
      w.u32(kept.length)
      for (const e of kept) {
        w.u32(e[0])
        for (let f = 1; f < 5; f++) w.i32(e[f])
        w.u8(e[5])
        w.i32(e[6])
      }
      sim.loadEntities([new SnapReader(w.bytes())])
    }
    sim.rng.state = mix(mix(0x811c9dc5, spec.id), tick)
    return sim
  }

  /** Create's placement at `tick`, from the spec alone. */
  reset(spec: DomainSpec, tick: number): ZonePointSim {
    return new ZonePointSim(spec, tick, this.opts)
  }
}

function cellAt(o: ZonePointOptions, x: number, y: number): number {
  let col = Math.floor(x / o.cellSize)
  let row = Math.floor(y / o.cellSize)
  col = col < 0 ? 0 : col >= o.gridCols ? o.gridCols - 1 : col
  row = row < 0 ? 0 : row >= o.gridRows ? o.gridRows - 1 : row
  return row * o.gridCols + col
}
