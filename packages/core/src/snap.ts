// Snapshot codec: a little-endian binary stream in a growable, reused buffer. Pure.
// Write fields in a fixed order; read them back in the same order. Floats are written bit-exact.
// Numbers as f64 (exact), enums as u8, strings as u16 length + UTF-16 code units.
export class SnapWriter {
  private buf = new Uint8Array(1024)
  private view = new DataView(this.buf.buffer)
  private pos = 0

  get length(): number {
    return this.pos
  }

  reset(): void {
    this.pos = 0
  }

  private ensure(n: number): void {
    const need = this.pos + n
    if (need <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.ensure(1)
    this.view.setUint8(this.pos, v)
    this.pos += 1
  }

  u16(v: number): void {
    this.ensure(2)
    this.view.setUint16(this.pos, v, true)
    this.pos += 2
  }

  u32(v: number): void {
    this.ensure(4)
    this.view.setUint32(this.pos, v >>> 0, true)
    this.pos += 4
  }

  i32(v: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, v | 0, true)
    this.pos += 4
  }

  i16(v: number): void {
    this.ensure(2)
    this.view.setInt16(this.pos, v, true)
    this.pos += 2
  }

  f32(v: number): void {
    this.ensure(4)
    this.view.setFloat32(this.pos, v, true)
    this.pos += 4
  }

  f64(v: number): void {
    this.ensure(8)
    this.view.setFloat64(this.pos, v, true)
    this.pos += 8
  }

  bool(b: boolean): void {
    this.u8(b ? 1 : 0)
  }

  str(s: string): void {
    const n = s.length
    this.ensure(2 + n * 2)
    this.view.setUint16(this.pos, n, true)
    this.pos += 2
    for (let i = 0; i < n; i++) {
      this.view.setUint16(this.pos, s.charCodeAt(i), true)
      this.pos += 2
    }
  }

  /** A view of the used part; valid until the next write. */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

export class SnapReader {
  private readonly buf: Uint8Array
  private readonly view: DataView
  private pos = 0

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get remaining(): number {
    return this.buf.byteLength - this.pos
  }

  private take(n: number): number {
    const p = this.pos
    if (p + n > this.buf.byteLength) throw new Error('[snap] overrun')
    this.pos = p + n
    return p
  }

  u8(): number {
    return this.view.getUint8(this.take(1))
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true)
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true)
  }

  i32(): number {
    return this.view.getInt32(this.take(4), true)
  }

  i16(): number {
    return this.view.getInt16(this.take(2), true)
  }

  f32(): number {
    return this.view.getFloat32(this.take(4), true)
  }

  f64(): number {
    return this.view.getFloat64(this.take(8), true)
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  str(): string {
    const n = this.u16()
    const p = this.take(n * 2)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint16(p + i * 2, true))
    return s
  }
}

/** FNV-1a 32-bit over bytes, unsigned. seed defaults to the FNV offset basis. */
export function fnv1a32(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
