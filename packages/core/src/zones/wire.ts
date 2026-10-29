// Zone peer codec. Little-endian; byte 0 is type, byte 1 is sender.

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

const SLEEP_HEAD = 12
const WAKE_HEAD = 12
const DROP_HEAD = 9
const DESYNC_HEAD = 12

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

const sleepMsg: ZSleepMsg = { type: ZMSG.SLEEP, from: 0, domain: 0, id: 0, tick: 0, pose: new Uint8Array(0) }
const wakeMsg: ZWakeMsg = { type: ZMSG.WAKE, from: 0, domain: 0, id: 0, tick: 0 }
const dropMsg: ZDropMsg = { type: ZMSG.ZDROP, from: 0, domain: 0, lostPeer: 0, lastTick: 0 }
const desyncMsg: ZDesyncMsg = { type: ZMSG.ZDESYNC, from: 0, domain: 0, tick: 0, hash: 0 }

/**
 * Never throws for packet bytes. Results are reused until the next decode of
 * the same type. SLEEP pose is a view into the input packet, without a copy.
 * Unknown types and short frames return null; fixed messages ignore trailing bytes.
 */
export function decodeZone(data: Uint8Array): ZoneMessage | null {
  const len = data.length
  if (len < 2) return null
  switch (data[0]) {
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

