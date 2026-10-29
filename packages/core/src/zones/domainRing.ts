// The state history of one domain: a snapshot ring, a confirmed-hash ring and the last agreed keyframe.
// Sizes come from ZoneTuning. Buffers are reused; restore only wraps a slot in a SnapReader, as RollbackSession does.

import { SnapReader, SnapWriter } from '../snap.ts'
import type { DomainSim } from './types.ts'
import type { ZoneTuning } from './tuning.ts'

/** The last agreed keyframe of a domain: its tick (-1 when none) and its snapshot bytes. */
export interface DomainKeyframe {
  readonly tick: number
  /** A view of the reused keyframe buffer; valid until the next keyframe is taken. */
  readonly bytes: Uint8Array
}

export class DomainRing {
  /** Ring size: slot of tick t is t mod size, for snapshots and hashes alike. */
  readonly size: number
  /** Ticks between agreed keyframes: keyframeEvery epochs of epochTicks. */
  readonly keyframeTicks: number
  private readonly ring: SnapWriter[] = []
  private readonly ringTick: Int32Array
  private readonly hashTick: Int32Array
  private readonly hashValue: Uint32Array
  private kfBuf = new Uint8Array(0)
  private kfLen = 0
  private kfTick = -1
  private readonly kf = { tick: -1, bytes: this.kfBuf }

  constructor(tuning: ZoneTuning) {
    this.size = tuning.snapshotRing
    this.keyframeTicks = tuning.keyframeEvery * tuning.epochTicks
    for (let i = 0; i < this.size; i++) this.ring.push(new SnapWriter())
    this.ringTick = new Int32Array(this.size).fill(-1)
    this.hashTick = new Int32Array(this.size).fill(-1)
    this.hashValue = new Uint32Array(this.size)
  }

  /** Forgets every snapshot, hash and keyframe: the domain was rebuilt, restored from DOMAIN_SNAPSHOT or reset. */
  reset(): void {
    this.ringTick.fill(-1)
    this.hashTick.fill(-1)
    this.kfLen = 0
    this.kfTick = -1
  }

  /** Writes the snapshot of tick t (the state just before step t) into slot t mod size. */
  save(sim: DomainSim<unknown>, t: number): void {
    const r = t % this.size
    const w = this.ring[r]
    w.reset()
    sim.snapshot(w)
    this.ringTick[r] = t
  }

  /** True while the snapshot of tick t is still in the ring. */
  has(t: number): boolean {
    return t >= 0 && this.ringTick[t % this.size] === t
  }

  /** The newest tick at or below t whose snapshot is in the ring, or -1. */
  latestAtOrBefore(t: number): number {
    const low = t - this.size
    for (let c = t; c > low && c >= 0; c--) if (this.ringTick[c % this.size] === c) return c
    return -1
  }

  /** Restores tick t into sim and sets sim.tick = t. Returns false, leaving sim untouched, when t left the ring. */
  restore(sim: DomainSim<unknown>, t: number): boolean {
    if (!this.has(t)) return false
    sim.restore(new SnapReader(this.ring[t % this.size].bytes()))
    sim.tick = t
    return true
  }

  /** The snapshot bytes of tick t (for DOMAIN_SNAPSHOT), or null when t left the ring. Valid until slot t is reused. */
  bytesAt(t: number): Uint8Array | null {
    return this.has(t) ? this.ring[t % this.size].bytes() : null
  }

  /** Records the confirmed hash of tick t; overwrites the hash of tick t - size. */
  recordHash(t: number, hash: number): void {
    const r = t % this.size
    this.hashTick[r] = t
    this.hashValue[r] = hash >>> 0
  }

  /** True while a confirmed hash of tick t is in the hash ring. */
  hasHash(t: number): boolean {
    return t >= 0 && this.hashTick[t % this.size] === t
  }

  /** The confirmed hash of tick t, or undefined when it is not in the hash ring. */
  hashAt(t: number): number | undefined {
    const r = t % this.size
    return t >= 0 && this.hashTick[r] === t ? this.hashValue[r] : undefined
  }

  /** True when tick t is a keyframe tick: a multiple of keyframeEvery epochs. */
  isKeyframeTick(t: number): boolean {
    return t >= 0 && t % this.keyframeTicks === 0
  }

  /**
   * The replicas agreed on tick t: copies its ring snapshot into the keyframe buffer. Returns false when t left the
   * ring or is older than the current keyframe; the previous keyframe stays.
   */
  agreeKeyframe(t: number): boolean {
    if (t <= this.kfTick || !this.has(t)) return false
    this.copyKeyframe(t, this.ring[t % this.size].bytes())
    return true
  }

  /** Adopts tick t with the given snapshot (a reassembled DOMAIN_SNAPSHOT) as the agreed keyframe. */
  adoptKeyframe(t: number, bytes: Uint8Array): void {
    this.copyKeyframe(t, bytes)
  }

  /** The last agreed keyframe, or null when none was taken since the last reset. Returns a reused object. */
  lastAgreedKeyframe(): DomainKeyframe | null {
    if (this.kfTick < 0) return null
    const kf = this.kf
    kf.tick = this.kfTick
    kf.bytes = this.kfBuf.subarray(0, this.kfLen)
    return kf
  }

  /** Restores the last agreed keyframe into sim and returns its tick, or -1 when there is none. */
  restoreKeyframe(sim: DomainSim<unknown>): number {
    if (this.kfTick < 0) return -1
    sim.restore(new SnapReader(this.kfBuf.subarray(0, this.kfLen)))
    sim.tick = this.kfTick
    return this.kfTick
  }

  /** Drops every snapshot and hash after tick t, so a rollback to t cannot reload a stale future tick. */
  truncateAfter(t: number): void {
    for (let r = 0; r < this.size; r++) {
      if (this.ringTick[r] > t) this.ringTick[r] = -1
      if (this.hashTick[r] > t) this.hashTick[r] = -1
    }
  }

  private copyKeyframe(t: number, bytes: Uint8Array): void {
    const n = bytes.length
    // Grows by doubling only when a snapshot outgrows the buffer; steady state reuses it.
    if (n > this.kfBuf.length) {
      let size = this.kfBuf.length || 1024
      while (size < n) size *= 2
      this.kfBuf = new Uint8Array(size)
    }
    this.kfBuf.set(bytes)
    this.kfLen = n
    this.kfTick = t
  }
}
