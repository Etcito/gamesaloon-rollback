// Epoch boundaries on the zoned PointSim: merge, split, handoff with grace, minimum residence, rollback across S.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateZoneTuning, ZONE_DEFAULTS } from '../src/zones/index.ts'
import type { Assignment } from '../src/zones/index.ts'
import { zoneRun, zoneSetup } from './zones/zoneHarness.ts'
import { seatCell } from './zones/zonePointSim.ts'
import type { ZonePointSim } from './zones/zonePointSim.ts'
import type { ZoneCtx, ZoneScenario } from './zones/zoneHarness.ts'

const COLS = 8

const factory: ZoneScenario['factory'] = {
  gridCols: COLS, gridRows: 8, cellSize: 512, fieldPerCell: 1, windEvery: 16, windMag: 1, radius: 16,
  stopBelow: 1, sleepTicks: 30, shadowMargin: 1, goalY: 1 << 30, maxGhosts: 16, maxEvents: 8, eventKinds: 1,
}

// Short epochs keep each case brief; leadTicks stays above maxPrediction + maxDelay.
const tuning = { epochTicks: 30, leadTicks: 25, handoffGraceTicks: 10, minResidenceEpochs: 2 }
const K = tuning.epochTicks

test('tuning overrides are valid', () => {
  for (const epochTicks of [K, 3 * K]) validateZoneTuning({ ...ZONE_DEFAULTS, gridCols: COLS, ...tuning, epochTicks })
})

type EpochLog = Map<number, Assignment>

/** Per peer, the assignment of every epoch, by epoch (planned before its boundary S, then held). */
function watchEpochs(ctx: ZoneCtx, log: EpochLog[]): void {
  ctx.sessions.forEach((s, p) => {
    if (!log[p].has(s.assignment.epoch)) log[p].set(s.assignment.epoch, s.assignment)
  })
}

/** The first epoch at or after `from` whose seatDomain satisfies `ok`, or -1. */
function firstEpoch(log: EpochLog, from: number, ok: (sd: Int32Array) => boolean): number {
  for (const [e, a] of [...log].sort((x, y) => x[0] - y[0])) if (e >= from && ok(a.seatDomain)) return e
  return -1
}

const together = (sd: Int32Array): boolean => sd[0] === sd[1]
const apart = (sd: Int32Array): boolean => sd[0] !== sd[1]

/** Seat 0 parks at cell 0; seat 1 parks far away, then next to it (cell 1) from frame `meet` to `part`. */
function meetMovement(meet: number, part: number, parked: readonly number[] = []) {
  return (seat: number, frame: number): number | undefined => {
    if (seat === 0) return 0
    if (seat === 1) return frame >= meet && frame < part ? 1 : COLS - 1
    return parked[seat]
  }
}

test('merge: seats scripted next to each other share domain 1 + lower seat at the next boundary', () => {
  const log: EpochLog[] = [new Map(), new Map()]
  const sc: ZoneScenario = {
    peers: 2, frames: 8 * K, settle: 90, tuning, factory,
    movement: meetMovement(2 * K, Infinity),
    hook: (_f, ctx) => watchEpochs(ctx, log),
  }
  const ctx = zoneSetup(sc)
  const mismatches = zoneRun(sc, ctx)
  const sep = firstEpoch(log[0], 1, apart)
  assert.ok(sep >= 0, 'the seats start in separate domains')
  const merged = firstEpoch(log[0], sep, together)
  assert.ok(merged > sep, 'the seats merge at a boundary')
  for (const l of log) {
    const a = l.get(merged)!
    assert.equal(a.seatDomain[0], 1, 'merged domain id is 1 + the lower seat')
    assert.deepEqual(a.domains.find((d) => d.id === 1)!.seats, [0, 1])
  }
  for (const c of ctx.confirmed) assert.ok(c.get(1)!.has(merged * K + K - 1), 'both replicas confirm the merged domain')
  assert.deepEqual(mismatches, [])
})

test('split: seats scripted apart split into two domains after minResidenceEpochs', () => {
  const log: EpochLog[] = [new Map(), new Map()]
  const sc: ZoneScenario = {
    peers: 2, seed: 2, frames: 12 * K, settle: 90, tuning, factory,
    movement: meetMovement(2 * K, 7 * K),
    hook: (_f, ctx) => watchEpochs(ctx, log),
  }
  const mismatches = zoneRun(sc)
  const merged = firstEpoch(log[0], 1, together)
  assert.ok(merged > 0, 'the seats merge first')
  const split = firstEpoch(log[0], merged, apart)
  assert.ok(split > merged, 'the seats split at a later boundary')
  assert.ok(split - merged >= tuning.minResidenceEpochs, 'no split before the minimum residence')
  for (const l of log) {
    const sd = l.get(split)!.seatDomain
    assert.deepEqual([sd[0], sd[1]], [1, 2], 'each seat back in its own domain')
  }
  assert.deepEqual(mismatches, [])
})

test('handoff: a replica that held one source receives DOMAIN_SNAPSHOT; old replicas keep the sources for the grace', () => {
  // 3 peers: merged domain 1 lists peers 0 and 1; peer 1 held only source 2, peer 2 held only source 1.
  const log: EpochLog[] = [new Map(), new Map(), new Map()]
  const grace = tuning.handoffGraceTicks
  let S = -1
  let transfer = false
  let built = false
  const held: boolean[][] = [[], [], []]
  const dropped: boolean[][] = [[], [], []]
  const sc: ZoneScenario = {
    peers: 3, frames: 9 * K, settle: 90, tuning, factory,
    movement: meetMovement(2 * K, Infinity, [0, 0, 63]),
    hook: (_f, ctx) => {
      watchEpochs(ctx, log)
      const d = ctx.sessions[1].domain(1)
      if (S < 0 && d && d.start > 0) {
        S = d.start
        transfer = d.build !== null && d.build.transfers.some((t) => t.source === 1 && t.targets.includes(1))
      }
      if (S > 0 && d && d.build === null && (ctx.sessions[1].stats.confirmedTick[1] ?? -1) >= S) built = true
      if (S < 0) return
      const prev = log[0].get(S / K - 1)!
      ctx.sessions.forEach((s, p) => {
        const t = s.stats.tick
        for (const src of [1, 2]) {
          if (!prev.domains.find((x) => x.id === src)!.replicas.includes(p)) continue
          const kept = s.confirmedHash(src, S - 1) !== undefined
          if (t > S && t < S + grace) held[p].push(kept)
          if (t >= S + grace + K) dropped[p].push(!kept)
        }
      })
    },
  }
  const mismatches = zoneRun(sc)
  assert.ok(S > 0 && S % K === 0, 'the merge lands on a boundary')
  assert.equal(log[1].get(S / K)!.seatDomain[1], 1)
  assert.deepEqual(log[1].get(S / K)!.domains.find((x) => x.id === 1)!.replicas.slice().sort(), [0, 1])
  assert.ok(transfer, 'peer 1 waits for the export of source 1 at S')
  assert.ok(built, 'peer 1 builds domain 1 from the DOMAIN_SNAPSHOT and confirms it')
  for (let p = 0; p < 3; p++) {
    assert.ok(held[p].length > 0 && held[p].every(Boolean), `peer ${p} keeps its sources until S + handoffGraceTicks`)
    assert.ok(dropped[p].length > 0 && dropped[p].every(Boolean), `peer ${p} drops its sources after the grace`)
  }
  assert.deepEqual(mismatches, [])
})

test('minimum residence: a seat moving across rEnter/rExit changes domain at most once per minResidenceEpochs', () => {
  // Seat 1 swings between rEnter and beyond rExit of seat 0 every epoch. Longer epochs leave time to travel: the
  // harness steers from the planned state, which holds its start pose from S-L until S.
  const rt = { ...tuning, epochTicks: 3 * K }
  const E = rt.epochTicks
  const near = ZONE_DEFAULTS.rEnter
  const far = ZONE_DEFAULTS.rExit + 2
  const log: EpochLog[] = [new Map(), new Map()]
  const wish: boolean[] = []
  let cell = -1
  const sc: ZoneScenario = {
    peers: 2, frames: 14 * E, settle: 60, tuning: rt, factory: { ...factory, cellSize: 256 },
    movement: (seat, frame) => seat === 0 ? 0 : Math.floor(frame / E) % 2 === 0 ? near : far,
    hook: (_f, ctx) => {
      const s = ctx.sessions[1]
      // The plan follows its control sample closely: the last running pose before it stands for the sampled cell.
      if (!log[1].has(s.assignment.epoch) && cell >= 0) wish.push(cell % COLS <= near)
      watchEpochs(ctx, log)
      const d = s.domain(s.assignment.seatDomain[1])
      if (d && d.start <= s.stats.tick) cell = seatCell(d.sim as ZonePointSim, 1)
    },
  }
  const mismatches = zoneRun(sc)
  const changes: number[] = []
  let last = -1
  for (const [e, a] of [...log[1]].sort((x, y) => x[0] - y[0])) {
    if (last >= 0 && a.seatDomain[1] !== last) changes.push(e)
    last = a.seatDomain[1]
  }
  let flips = 0
  for (let i = 1; i < wish.length; i++) if (wish[i] !== wish[i - 1]) flips++
  assert.ok(changes.length >= 2, `seat 1 changes domain (${changes})`)
  assert.ok(flips > changes.length, `the near/far wish flips more often (${flips}) than the domain changes`)
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i] - changes[i - 1] >= tuning.minResidenceEpochs, `changes at epochs ${changes}`)
  }
  assert.deepEqual(mismatches, [])
})

test('a rollback across a boundary still gives zero mismatches', () => {
  // Jittered latency: late inputs of the ticks before S arrive after the peers stepped S.
  const log: EpochLog[] = [new Map(), new Map(), new Map()]
  let crossing = 0
  const rollbacks = [0, 0, 0]
  const sc: ZoneScenario = {
    peers: 3, seed: 5, frames: 12 * K, tuning, factory,
    link: { rttMs: 120, jitterMs: 40 },
    movement: meetMovement(2 * K, 7 * K, [0, 0, 63]),
    hook: (_f, ctx) => {
      watchEpochs(ctx, log)
      ctx.sessions.forEach((s, p) => {
        const t = s.stats.tick
        if (s.stats.rollbacks > rollbacks[p] && t % K < s.stats.maxRollback && t >= K) crossing++
        rollbacks[p] = s.stats.rollbacks
      })
    },
  }
  const mismatches = zoneRun(sc)
  const merged = firstEpoch(log[0], 1, together)
  assert.ok(merged > 0 && firstEpoch(log[0], merged, apart) > merged, 'the run merges and splits')
  assert.ok(crossing > 0, 'some rollback reached back across a boundary')
  assert.deepEqual(mismatches, [])
})
