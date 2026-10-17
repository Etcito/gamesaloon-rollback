// Netcode timing: shared constants, input delay, RTT estimation, delay control and time sync.
// Pure. Times are in milliseconds and passed in; nothing here reads a clock.

export const DEFAULT_TICK_RATE = 60
export const DEFAULT_MAX_PREDICTION = 16
export const DEFAULT_SNAPSHOT_RING = 40
export const DEFAULT_MIN_DELAY = 2
export const DEFAULT_MAX_DELAY = 8
export const DEFAULT_LOST_AFTER_MS = 3000
export const DEFAULT_DROP_WAIT_MS = 1500
/** Ticks of latency the input delay leaves to rollback. */
export const DEFAULT_DELAY_HIDDEN_TICKS = 6

/** The delay target is re-evaluated this often. */
export const DELAY_EVAL_MS = 1000
/** The current delay moves by at most 1 tick per this interval. */
export const DELAY_STEP_MS = 500
/** Observations averaged per peer by TimeSync. */
export const TIME_SYNC_WINDOW = 32
/** Average advantage (ticks) above which the leading peer skips a tick. */
export const TIME_SYNC_MAX_ADVANTAGE = 2
/** Minimum ticks between two time-sync skips. */
export const TIME_SYNC_SKIP_INTERVAL = 30
/** Highest peer id + 1 (room capacity). Peer ids are one byte on the wire; raise this to grow rooms. */
export const MAX_PEERS = 8

export interface DelayParams {
  tickRate: number
  minDelay: number
  maxDelay: number
  hiddenTicks: number
}

export const DEFAULT_DELAY_PARAMS: DelayParams = {
  tickRate: DEFAULT_TICK_RATE,
  minDelay: DEFAULT_MIN_DELAY,
  maxDelay: DEFAULT_MAX_DELAY,
  hiddenTicks: DEFAULT_DELAY_HIDDEN_TICKS,
}

/**
 * D = clamp(ceil((rtt/2 + jitter) / tickMs) - hiddenTicks, minDelay, maxDelay).
 * The division by tickMs is done as * tickRate / 1000 so exact tick multiples do not round up.
 * At 120 Hz with the defaults, by hand:
 * - 0 ms RTT, 0 jitter: ceil(0 / 8.33) - 6 = -6, clamped to 2.
 * - 150 ms RTT, 20 ms jitter: (75 + 20) / 8.33 = 11.4, ceil 12, - 6 = 6.
 * - 400 ms RTT, 0 jitter: 200 / 8.33 = 24, - 6 = 18, clamped to 8.
 */
export function inputDelayFor(rttMs: number, jitterMs: number, p: DelayParams = DEFAULT_DELAY_PARAMS): number {
  const rtt = rttMs > 0 ? rttMs : 0
  const jit = jitterMs > 0 ? jitterMs : 0
  const oneWay = rtt / 2 + jit
  if (!(oneWay < Infinity)) return p.maxDelay
  const d = Math.ceil((oneWay * p.tickRate) / 1000) - p.hiddenTicks
  return d < p.minDelay ? p.minDelay : d > p.maxDelay ? p.maxDelay : d
}

/** Smoothed round-trip time: EWMA 1/8 for rtt, EWMA 1/4 of |sample - rtt| for jitter. */
export class RttEstimator {
  rtt = 0
  jitter = 0
  samples = 0

  sample(ms: number): void {
    if (!(ms >= 0 && ms < Infinity)) return
    if (this.samples === 0) {
      this.rtt = ms
      this.jitter = 0
    } else {
      const dev = Math.abs(ms - this.rtt)
      this.jitter += (dev - this.jitter) / 4
      this.rtt += (ms - this.rtt) / 8
    }
    this.samples++
  }

  reset(): void {
    this.rtt = 0
    this.jitter = 0
    this.samples = 0
  }
}

/** Moves the input delay toward inputDelayFor(maxRtt, maxJitter), re-evaluated each second, 1 tick per 500 ms at most. */
export class DelayController {
  current: number
  target: number
  private readonly params: DelayParams
  private lastEvalMs = -Infinity
  private lastStepMs = -Infinity

  constructor(initial?: number, params: DelayParams = DEFAULT_DELAY_PARAMS) {
    this.params = params
    const d = Math.round(initial ?? params.minDelay)
    this.current = d < params.minDelay ? params.minDelay : d > params.maxDelay ? params.maxDelay : d
    this.target = this.current
  }

  update(nowMs: number, maxRtt: number, maxJitter: number): number {
    if (nowMs - this.lastEvalMs >= DELAY_EVAL_MS) {
      this.target = inputDelayFor(maxRtt, maxJitter, this.params)
      this.lastEvalMs = nowMs
    }
    if (this.current !== this.target && nowMs - this.lastStepMs >= DELAY_STEP_MS) {
      this.current += this.target > this.current ? 1 : -1
      this.lastStepMs = nowMs
    }
    return this.current
  }
}

/**
 * Per-peer running average of the local advantage in ticks:
 * localTick - (senderTick + rttMs / 2 / tickMs), over TIME_SYNC_WINDOW observations.
 */
export class TimeSync {
  private readonly samples: Float64Array
  private readonly counts: Int32Array
  private readonly heads: Int32Array
  private readonly window: number
  private readonly tickMs: number
  private lastSkipTick = -Infinity

  constructor(tickRate = DEFAULT_TICK_RATE, window = TIME_SYNC_WINDOW) {
    const w = Math.max(1, Math.floor(window))
    this.window = w
    this.tickMs = 1000 / tickRate
    this.samples = new Float64Array(MAX_PEERS * w)
    this.counts = new Int32Array(MAX_PEERS)
    this.heads = new Int32Array(MAX_PEERS)
  }

  observe(peer: number, senderTick: number, localTick: number, rttMs: number): void {
    if (!(peer >= 0 && peer < MAX_PEERS) || !Number.isInteger(peer)) return
    const rtt = rttMs > 0 && rttMs < Infinity ? rttMs : 0
    const adv = localTick - (senderTick + rtt / 2 / this.tickMs)
    if (!(adv > -Infinity && adv < Infinity)) return
    const w = this.window
    this.samples[peer * w + this.heads[peer]] = adv
    this.heads[peer] = (this.heads[peer] + 1) % w
    if (this.counts[peer] < w) this.counts[peer]++
  }

  /** The average advantage over a peer, or 0 without observations. */
  advantage(peer: number): number {
    if (!(peer >= 0 && peer < MAX_PEERS)) return 0
    const n = this.counts[peer]
    if (n === 0) return 0
    const base = peer * this.window
    let sum = 0
    for (let i = 0; i < n; i++) sum += this.samples[base + i]
    return sum / n
  }

  /** The highest average advantage over all observed peers, or 0. */
  maxAdvantage(): number {
    let max = 0
    let any = false
    for (let p = 0; p < MAX_PEERS; p++) {
      if (this.counts[p] === 0) continue
      const a = this.advantage(p)
      if (!any || a > max) max = a
      any = true
    }
    return max
  }

  /** True (and the skip is recorded) when the local peer leads by more than 2 ticks and 30 ticks passed since the last skip. */
  shouldSkip(localTick: number): boolean {
    if (localTick - this.lastSkipTick < TIME_SYNC_SKIP_INTERVAL) return false
    if (!(this.maxAdvantage() > TIME_SYNC_MAX_ADVANTAGE)) return false
    this.lastSkipTick = localTick
    return true
  }

  /** Forgets a peer's observations (for example once it is lost). */
  forget(peer: number): void {
    if (!(peer >= 0 && peer < MAX_PEERS)) return
    this.counts[peer] = 0
    this.heads[peer] = 0
  }
}
