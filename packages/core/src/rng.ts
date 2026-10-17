// Deterministic randomness (mulberry32) and string hashing. Pure: the only source of randomness in sim code.

/** 32-bit integer finalizer (murmur3 fmix32), unsigned. */
function mix32(x: number): number {
  let h = x >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  get state(): number {
    return this.s
  }

  set state(v: number) {
    this.s = v >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }

  /** Uniform integer in [a, b], inclusive on both ends. */
  int(a: number, b: number): number {
    const lo = Math.ceil(Math.min(a, b))
    const hi = Math.floor(Math.max(a, b))
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  /** Independent stream derived from the current state and a salt; does not advance this Rng. */
  fork(salt: number): Rng {
    return new Rng(mix32((this.s ^ salt) >>> 0))
  }
}

/** FNV-1a 32-bit hash of the UTF-16 code units of s, unsigned. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
