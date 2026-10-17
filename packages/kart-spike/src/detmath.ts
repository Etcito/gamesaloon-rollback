// Deterministic transcendentals for the simulation (SIM SCOPE). Pure.
// Copied unchanged from the Monster Racer simulation core (same owner); only the three.js helper was dropped.
// Built only on + - * /, Math.sqrt, Math.abs, Math.floor, Math.round and literal constants,
// following the fdlibm algorithms (the ones V8 itself ports), so every browser computes the
// same bits: IEEE basic operations are correctly rounded and JS never contracts into an FMA.
// No module state and no allocation.

export const PI = 3.141592653589793
export const TAU = 6.283185307179586
export const HALF_PI = 1.5707963267948966

const PIO4 = 0.7853981633974483
const TWO_M27 = 7.450580596923828e-9
/** |x| above this is first reduced coarsely (deterministic, not accurate). */
const REDUCE_MAX = 1e6

// Cody-Waite pi/2 in three 33-bit parts plus a tail (fdlibm __ieee754_rem_pio2): n * PIO2_k is
// exact for n < 2^20, i.e. |x| up to REDUCE_MAX.
const INV_PIO2 = 6.36619772367581382433e-1
const PIO2_1 = 1.57079632673412561417
const PIO2_2 = 6.0771005063039659766e-11
const PIO2_2T = 2.02226624879595063154e-21
const PIO2_3 = 2.0222662487111664558e-21
const PIO2_3T = 8.47842766036889956997e-32

// __kernel_sin
const S1 = -1.66666666666666324348e-1
const S2 = 8.33333333332248946124e-3
const S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6
const S5 = -2.50507602534068634195e-8
const S6 = 1.58969099521155010221e-10

// __kernel_cos
const C1 = 4.16666666666666019037e-2
const C2 = -1.38888888888741095749e-3
const C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7
const C5 = 2.0875723212981748279e-9
const C6 = -1.13596475577881948265e-11

// __kernel_tan
const T0 = 3.33333333333334091986e-1
const T1 = 1.33333333333201242699e-1
const T2 = 5.39682539762260521377e-2
const T3 = 2.18694882948595424599e-2
const T4 = 8.86323982359930005737e-3
const T5 = 3.59207910759131235356e-3
const T6 = 1.45620945432529025516e-3
const T7 = 5.88041240820264096874e-4
const T8 = 2.46463134818469906812e-4
const T9 = 7.817944429395570923e-5
const T10 = 7.14072491382608190305e-5
const T11 = -1.85586374855275456654e-5
const T12 = 2.59073051863633712884e-5
const TAN_PIO4_LO = 3.06161699786838301793e-17
/** 0x3FE59428 00000000: above it __kernel_tan uses tan(pi/4 - x). */
const TAN_BIG = 0.6743354797363281
/** Veltkamp splitter 2^27 + 1: hi(v) = c - (c - v) with c = v * SPLIT keeps 26 bits. */
const SPLIT = 134217729

/** sin(x + y) on [-pi/4, pi/4], y the tail of x. iy = 0 means y is 0. */
function kSin(x: number, y: number, iy: number): number {
  const z = x * x
  const w = z * z
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6)
  const v = z * x
  if (iy === 0) return x + v * (S1 + z * r)
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

/** cos(x + y) on [-pi/4, pi/4]. */
function kCos(x: number, y: number): number {
  const z = x * x
  let w = z * z
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
  const hz = 0.5 * z
  w = 1 - hz
  return w + (1 - w - hz + (z * r - x * y))
}

/** tan(x + y) on [-pi/4, pi/4] when iy = 1, -1 / tan(x + y) when iy = -1. */
function kTan(x: number, y: number, iy: number): number {
  const neg = x < 0
  const ax = neg ? -x : x
  let z: number, w: number, v: number, s: number, r: number
  if (ax < 3.725290298461914e-9) {
    if (iy === 1) return x
    if (x === 0) return 1 / ax
    w = x + y
    const zc = w * SPLIT
    z = zc - (zc - w)
    v = y - (z - x)
    const a = -1 / w
    const tc = a * SPLIT
    const t = tc - (tc - a)
    s = 1 + t * z
    return t + a * (s + t * v)
  }
  const big = ax >= TAN_BIG
  if (big) {
    if (neg) {
      x = -x
      y = -y
    }
    z = PIO4 - x
    w = TAN_PIO4_LO - y
    x = z + w
    y = 0
  }
  z = x * x
  w = z * z
  r = T1 + w * (T3 + w * (T5 + w * (T7 + w * (T9 + w * T11))))
  v = z * (T2 + w * (T4 + w * (T6 + w * (T8 + w * (T10 + w * T12)))))
  s = z * x
  r = y + z * (s * (r + v) + y)
  r += T0 * s
  w = x + r
  if (big) {
    v = iy
    const res = v - 2 * (x - ((w * w) / (w + v) - r))
    return neg ? -res : res
  }
  if (iy === 1) return w
  // -1 / (x + r) accurately
  const zc = w * SPLIT
  z = zc - (zc - w)
  v = r - (z - x)
  const a = -1 / w
  const tc = a * SPLIT
  const t = tc - (tc - a)
  s = 1 + t * z
  return t + a * (s + t * v)
}

/** Where dsincos writes its result. */
export interface SinCos {
  s: number
  c: number
}

/**
 * Shared trig core. mode 0 = sin, 1 = cos, 2 = tan, 3 = sin and cos into out (returns sin).
 * Reduces x to y0 + y1 in [-pi/4, pi/4] plus a quadrant q, then runs the kernels.
 */
function trig(x: number, mode: number, out: SinCos | null): number {
  let ax = Math.abs(x)
  let y0: number
  let y1: number
  let iy = 1
  let q = 0
  if (ax <= PIO4) {
    if (ax < TWO_M27) {
      // sin x = tan x = x (keeps -0), cos x = 1
      if (out !== null) {
        out.s = x
        out.c = 1
      }
      return mode === 1 ? 1 : x
    }
    y0 = x
    y1 = 0
    iy = 0
  } else if (!(ax < Infinity)) {
    const nan = x - x
    if (out !== null) {
      out.s = nan
      out.c = nan
    }
    return nan
  } else {
    // Huge |x|: coarse reduction by the double nearest pi/2 until |x| <= REDUCE_MAX.
    while (ax > REDUCE_MAX) {
      const n = Math.round(x * INV_PIO2)
      q += n - 4 * Math.floor(n * 0.25)
      x = x - n * HALF_PI
      ax = Math.abs(x)
    }
    // Cody-Waite: x - n * pi/2 with pi/2 in three 33-bit parts (good to about 151 bits).
    const n = Math.round(x * INV_PIO2)
    q += n
    let r = x - n * PIO2_1
    let t = r
    let w: number
    w = n * PIO2_2
    r = t - w
    w = n * PIO2_2T - (t - r - w)
    t = r
    w = n * PIO2_3
    r = t - w
    w = n * PIO2_3T - (t - r - w)
    y0 = r - w
    y1 = r - y0 - w
    q = q - 4 * Math.floor(q * 0.25)
  }
  if (mode === 2) return kTan(y0, y1, q === 1 || q === 3 ? -1 : 1)
  if (mode === 0) {
    const v = q === 0 || q === 2 ? kSin(y0, y1, iy) : kCos(y0, y1)
    return q >= 2 ? -v : v
  }
  if (mode === 1) {
    const v = q === 0 || q === 2 ? kCos(y0, y1) : kSin(y0, y1, iy)
    return q === 1 || q === 2 ? -v : v
  }
  const s = kSin(y0, y1, iy)
  const c = kCos(y0, y1)
  const rs = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c
  if (out !== null) {
    out.s = rs
    out.c = q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s
  }
  return rs
}

export function dsin(x: number): number {
  return trig(x, 0, null)
}

export function dcos(x: number): number {
  return trig(x, 1, null)
}

/** Writes sin(x) to out.s and cos(x) to out.c with a single range reduction. */
export function dsincos(x: number, out: SinCos): void {
  trig(x, 3, out)
}

export function dtan(x: number): number {
  return trig(x, 2, null)
}

// fdlibm s_atan: atan of the breakpoints 0.5, 1, 1.5 and infinity, split into hi + lo.
const ATAN_HI0 = 4.63647609000806093515e-1
const ATAN_HI1 = 7.85398163397448278999e-1
const ATAN_HI2 = 9.82793723247329054082e-1
const ATAN_HI3 = 1.570796326794896558
const ATAN_LO0 = 2.26987774529616870924e-17
const ATAN_LO1 = 3.06161699786838301793e-17
const ATAN_LO2 = 1.39033110312309984516e-17
const ATAN_LO3 = 6.12323399573676603587e-17
const AT0 = 3.33333333333329318027e-1
const AT1 = -1.99999999998764832476e-1
const AT2 = 1.42857142725034663711e-1
const AT3 = -1.1111110405462355788e-1
const AT4 = 9.09088713343650656196e-2
const AT5 = -7.69187620504482999495e-2
const AT6 = 6.66107313738753120669e-2
const AT7 = -5.83357013379057348645e-2
const AT8 = 4.97687799461593236017e-2
const AT9 = -3.6531572744216915527e-2
const AT10 = 1.62858201153657823623e-2
const TWO_66 = 73786976294838210000

export function datan(x: number): number {
  const neg = x < 0
  let ax = neg ? -x : x
  if (ax >= TWO_66) {
    const z = ATAN_HI3 + ATAN_LO3
    return neg ? -z : z
  }
  if (!(ax === ax)) return x + x
  let id: number
  if (ax < 0.4375) {
    if (ax < TWO_M27) return x
    id = -1
    ax = x
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0
      ax = (2 * ax - 1) / (2 + ax)
    } else {
      id = 1
      ax = (ax - 1) / (ax + 1)
    }
  } else if (ax < 2.4375) {
    id = 2
    ax = (ax - 1.5) / (1 + 1.5 * ax)
  } else {
    id = 3
    ax = -1 / ax
  }
  const z = ax * ax
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return ax - ax * (s1 + s2)
  let hi: number, lo: number
  if (id === 0) {
    hi = ATAN_HI0
    lo = ATAN_LO0
  } else if (id === 1) {
    hi = ATAN_HI1
    lo = ATAN_LO1
  } else if (id === 2) {
    hi = ATAN_HI2
    lo = ATAN_LO2
  } else {
    hi = ATAN_HI3
    lo = ATAN_LO3
  }
  const r = hi - (ax * (s1 + s2) - lo - ax)
  return neg ? -r : r
}

const PI_LO = 1.2246467991473532e-16
const TWO_60 = 1152921504606847000

/** True for x < 0 and for -0. */
function signBit(x: number): boolean {
  return x < 0 || (x === 0 && 1 / x < 0)
}

/** fdlibm e_atan2: every quadrant, signed zeros and infinities as Math.atan2. */
export function datan2(y: number, x: number): number {
  if (!(x === x) || !(y === y)) return x + y
  if (x === 1) return datan(y)
  const yNeg = signBit(y)
  const xNeg = signBit(x)
  if (y === 0) return xNeg ? (yNeg ? -PI : PI) : y
  if (x === 0) return yNeg ? -HALF_PI : HALF_PI
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  if (ax === Infinity) {
    if (ay === Infinity) {
      const z = xNeg ? 3 * PIO4 : PIO4
      return yNeg ? -z : z
    }
    if (xNeg) return yNeg ? -PI : PI
    return yNeg ? -0 : 0
  }
  if (ay === Infinity) return yNeg ? -HALF_PI : HALF_PI
  let z: number
  let xn = xNeg
  if (ay > ax * TWO_60) {
    // |y/x| > 2^60
    z = HALF_PI + 0.5 * PI_LO
    xn = false
  } else if (xNeg && ay * TWO_60 < ax) {
    // |y/x| < 2^-60 with x < 0
    z = 0
  } else {
    z = datan(ay / ax)
  }
  if (!xn) return yNeg ? -z : z
  return yNeg ? z - PI_LO - PI : PI - (z - PI_LO)
}

/** asin through datan2; x is clamped to [-1, 1]. */
export function dasin(x: number): number {
  const c = x < -1 ? -1 : x > 1 ? 1 : x
  return datan2(c, Math.sqrt(1 - c * c))
}

/** acos through datan2; x is clamped to [-1, 1]. */
export function dacos(x: number): number {
  const c = x < -1 ? -1 : x > 1 ? 1 : x
  return datan2(Math.sqrt(1 - c * c), c)
}

// Exact powers of two 2^512 .. 2^1 and 2^-512 .. 2^-1, for scaling without rounding.
const P2_512 = 1.3407807929942597e154
const P2_256 = 1.157920892373162e77
const P2_128 = 3.402823669209385e38
const P2_64 = 18446744073709552000
const P2_32 = 4294967296
const P2_16 = 65536
const P2_8 = 256
const P2_4 = 16
const P2_2 = 4
const M2_512 = 7.458340731200207e-155
const M2_256 = 8.636168555094445e-78
const M2_128 = 2.938735877055719e-39
const M2_64 = 5.421010862427522e-20
const M2_32 = 2.3283064365386963e-10
const M2_16 = 0.0000152587890625
const M2_8 = 0.00390625
const M2_4 = 0.0625
const M2_2 = 0.25
const P2_54 = 18014398509481984
const M2_1000 = 9.332636185032189e-302
const MIN_NORMAL = 2.2250738585072014e-308

/** 2^k for an integer k in [-1022, 1023], built from exact multiplications. */
function pow2(k: number): number {
  let p = 1
  if (k >= 0) {
    if (k >= 512) { p *= P2_512; k -= 512 }
    if (k >= 256) { p *= P2_256; k -= 256 }
    if (k >= 128) { p *= P2_128; k -= 128 }
    if (k >= 64) { p *= P2_64; k -= 64 }
    if (k >= 32) { p *= P2_32; k -= 32 }
    if (k >= 16) { p *= P2_16; k -= 16 }
    if (k >= 8) { p *= P2_8; k -= 8 }
    if (k >= 4) { p *= P2_4; k -= 4 }
    if (k >= 2) { p *= P2_2; k -= 2 }
    if (k >= 1) p *= 2
  } else {
    k = -k
    if (k >= 512) { p *= M2_512; k -= 512 }
    if (k >= 256) { p *= M2_256; k -= 256 }
    if (k >= 128) { p *= M2_128; k -= 128 }
    if (k >= 64) { p *= M2_64; k -= 64 }
    if (k >= 32) { p *= M2_32; k -= 32 }
    if (k >= 16) { p *= M2_16; k -= 16 }
    if (k >= 8) { p *= M2_8; k -= 8 }
    if (k >= 4) { p *= M2_4; k -= 4 }
    if (k >= 2) { p *= M2_2; k -= 2 }
    if (k >= 1) p *= 0.5
  }
  return p
}

// fdlibm e_exp
const EXP_OVER = 7.09782712893383973096e2
const EXP_UNDER = -7.45133219101941108420e2
const LN2_HI = 6.9314718036912381649e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.442695040888963387
const EP1 = 1.66666666666666019037e-1
const EP2 = -2.77777777770155933842e-3
const EP3 = 6.61375632143793436117e-5
const EP4 = -1.6533902205465251539e-6
const EP5 = 4.13813679705723846039e-8

/** e^x: x = k ln2 + r, a rational approximation of e^r, then an exact scale by 2^k. */
export function dexp(x: number): number {
  if (!(x === x)) return x
  if (x > EXP_OVER) return Infinity
  if (x < EXP_UNDER) return 0
  if (Math.abs(x) < 3.725290298461914e-9) return 1 + x
  const k = Math.round(x * INV_LN2)
  const hi = x - k * LN2_HI
  const lo = k * LN2_LO
  const r = hi - lo
  const t = r * r
  const c = r - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))))
  if (k === 0) return 1 - ((r * c) / (c - 2) - r)
  const y = 1 - (lo - (r * c) / (2 - c) - hi)
  if (k >= -1021) return k === 1024 ? y * 2 * pow2(1023) : y * pow2(k)
  // Subnormal result: stay normal until the single rounding multiply by 2^-1000.
  return y * pow2(k + 1000) * M2_1000
}

// fdlibm e_log: log(1 + f) = f - f^2/2 + s (f^2/2 + R(s^2)) with s = f / (2 + f); R is the
// minimax form of the atanh series 2/3 s^2 + 2/5 s^4 + ... (Lg1 ~ 2/3, Lg2 ~ 2/5, ...).
const LG1 = 6.666666666666735130e-1
const LG2 = 3.999999999940941908e-1
const LG3 = 2.857142874366239149e-1
const LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1
const LG6 = 1.531383769920937332e-1
const LG7 = 1.479819860511658591e-1
const SQRT2 = 1.4142135623730951

/** Natural log: x = m 2^e with m in [sqrt(1/2), sqrt(2)) by exact scaling, then the series. */
export function dlog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN
  if (x === Infinity) return x
  let m = x
  let e = 0
  if (m < MIN_NORMAL) {
    m *= P2_54
    e = -54
  }
  if (m >= 2) {
    if (m >= P2_512) { m *= M2_512; e += 512 }
    if (m >= P2_256) { m *= M2_256; e += 256 }
    if (m >= P2_128) { m *= M2_128; e += 128 }
    if (m >= P2_64) { m *= M2_64; e += 64 }
    if (m >= P2_32) { m *= M2_32; e += 32 }
    if (m >= P2_16) { m *= M2_16; e += 16 }
    if (m >= P2_8) { m *= M2_8; e += 8 }
    if (m >= P2_4) { m *= M2_4; e += 4 }
    if (m >= P2_2) { m *= M2_2; e += 2 }
    if (m >= 2) { m *= 0.5; e += 1 }
  } else if (m < 1) {
    // m 2^p < 2 means m < 2^(1-p)
    if (m < M2_512 * 2) { m *= P2_512; e -= 512 }
    if (m < M2_256 * 2) { m *= P2_256; e -= 256 }
    if (m < M2_128 * 2) { m *= P2_128; e -= 128 }
    if (m < M2_64 * 2) { m *= P2_64; e -= 64 }
    if (m < M2_32 * 2) { m *= P2_32; e -= 32 }
    if (m < M2_16 * 2) { m *= P2_16; e -= 16 }
    if (m < M2_8 * 2) { m *= P2_8; e -= 8 }
    if (m < M2_4 * 2) { m *= P2_4; e -= 4 }
    if (m < M2_2 * 2) { m *= P2_2; e -= 2 }
    if (m < 1) { m *= 2; e -= 1 }
  }
  // m in [1, 2) here
  if (m >= SQRT2) {
    m *= 0.5
    e += 1
  }
  const f = m - 1
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const R = t2 + t1
  const hfsq = 0.5 * f * f
  if (e === 0) return f - (hfsq - s * (hfsq + R))
  return e * LN2_HI - (hfsq - (s * (hfsq + R) + e * LN2_LO) - f)
}

/**
 * x^y. An integer y with |y| <= 64 uses repeated squaring. x > 0 gives dexp(y * dlog(x)).
 * x = 0 and negative bases follow Math.pow (a negative base needs an integer y, else NaN).
 */
export function dpow(x: number, y: number): number {
  const isInt = Math.floor(y) === y
  if (isInt && Math.abs(y) <= 64) {
    let n = y < 0 ? -y : y
    let b = x
    let p = 1
    while (n > 0) {
      const half = Math.floor(n * 0.5)
      if (n - 2 * half === 1) p *= b
      n = half
      if (n > 0) b *= b
    }
    return y < 0 ? 1 / p : p
  }
  if (x > 0 || !(x === x)) return dexp(y * dlog(x))
  const odd = isInt && Math.abs(y) < Infinity && y - 2 * Math.floor(y * 0.5) === 1
  if (x === 0) {
    if (y > 0) return odd ? x : 0
    return odd ? 1 / x : Infinity
  }
  if (!isInt) return NaN
  const r = dexp(y * dlog(-x))
  return odd ? -r : r
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

export function dhypot3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}
