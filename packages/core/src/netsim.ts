// Deterministic simulated network for headless rollback tests. Pure.
// A virtual clock in ms; packets are delivered in (due time, sequence) order.
// The same seed and the same send sequence give identical deliveries.
import { Rng } from './rng.ts'
import type { NetChannel, NetTransport } from './types.ts'

export interface NetSimOptions {
  seed: number
  rttMs: number
  jitterMs: number
  /** Fast channel loss probability per packet, 0..1. */
  loss: number
  /** Fast channel probability of an extra delay of one jitter span (2 × jitterMs). */
  reorder?: number
}

interface Packet {
  from: number
  to: number
  ch: NetChannel
  due: number
  seq: number
  buf: Uint8Array
  data: Uint8Array
}

type DrainEntry = { peer: number; ch: NetChannel; data: Uint8Array }

const MIN_BUCKET = 6 // 64 bytes

function bucketOf(len: number): number {
  const b = len <= 1 ? 0 : 32 - Math.clz32(len - 1)
  return b < MIN_BUCKET ? MIN_BUCKET : b
}

function byDueThenSeq(a: Packet, b: Packet): number {
  return a.due !== b.due ? a.due - b.due : a.seq - b.seq
}

export class NetSim {
  private readonly n: number
  private opts: NetSimOptions
  private readonly rng: Rng
  private clock = 0
  private seq = 0
  private readonly dead: boolean[]
  /** Last reliable due time per (from * n + to) pair. */
  private readonly lastReliableDue: number[]
  private readonly pending: Packet[] = []
  private readonly dueScratch: Packet[] = []
  private readonly inbox: Packet[][]
  /** Packets handed out by the last drain of each peer; recycled at its next drain. */
  private readonly handed: Packet[][]
  private readonly packetPool: Packet[] = []
  private readonly bufPool: Uint8Array[][] = []
  private readonly transports: NetTransport[]

  constructor(peers: number, opts: NetSimOptions) {
    this.n = peers
    this.opts = { reorder: 0, ...opts }
    this.rng = new Rng(opts.seed)
    this.dead = []
    this.inbox = []
    this.handed = []
    this.transports = []
    this.lastReliableDue = []
    for (let i = 0; i < peers * peers; i++) this.lastReliableDue.push(0)
    for (let p = 0; p < peers; p++) {
      this.dead.push(false)
      this.inbox.push([])
      this.handed.push([])
      this.transports.push(this.makeTransport(p))
    }
  }

  transport(peer: number): NetTransport {
    const t = this.transports[peer]
    if (!t) throw new Error(`[netsim] unknown peer ${peer}`)
    return t
  }

  now(): number {
    return this.clock
  }

  advance(ms: number): void {
    if (ms > 0) this.clock += ms
    const due = this.dueScratch
    due.length = 0
    let w = 0
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]
      if (p.due <= this.clock) due.push(p)
      else this.pending[w++] = p
    }
    this.pending.length = w
    due.sort(byDueThenSeq)
    for (let i = 0; i < due.length; i++) {
      const p = due[i]
      if (this.dead[p.from] || this.dead[p.to]) this.release(p)
      else this.inbox[p.to].push(p)
    }
    due.length = 0
  }

  kill(peer: number): void {
    if (peer < 0 || peer >= this.n || this.dead[peer]) return
    this.dead[peer] = true
    let w = 0
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]
      if (p.from === peer || p.to === peer) this.release(p)
      else this.pending[w++] = p
    }
    this.pending.length = w
    const box = this.inbox[peer]
    for (let i = 0; i < box.length; i++) this.release(box[i])
    box.length = 0
  }

  setOptions(o: Partial<NetSimOptions>): void {
    if (o.rttMs !== undefined) this.opts.rttMs = o.rttMs
    if (o.jitterMs !== undefined) this.opts.jitterMs = o.jitterMs
    if (o.loss !== undefined) this.opts.loss = o.loss
    if (o.reorder !== undefined) this.opts.reorder = o.reorder
  }

  private isClosed(a: number, b: number): boolean {
    return a < 0 || a >= this.n || b < 0 || b >= this.n || this.dead[a] || this.dead[b]
  }

  private latency(): number {
    const j = this.opts.jitterMs
    const d = this.opts.rttMs / 2 + (j > 0 ? this.rng.range(-j, j) : 0)
    return d < 0 ? 0 : d
  }

  private send(from: number, to: number, ch: NetChannel, data: Uint8Array): void {
    if (from === to || this.isClosed(from, to)) return
    let due: number
    if (ch === 'fast') {
      // Fixed draw order per fast packet: loss, jitter, reorder.
      const lost = this.rng.next() < this.opts.loss
      due = this.clock + this.latency()
      const reorder = this.rng.next() < (this.opts.reorder ?? 0)
      if (lost) return
      if (reorder) due += 2 * this.opts.jitterMs
    } else {
      due = this.clock + this.latency()
      const pair = from * this.n + to
      if (due < this.lastReliableDue[pair]) due = this.lastReliableDue[pair]
      this.lastReliableDue[pair] = due
    }
    const p = this.acquire(data.length)
    p.buf.set(data)
    p.data = p.buf.subarray(0, data.length)
    p.from = from
    p.to = to
    p.ch = ch
    p.due = due
    p.seq = this.seq++
    this.pending.push(p)
  }

  private drain(peer: number, out: DrainEntry[]): void {
    const handed = this.handed[peer]
    for (let i = 0; i < handed.length; i++) this.release(handed[i])
    handed.length = 0
    const box = this.inbox[peer]
    for (let i = 0; i < box.length; i++) {
      const p = box[i]
      const e = out[i]
      if (e) {
        e.peer = p.from
        e.ch = p.ch
        e.data = p.data
      } else {
        out.push({ peer: p.from, ch: p.ch, data: p.data })
      }
      handed.push(p)
    }
    out.length = box.length
    box.length = 0
  }

  private acquire(len: number): Packet {
    const b = bucketOf(len)
    while (this.bufPool.length <= b) this.bufPool.push([])
    const buf = this.bufPool[b].pop() ?? new Uint8Array(1 << b)
    const p = this.packetPool.pop()
    if (p) {
      p.buf = buf
      return p
    }
    return { from: 0, to: 0, ch: 'fast', due: 0, seq: 0, buf, data: buf }
  }

  private release(p: Packet): void {
    this.bufPool[bucketOf(p.buf.length)].push(p.buf)
    this.packetPool.push(p)
  }

  private makeTransport(peer: number): NetTransport {
    return {
      // data entries stay valid until the next drain of this transport.
      send: (to, ch, data) => this.send(peer, to, ch, data),
      drain: (out) => this.drain(peer, out),
      closed: (other) => this.isClosed(peer, other),
      now: () => this.clock,
    }
  }
}
