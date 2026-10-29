// Far stream: display-only poses of entities outside a peer's domains, sent at a stride that grows with the cell
// distance. Strides come from ZoneTuning.farStrides; nothing here is a number of the game.

import { CONTROL_BITS, CONTROL_NO_CELL } from './control.ts'
import type { ZoneTuning } from './tuning.ts'
import type { Assignment, ControlSample, DomainId, Roster } from './types.ts'

/** Stride of the first farStrides entry whose maxCells reaches the distance; past the last entry, the last stride. */
export function farStride(cellDistance: number, tuning: ZoneTuning): number {
  const table = tuning.farStrides
  for (let i = 0; i < table.length; i++) {
    if (table[i].maxCells >= cellDistance) return table[i].stride
  }
  return table[table.length - 1].stride
}

/** Chebyshev distance of the closest pair of cells. NO_CELL entries are ignored; no cell on either side is Infinity. */
export function cellSetDistance(a: ArrayLike<number>, b: ArrayLike<number>, gridCols: number): number {
  let best = Infinity
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]
    if (ca === CONTROL_NO_CELL) continue
    const rowA = Math.floor(ca / gridCols)
    const colA = ca % gridCols
    for (let j = 0; j < b.length; j++) {
      const cb = b[j]
      if (cb === CONTROL_NO_CELL) continue
      const dr = Math.abs(rowA - Math.floor(cb / gridCols))
      const dc = Math.abs(colA - (cb % gridCols))
      const d = dr > dc ? dr : dc
      if (d < best) best = d
    }
  }
  return best
}

/**
 * Reader over the entries of one FAR message, rebound for every message. It reads what DomainSim.far wrote with
 * SnapWriter and throws on overrun like SnapReader, so the session guards the sink call against a short packet.
 * Bytes are read by hand so that binding a packet never allocates a DataView.
 */
export class FarReader {
  private bytes: Uint8Array = new Uint8Array(0)
  private pos = 0
  private readonly scratch = new DataView(new ArrayBuffer(8))

  bind(bytes: Uint8Array): this {
    this.bytes = bytes
    this.pos = 0
    return this
  }

  get remaining(): number {
    return this.bytes.length - this.pos
  }

  private take(n: number): number {
    const p = this.pos
    if (p + n > this.bytes.length) throw new Error('[far] overrun')
    this.pos = p + n
    return p
  }

  private load(n: number): DataView {
    const p = this.take(n)
    for (let i = 0; i < n; i++) this.scratch.setUint8(i, this.bytes[p + i])
    return this.scratch
  }

  u8(): number {
    return this.bytes[this.take(1)]
  }

  u16(): number {
    const p = this.take(2)
    return this.bytes[p] | (this.bytes[p + 1] << 8)
  }

  u32(): number {
    const p = this.take(4)
    const b = this.bytes
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
  }

  i16(): number {
    return (this.u16() << 16) >> 16
  }

  i32(): number {
    return this.u32() | 0
  }

  f32(): number {
    return this.load(4).getFloat32(0, true)
  }

  f64(): number {
    return this.load(8).getFloat64(0, true)
  }

  bool(): boolean {
    return this.u8() !== 0
  }
}

/**
 * Receives the FAR stream for drawing. FAR never enters a step: a sink must not feed a simulation, so a lost, late
 * or repeated FAR cannot desync anything. `entries` is reused: read it during the call and keep nothing.
 */
export interface FarSink {
  far(domain: DomainId, tick: number, stride: number, n: number, entries: FarReader): void
  /** Display-only transition. Pose is valid during this call and empty for WAKE; never feed it into a step. */
  sleep?(domain: DomainId, id: number, tick: number, asleep: boolean, pose: Uint8Array): void
}

/**
 * Who gets which domain at which tick. rebuild() runs once per epoch and fills the tables; due() is a lookup and a
 * modulo. A peer that simulates the domain gets no FAR for it, and neither does a peer that is not live.
 */
export class FarSchedule {
  private readonly tuning: ZoneTuning
  private readonly peerCount: number
  private ids: Uint16Array
  private strides: Uint16Array
  private count = 0
  private readonly own: number[] = []

  constructor(tuning: ZoneTuning, peerCount: number, domainCapacity: number) {
    this.tuning = tuning
    this.peerCount = peerCount
    this.ids = new Uint16Array(domainCapacity)
    this.strides = new Uint16Array(domainCapacity * peerCount)
  }

  /** The stride is taken from the distance between the cells of the peer's seats (confirmed control words) and the domain's. */
  rebuild(assignment: Assignment, roster: Roster, controls: ControlSample): void {
    const domains = assignment.domains
    if (domains.length > this.ids.length) {
      this.ids = new Uint16Array(domains.length)
      this.strides = new Uint16Array(domains.length * this.peerCount)
    }
    this.count = domains.length
    this.strides.fill(0, 0, this.count * this.peerCount)
    for (let i = 0; i < domains.length; i++) this.ids[i] = domains[i].id
    for (const entry of roster.peers) {
      const p = entry.peer
      if (p < 0 || p >= this.peerCount || roster.live[p] !== true) continue
      this.own.length = 0
      for (const seat of entry.seats) {
        if (seat >= 0 && seat < controls.words.length) this.own.push(controls.words[seat] & CONTROL_BITS.cell.mask)
      }
      for (let i = 0; i < domains.length; i++) {
        const d = domains[i]
        if (d.replicas.includes(p)) continue
        this.strides[i * this.peerCount + p] = farStride(cellSetDistance(this.own, d.cells, this.tuning.gridCols), this.tuning)
      }
    }
  }

  /** The stride at which `peer` gets `domain`, or 0 when it gets none. */
  strideOf(domain: DomainId, peer: number): number {
    if (peer < 0 || peer >= this.peerCount) return 0
    let lo = 0
    let hi = this.count - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const id = this.ids[mid]
      if (id === domain) return this.strides[mid * this.peerCount + peer]
      if (id < domain) lo = mid + 1
      else hi = mid - 1
    }
    return 0
  }

  due(domain: DomainId, peer: number, tick: number): boolean {
    const stride = this.strideOf(domain, peer)
    return stride !== 0 && tick % stride === 0
  }
}
