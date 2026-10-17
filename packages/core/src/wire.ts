// Binary peer codec. Pure, no allocation after warm-up on the hot messages.
// Little-endian. Byte 0 is the message type, byte 1 the sender peer id.
// Ticks travel as u32 and decode as signed 32-bit, so a tick of -1 (for
// example ackTick before any input is held) survives the round trip.
import { fnv1a32 } from './snap.ts'
import type { NetChannel } from './types.ts'

export const MSG = { INPUT: 1, PING: 2, PONG: 3, SNAPSHOT: 4, DROP: 5, DESYNC: 6, READY: 7, BYE: 8 } as const

/** Maximum ticks carried by one INPUT or DROP message. */
export const MAX_WIRE_TICKS = 64
/** Maximum players per peer carried in one INPUT or DROP message. */
export const MAX_WIRE_PLAYERS = 8
/** Maximum snapshot bytes per SNAPSHOT part. */
export const SNAPSHOT_CHUNK = 16000
/** Maximum total snapshot length accepted. */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

export interface InputMsg {
  from: number
  ackTick: number
  firstTick: number
  count: number
  players: number
  codes: Uint32Array
  senderTick: number
  checks: { tick: number; hash: number }[]
}

export interface InputWireMsg extends InputMsg { type: typeof MSG.INPUT }
export interface PingMsg { type: typeof MSG.PING; from: number; id: number; ms: number }
export interface PongMsg { type: typeof MSG.PONG; from: number; id: number; ms: number }
export interface SnapshotMsg {
  type: typeof MSG.SNAPSHOT
  from: number
  tick: number
  hash: number
  part: number
  parts: number
  totalLen: number
  /** The chunk: a view into the decoded packet. */
  bytes: Uint8Array
}
export interface DropMsg {
  type: typeof MSG.DROP
  from: number
  lostPeer: number
  lastTick: number
  firstTick: number
  players: number
  count: number
  /** count×players codes, tick-major. */
  codes: Uint32Array
}
export interface DesyncMsg { type: typeof MSG.DESYNC; from: number; tick: number; hash: number }
export interface ReadyMsg { type: typeof MSG.READY; from: number; session: number; configHash: number }
export interface ByeMsg { type: typeof MSG.BYE; from: number }

export type WireMessage = InputWireMsg | PingMsg | PongMsg | SnapshotMsg | DropMsg | DesyncMsg | ReadyMsg | ByeMsg

// ---------------------------------------------------------------- writer

const INPUT_HEAD = 12 // type, from, ackTick, firstTick, count, players
const INPUT_TAIL = 5 // senderTick, nChecks
const SNAP_HEAD = 18 // type, from, tick, hash, part, parts, totalLen
const DROP_HEAD = 14 // type, from, lostPeer, lastTick, firstTick, players, count

function clampInt(v: number, lo: number, hi: number): number {
  const n = v | 0
  return n < lo ? lo : n > hi ? hi : n
}

/** One growable, reused output buffer with cached views per used length. */
class OutBuf {
  buf: Uint8Array
  dv: DataView
  private views: (Uint8Array | undefined)[] = []

  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.dv = new DataView(this.buf.buffer)
  }

  ensure(size: number): void {
    if (size <= this.buf.length) return
    let n = this.buf.length
    while (n < size) n *= 2
    this.buf = new Uint8Array(n)
    this.dv = new DataView(this.buf.buffer)
    this.views = []
  }

  /** The view of the first len bytes; cached so steady-state calls do not allocate. */
  view(len: number): Uint8Array {
    let v = this.views[len]
    if (!v) {
      v = this.buf.subarray(0, len)
      this.views[len] = v
    }
    return v
  }
}

/**
 * Encodes peer messages into reused buffers, one per message kind. A returned
 * view is valid until the next call of the same kind. input, ping and pong do
 * not allocate after warm-up.
 */
export class WireWriter {
  private inputBuf = new OutBuf(256)
  private pingBuf = new OutBuf(16)
  private pongBuf = new OutBuf(16)
  private snapBuf = new OutBuf(1024)
  private dropBuf = new OutBuf(256)
  private desyncBuf = new OutBuf(16)
  private readyBuf = new OutBuf(16)
  private byeBuf = new OutBuf(8)
  private parts: Uint8Array[] = []

  /** INPUT. count is clamped to 1..64, players to 0..8, checks to 255 entries. */
  input(m: InputMsg): Uint8Array {
    const count = clampInt(m.count, 1, MAX_WIRE_TICKS)
    const players = clampInt(m.players, 0, MAX_WIRE_PLAYERS)
    const n = count * players
    const nChecks = m.checks.length < 255 ? m.checks.length : 255
    const len = INPUT_HEAD + n * 4 + INPUT_TAIL + nChecks * 8
    const o = this.inputBuf
    o.ensure(len)
    const dv = o.dv
    dv.setUint8(0, MSG.INPUT)
    dv.setUint8(1, m.from & 0xff)
    dv.setUint32(2, m.ackTick >>> 0, true)
    dv.setUint32(6, m.firstTick >>> 0, true)
    dv.setUint8(10, count)
    dv.setUint8(11, players)
    const codes = m.codes
    let p = INPUT_HEAD
    for (let i = 0; i < n; i++) {
      dv.setUint32(p, i < codes.length ? codes[i] >>> 0 : 0, true)
      p += 4
    }
    dv.setInt32(p, m.senderTick | 0, true)
    dv.setUint8(p + 4, nChecks)
    p += INPUT_TAIL
    for (let i = 0; i < nChecks; i++) {
      const c = m.checks[i]
      dv.setUint32(p, c.tick >>> 0, true)
      dv.setUint32(p + 4, c.hash >>> 0, true)
      p += 8
    }
    return o.view(len)
  }

  ping(from: number, id: number, ms: number): Uint8Array {
    return this.pingPong(this.pingBuf, MSG.PING, from, id, ms)
  }

  pong(from: number, id: number, ms: number): Uint8Array {
    return this.pingPong(this.pongBuf, MSG.PONG, from, id, ms)
  }

  private pingPong(o: OutBuf, type: number, from: number, id: number, ms: number): Uint8Array {
    const dv = o.dv
    dv.setUint8(0, type)
    dv.setUint8(1, from & 0xff)
    dv.setUint32(2, id >>> 0, true)
    dv.setFloat64(6, ms, true)
    return o.view(14)
  }

  /**
   * SNAPSHOT parts of at most 16000 bytes each (an empty snapshot is one empty
   * part). The returned array and its views are reused until the next call.
   */
  snapshotParts(from: number, tick: number, hash: number, bytes: Uint8Array): Uint8Array[] {
    const total = bytes.length
    let parts = 1
    while (parts * SNAPSHOT_CHUNK < total) parts++
    const o = this.snapBuf
    o.ensure(parts * SNAP_HEAD + total)
    const buf = o.buf
    const dv = o.dv
    const out = this.parts
    out.length = parts
    let p = 0
    for (let i = 0; i < parts; i++) {
      const off = i * SNAPSHOT_CHUNK
      const len = total - off < SNAPSHOT_CHUNK ? total - off : SNAPSHOT_CHUNK
      const start = p
      dv.setUint8(p, MSG.SNAPSHOT)
      dv.setUint8(p + 1, from & 0xff)
      dv.setUint32(p + 2, tick >>> 0, true)
      dv.setUint32(p + 6, hash >>> 0, true)
      dv.setUint16(p + 10, i, true)
      dv.setUint16(p + 12, parts, true)
      dv.setUint32(p + 14, total, true)
      p += SNAP_HEAD
      buf.set(bytes.subarray(off, off + len), p)
      p += len
      out[i] = buf.subarray(start, p)
    }
    return out
  }

  /**
   * DROP: the lost peer's inputs for firstTick..lastTick, count×players codes
   * tick-major. count is clamped to 0..64 and players to 0..8.
   */
  drop(from: number, lostPeer: number, lastTick: number, firstTick: number, players: number, count: number, codes: ArrayLike<number>): Uint8Array {
    const c = clampInt(count, 0, MAX_WIRE_TICKS)
    const k = clampInt(players, 0, MAX_WIRE_PLAYERS)
    const n = c * k
    const len = DROP_HEAD + n * 4
    const o = this.dropBuf
    o.ensure(len)
    const dv = o.dv
    dv.setUint8(0, MSG.DROP)
    dv.setUint8(1, from & 0xff)
    dv.setUint8(2, lostPeer & 0xff)
    dv.setUint32(3, lastTick >>> 0, true)
    dv.setUint32(7, firstTick >>> 0, true)
    dv.setUint8(11, k)
    dv.setUint16(12, c, true)
    let p = DROP_HEAD
    for (let i = 0; i < n; i++) {
      dv.setUint32(p, i < codes.length ? codes[i] >>> 0 : 0, true)
      p += 4
    }
    return o.view(len)
  }

  desync(from: number, tick: number, hash: number): Uint8Array {
    const o = this.desyncBuf
    const dv = o.dv
    dv.setUint8(0, MSG.DESYNC)
    dv.setUint8(1, from & 0xff)
    dv.setUint32(2, tick >>> 0, true)
    dv.setUint32(6, hash >>> 0, true)
    return o.view(10)
  }

  ready(from: number, session: number, configHash: number): Uint8Array {
    const o = this.readyBuf
    const dv = o.dv
    dv.setUint8(0, MSG.READY)
    dv.setUint8(1, from & 0xff)
    dv.setUint16(2, session & 0xffff, true)
    dv.setUint32(4, configHash >>> 0, true)
    return o.view(8)
  }

  bye(from: number): Uint8Array {
    const o = this.byeBuf
    o.dv.setUint8(0, MSG.BYE)
    o.dv.setUint8(1, from & 0xff)
    return o.view(2)
  }
}

// ---------------------------------------------------------------- decoder

// Byte readers over the raw packet. The f64 goes through a scratch DataView so
// decoding never allocates a DataView per packet.
const f64Bytes = new Uint8Array(8)
const f64View = new DataView(f64Bytes.buffer)

function u16(d: Uint8Array, p: number): number {
  return d[p] | (d[p + 1] << 8)
}

function u32(d: Uint8Array, p: number): number {
  return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0
}

/** A tick: u32 on the wire, read back as signed 32-bit (so -1 round-trips). */
function tick32(d: Uint8Array, p: number): number {
  return d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)
}

function f64(d: Uint8Array, p: number): number {
  for (let i = 0; i < 8; i++) f64Bytes[i] = d[p + i]
  return f64View.getFloat64(0, true)
}

/** A growable reused Uint32Array; codes are returned as views of it. */
class CodeBuf {
  private buf = new Uint32Array(64)
  private views: (Uint32Array | undefined)[] = []

  fill(d: Uint8Array, p: number, n: number): Uint32Array {
    if (n > this.buf.length) {
      let size = this.buf.length
      while (size < n) size *= 2
      this.buf = new Uint32Array(size)
      this.views = []
    }
    const b = this.buf
    for (let i = 0; i < n; i++, p += 4) b[i] = u32(d, p)
    let v = this.views[n]
    if (!v) {
      v = b.subarray(0, n)
      this.views[n] = v
    }
    return v
  }
}

// Reused decode results, one per type. A decoded message (and its codes,
// checks and bytes) is valid only until the next decode of the same type;
// copy what must outlive it. SnapshotMsg.bytes is a view into the packet.
const inputCodes = new CodeBuf()
const dropCodes = new CodeBuf()
const checkPool: { tick: number; hash: number }[] = []
const inputMsg: InputWireMsg = { type: MSG.INPUT, from: 0, ackTick: 0, firstTick: 0, count: 0, players: 0, codes: new Uint32Array(0), senderTick: 0, checks: [] }
const pingMsg: PingMsg = { type: MSG.PING, from: 0, id: 0, ms: 0 }
const pongMsg: PongMsg = { type: MSG.PONG, from: 0, id: 0, ms: 0 }
const snapMsg: SnapshotMsg = { type: MSG.SNAPSHOT, from: 0, tick: 0, hash: 0, part: 0, parts: 0, totalLen: 0, bytes: new Uint8Array(0) }
const dropMsg: DropMsg = { type: MSG.DROP, from: 0, lostPeer: 0, lastTick: 0, firstTick: 0, players: 0, count: 0, codes: new Uint32Array(0) }
const desyncMsg: DesyncMsg = { type: MSG.DESYNC, from: 0, tick: 0, hash: 0 }
const readyMsg: ReadyMsg = { type: MSG.READY, from: 0, session: 0, configHash: 0 }
const byeMsg: ByeMsg = { type: MSG.BYE, from: 0 }

function decodeInput(d: Uint8Array): InputWireMsg | null {
  const len = d.length
  if (len < INPUT_HEAD + INPUT_TAIL) return null
  const count = d[10]
  const players = d[11]
  if (count < 1 || count > MAX_WIRE_TICKS || players > MAX_WIRE_PLAYERS) return null
  const n = count * players
  const tail = INPUT_HEAD + n * 4
  if (len < tail + INPUT_TAIL) return null
  const nChecks = d[tail + 4]
  if (len !== tail + INPUT_TAIL + nChecks * 8) return null
  const m = inputMsg
  m.from = d[1]
  m.ackTick = tick32(d, 2)
  m.firstTick = tick32(d, 6)
  m.count = count
  m.players = players
  m.codes = inputCodes.fill(d, INPUT_HEAD, n)
  m.senderTick = tick32(d, tail)
  const checks = m.checks
  checks.length = nChecks
  let p = tail + INPUT_TAIL
  for (let i = 0; i < nChecks; i++, p += 8) {
    let c = checkPool[i]
    if (!c) {
      c = { tick: 0, hash: 0 }
      checkPool[i] = c
    }
    c.tick = tick32(d, p)
    c.hash = u32(d, p + 4)
    checks[i] = c
  }
  return m
}

function decodeSnapshot(d: Uint8Array): SnapshotMsg | null {
  const len = d.length
  if (len < SNAP_HEAD || len > SNAP_HEAD + SNAPSHOT_CHUNK) return null
  const part = u16(d, 10)
  const parts = u16(d, 12)
  const totalLen = u32(d, 14)
  if (part >= parts || totalLen > MAX_SNAPSHOT_BYTES) return null
  const m = snapMsg
  m.from = d[1]
  m.tick = tick32(d, 2)
  m.hash = u32(d, 6)
  m.part = part
  m.parts = parts
  m.totalLen = totalLen
  m.bytes = d.subarray(SNAP_HEAD, len)
  return m
}

function decodeDrop(d: Uint8Array): DropMsg | null {
  const len = d.length
  if (len < DROP_HEAD) return null
  const players = d[11]
  const count = u16(d, 12)
  if (count > MAX_WIRE_TICKS || players > MAX_WIRE_PLAYERS) return null
  const n = count * players
  if (len !== DROP_HEAD + n * 4) return null
  const m = dropMsg
  m.from = d[1]
  m.lostPeer = d[2]
  m.lastTick = tick32(d, 3)
  m.firstTick = tick32(d, 7)
  m.players = players
  m.count = count
  m.codes = dropCodes.fill(d, DROP_HEAD, n)
  return m
}

/**
 * Decodes one peer packet. Never throws: returns null for an unknown type, a
 * short or over-long buffer, or any field out of range. The result object is
 * reused per type and is valid until the next decode of the same type.
 */
export function decode(data: Uint8Array): WireMessage | null {
  const d = data
  const len = d.length
  if (len < 2) return null
  switch (d[0]) {
    case MSG.INPUT:
      return decodeInput(d)
    case MSG.PING:
    case MSG.PONG: {
      if (len !== 14) return null
      const m = d[0] === MSG.PING ? pingMsg : pongMsg
      m.from = d[1]
      m.id = u32(d, 2)
      m.ms = f64(d, 6)
      return m
    }
    case MSG.SNAPSHOT:
      return decodeSnapshot(d)
    case MSG.DROP:
      return decodeDrop(d)
    case MSG.DESYNC:
      if (len !== 10) return null
      desyncMsg.from = d[1]
      desyncMsg.tick = tick32(d, 2)
      desyncMsg.hash = u32(d, 6)
      return desyncMsg
    case MSG.READY:
      if (len !== 8) return null
      readyMsg.from = d[1]
      readyMsg.session = u16(d, 2)
      readyMsg.configHash = u32(d, 4)
      return readyMsg
    case MSG.BYE:
      if (len !== 2) return null
      byeMsg.from = d[1]
      return byeMsg
    default:
      return null
  }
}

// ---------------------------------------------------------------- assembler

/**
 * Collects the SNAPSHOT parts of one (tick, hash). A part of a newer tick (or
 * of the same tick with another hash) replaces an incomplete older snapshot;
 * parts of an older tick are ignored. Returns the full bytes (a fresh array
 * owned by the caller) once every part arrived and fnv1a32(bytes) === hash,
 * null otherwise.
 */
export class SnapshotAssembler {
  private active = false
  private tick = 0
  private hash = 0
  private parts = 0
  private totalLen = 0
  private received = 0
  private have: Uint8Array = new Uint8Array(0)
  private buf: Uint8Array = new Uint8Array(0)

  push(msg: SnapshotMsg): { tick: number; hash: number; bytes: Uint8Array } | null {
    const expectParts = msg.totalLen === 0 ? 1 : ((msg.totalLen + SNAPSHOT_CHUNK - 1) / SNAPSHOT_CHUNK) | 0
    if (msg.parts !== expectParts || msg.part >= msg.parts || msg.totalLen > MAX_SNAPSHOT_BYTES) return null
    const off = msg.part * SNAPSHOT_CHUNK
    const rest = msg.totalLen - off
    const chunkLen = rest < SNAPSHOT_CHUNK ? rest : SNAPSHOT_CHUNK
    if (msg.bytes.length !== chunkLen) return null
    if (this.active && msg.tick === this.tick && msg.hash === this.hash) {
      if (msg.parts !== this.parts || msg.totalLen !== this.totalLen) return null
    } else {
      if (this.active && msg.tick < this.tick) return null
      this.active = true
      this.tick = msg.tick
      this.hash = msg.hash
      this.parts = msg.parts
      this.totalLen = msg.totalLen
      this.received = 0
      this.have = new Uint8Array(msg.parts)
      this.buf = new Uint8Array(msg.totalLen)
    }
    if (this.have[msg.part]) return null
    this.have[msg.part] = 1
    this.received++
    this.buf.set(msg.bytes, off)
    if (this.received < this.parts) return null
    this.active = false
    const bytes = this.buf
    this.buf = new Uint8Array(0)
    if (fnv1a32(bytes) !== this.hash) return null
    return { tick: this.tick, hash: this.hash, bytes }
  }

  /** Drops any incomplete snapshot. */
  reset(): void {
    this.active = false
    this.received = 0
    this.buf = new Uint8Array(0)
  }
}
