// Zone peer codec. Little-endian; byte 0 is type, byte 1 is sender.

import { MAX_WIRE_PLAYERS, MAX_WIRE_TICKS } from '../wire.ts'

export const ZMSG = {
  CONTROL: 16,
  ZINPUT: 17,
  DOMAIN_SNAPSHOT: 18,
  FAR: 19,
  SHADOW: 20,
  SLEEP: 21,
  WAKE: 22,
  ZDROP: 23,
  ZDESYNC: 24,
} as const

export interface ZControlMsg {
  type: typeof ZMSG.CONTROL
  from: number
  firstTick: number
  count: number
  seats: number
  seatIds: Uint16Array
  /** count×seats words, tick-major. */
  words: Uint32Array
}

export interface ZInputMsg {
  type: typeof ZMSG.ZINPUT
  from: number
  domain: number
  ackTick: number
  firstTick: number
  count: number
  seats: number
  seatIds: Uint16Array
  /** count×seats codes, tick-major. */
  codes: Uint32Array
  senderTick: number
  checks: { domain: number; tick: number; hash: number }[]
}

export interface ZDomainSnapshotMsg {
  type: typeof ZMSG.DOMAIN_SNAPSHOT
  from: number
  domain: number
  tick: number
  hash: number
  part: number
  parts: number
  totalLen: number
  /** The chunk: a view into the decoded packet. */
  bytes: Uint8Array
}

export interface ZFarMsg {
  type: typeof ZMSG.FAR
  from: number
  domain: number
  tick: number
  stride: number
  n: number
  /** A packet view; the domain's far() defines the entry layout. */
  entries: Uint8Array
}

export interface ZShadowMsg {
  type: typeof ZMSG.SHADOW
  from: number
  fromDomain: number
  toDomain: number
  firstTick: number
  count: number
  payloads: Uint8Array[]
}

export interface ZSleepMsg {
  type: typeof ZMSG.SLEEP
  from: number
  domain: number
  id: number
  tick: number
  /** A view of the remaining packet bytes. */
  pose: Uint8Array
}

export interface ZWakeMsg {
  type: typeof ZMSG.WAKE
  from: number
  domain: number
  id: number
  tick: number
}

export interface ZDropMsg {
  type: typeof ZMSG.ZDROP
  from: number
  domain: number
  lostPeer: number
  lastTick: number
}

export interface ZDesyncMsg {
  type: typeof ZMSG.ZDESYNC
  from: number
  domain: number
  tick: number
  hash: number
}

export type ZoneMessage = ZControlMsg | ZInputMsg | ZDomainSnapshotMsg | ZFarMsg | ZShadowMsg | ZSleepMsg | ZWakeMsg | ZDropMsg | ZDesyncMsg

const CONTROL_HEAD = 8 // type, from, firstTick, count, seats
const ZINPUT_HEAD = 14 // type, from, domain, ackTick, firstTick, count, seats
const ZINPUT_TAIL = 5 // senderTick, nChecks
const CHECK_SIZE = 10 // domain u16, tick, hash
const SLEEP_HEAD = 12
const WAKE_HEAD = 12
const DROP_HEAD = 9
const DESYNC_HEAD = 12

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

/** Returned views share one buffer and are valid until the next writer call. */
export class ZoneWireWriter {
  private out = new OutBuf(SLEEP_HEAD)

  /** CONTROL. count is clamped to 1..MAX_WIRE_TICKS, seats to 0..MAX_WIRE_PLAYERS. */
  control(m: ZControlMsg): Uint8Array {
    const count = clampInt(m.count, 1, MAX_WIRE_TICKS)
    const seats = clampInt(m.seats, 0, MAX_WIRE_PLAYERS)
    const n = count * seats
    const len = CONTROL_HEAD + seats * 2 + n * 4
    const o = this.out
    o.ensure(len)
    const dv = o.dv
    dv.setUint8(0, ZMSG.CONTROL)
    dv.setUint8(1, m.from & 0xff)
    dv.setUint32(2, m.firstTick >>> 0, true)
    dv.setUint8(6, count)
    dv.setUint8(7, seats)
    const p = this.seatsAndWords(CONTROL_HEAD, seats, m.seatIds, n, m.words)
    return o.view(p)
  }

  /** ZINPUT. Same clamps as control, plus at most 255 checks. */
  zinput(m: ZInputMsg): Uint8Array {
    const count = clampInt(m.count, 1, MAX_WIRE_TICKS)
    const seats = clampInt(m.seats, 0, MAX_WIRE_PLAYERS)
    const n = count * seats
    const nChecks = m.checks.length < 255 ? m.checks.length : 255
    const len = ZINPUT_HEAD + seats * 2 + n * 4 + ZINPUT_TAIL + nChecks * CHECK_SIZE
    const o = this.out
    o.ensure(len)
    const dv = o.dv
    this.header(ZMSG.ZINPUT, m.from & 0xff, m.domain)
    dv.setUint32(4, m.ackTick >>> 0, true)
    dv.setUint32(8, m.firstTick >>> 0, true)
    dv.setUint8(12, count)
    dv.setUint8(13, seats)
    let p = this.seatsAndWords(ZINPUT_HEAD, seats, m.seatIds, n, m.codes)
    dv.setInt32(p, m.senderTick | 0, true)
    dv.setUint8(p + 4, nChecks)
    p += ZINPUT_TAIL
    for (let i = 0; i < nChecks; i++) {
      const c = m.checks[i]
      dv.setUint16(p, c.domain, true)
      dv.setUint32(p + 2, c.tick >>> 0, true)
      dv.setUint32(p + 6, c.hash >>> 0, true)
      p += CHECK_SIZE
    }
    return o.view(len)
  }

  sleep(from: number, domain: number, id: number, tick: number, pose: Uint8Array): Uint8Array {
    const len = SLEEP_HEAD + pose.length
    const o = this.out
    o.ensure(len)
    // Copy first in case pose is a view of the previous output.
    o.buf.set(pose, SLEEP_HEAD)
    this.header(ZMSG.SLEEP, from, domain)
    o.dv.setUint32(4, id, true)
    o.dv.setInt32(8, tick, true)
    return o.view(len)
  }

  wake(from: number, domain: number, id: number, tick: number): Uint8Array {
    this.header(ZMSG.WAKE, from, domain)
    this.out.dv.setUint32(4, id, true)
    this.out.dv.setInt32(8, tick, true)
    return this.out.view(WAKE_HEAD)
  }

  drop(from: number, domain: number, lostPeer: number, lastTick: number): Uint8Array {
    this.header(ZMSG.ZDROP, from, domain)
    this.out.dv.setUint8(4, lostPeer)
    this.out.dv.setInt32(5, lastTick, true)
    return this.out.view(DROP_HEAD)
  }

  desync(from: number, domain: number, tick: number, hash: number): Uint8Array {
    this.header(ZMSG.ZDESYNC, from, domain)
    this.out.dv.setInt32(4, tick, true)
    this.out.dv.setUint32(8, hash, true)
    return this.out.view(DESYNC_HEAD)
  }

  /** Writes seat ids then tick-major words; missing entries are 0. Returns the end offset. */
  private seatsAndWords(p: number, seats: number, ids: Uint16Array, n: number, words: Uint32Array): number {
    const dv = this.out.dv
    for (let i = 0; i < seats; i++, p += 2) dv.setUint16(p, i < ids.length ? ids[i] : 0, true)
    for (let i = 0; i < n; i++, p += 4) dv.setUint32(p, i < words.length ? words[i] >>> 0 : 0, true)
    return p
  }

  private header(type: number, from: number, domain: number): void {
    this.out.dv.setUint8(0, type)
    this.out.dv.setUint8(1, from)
    this.out.dv.setUint16(2, domain, true)
  }
}

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

/** A growable reused Uint32Array; words are returned as views of it. */
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

/** The Uint16 variant for seat ids. */
class SeatBuf {
  private buf = new Uint16Array(8)
  private views: (Uint16Array | undefined)[] = []

  fill(d: Uint8Array, p: number, n: number): Uint16Array {
    if (n > this.buf.length) {
      let size = this.buf.length
      while (size < n) size *= 2
      this.buf = new Uint16Array(size)
      this.views = []
    }
    const b = this.buf
    for (let i = 0; i < n; i++, p += 2) b[i] = u16(d, p)
    let v = this.views[n]
    if (!v) {
      v = b.subarray(0, n)
      this.views[n] = v
    }
    return v
  }
}

const controlSeats = new SeatBuf()
const controlWords = new CodeBuf()
const inputSeats = new SeatBuf()
const inputCodes = new CodeBuf()
const checkPool: { domain: number; tick: number; hash: number }[] = []
const controlMsg: ZControlMsg = { type: ZMSG.CONTROL, from: 0, firstTick: 0, count: 0, seats: 0, seatIds: new Uint16Array(0), words: new Uint32Array(0) }
const inputMsg: ZInputMsg = { type: ZMSG.ZINPUT, from: 0, domain: 0, ackTick: 0, firstTick: 0, count: 0, seats: 0, seatIds: new Uint16Array(0), codes: new Uint32Array(0), senderTick: 0, checks: [] }
const sleepMsg: ZSleepMsg = { type: ZMSG.SLEEP, from: 0, domain: 0, id: 0, tick: 0, pose: new Uint8Array(0) }
const wakeMsg: ZWakeMsg = { type: ZMSG.WAKE, from: 0, domain: 0, id: 0, tick: 0 }
const dropMsg: ZDropMsg = { type: ZMSG.ZDROP, from: 0, domain: 0, lostPeer: 0, lastTick: 0 }
const desyncMsg: ZDesyncMsg = { type: ZMSG.ZDESYNC, from: 0, domain: 0, tick: 0, hash: 0 }

function decodeControl(d: Uint8Array): ZControlMsg | null {
  if (d.length < CONTROL_HEAD) return null
  const count = d[6]
  const seats = d[7]
  if (count < 1 || count > MAX_WIRE_TICKS || seats > MAX_WIRE_PLAYERS) return null
  const n = count * seats
  const words = CONTROL_HEAD + seats * 2
  if (d.length !== words + n * 4) return null
  const m = controlMsg
  m.from = d[1]
  m.firstTick = tick32(d, 2)
  m.count = count
  m.seats = seats
  m.seatIds = controlSeats.fill(d, CONTROL_HEAD, seats)
  m.words = controlWords.fill(d, words, n)
  return m
}

function decodeInput(d: Uint8Array): ZInputMsg | null {
  const len = d.length
  if (len < ZINPUT_HEAD + ZINPUT_TAIL) return null
  const count = d[12]
  const seats = d[13]
  if (count < 1 || count > MAX_WIRE_TICKS || seats > MAX_WIRE_PLAYERS) return null
  const n = count * seats
  const codes = ZINPUT_HEAD + seats * 2
  const tail = codes + n * 4
  if (len < tail + ZINPUT_TAIL) return null
  const nChecks = d[tail + 4]
  if (len !== tail + ZINPUT_TAIL + nChecks * CHECK_SIZE) return null
  const m = inputMsg
  m.from = d[1]
  m.domain = u16(d, 2)
  m.ackTick = tick32(d, 4)
  m.firstTick = tick32(d, 8)
  m.count = count
  m.seats = seats
  m.seatIds = inputSeats.fill(d, ZINPUT_HEAD, seats)
  m.codes = inputCodes.fill(d, codes, n)
  m.senderTick = tick32(d, tail)
  const checks = m.checks
  checks.length = nChecks
  let p = tail + ZINPUT_TAIL
  for (let i = 0; i < nChecks; i++, p += CHECK_SIZE) {
    let c = checkPool[i]
    if (!c) {
      c = { domain: 0, tick: 0, hash: 0 }
      checkPool[i] = c
    }
    c.domain = u16(d, p)
    c.tick = tick32(d, p + 2)
    c.hash = u32(d, p + 6)
    checks[i] = c
  }
  return m
}

/**
 * Never throws for packet bytes. Results are reused until the next decode of
 * the same type. SLEEP pose is a view into the input packet, without a copy.
 * Unknown types and short frames return null; CONTROL and ZINPUT need an exact length; fixed messages ignore trailing bytes.
 */
export function decodeZone(data: Uint8Array): ZoneMessage | null {
  const len = data.length
  if (len < 2) return null
  switch (data[0]) {
    case ZMSG.CONTROL:
      return decodeControl(data)
    case ZMSG.ZINPUT:
      return decodeInput(data)
    case ZMSG.SLEEP:
      if (len < SLEEP_HEAD) return null
      sleepMsg.from = data[1]
      sleepMsg.domain = u16(data, 2)
      sleepMsg.id = u32(data, 4)
      sleepMsg.tick = tick32(data, 8)
      sleepMsg.pose = data.subarray(SLEEP_HEAD)
      return sleepMsg
    case ZMSG.WAKE:
      if (len < WAKE_HEAD) return null
      wakeMsg.from = data[1]
      wakeMsg.domain = u16(data, 2)
      wakeMsg.id = u32(data, 4)
      wakeMsg.tick = tick32(data, 8)
      return wakeMsg
    case ZMSG.ZDROP:
      if (len < DROP_HEAD) return null
      dropMsg.from = data[1]
      dropMsg.domain = u16(data, 2)
      dropMsg.lostPeer = data[4]
      dropMsg.lastTick = tick32(data, 5)
      return dropMsg
    case ZMSG.ZDESYNC:
      if (len < DESYNC_HEAD) return null
      desyncMsg.from = data[1]
      desyncMsg.domain = u16(data, 2)
      desyncMsg.tick = tick32(data, 4)
      desyncMsg.hash = u32(data, 8)
      return desyncMsg
    default:
      return null
  }
}

