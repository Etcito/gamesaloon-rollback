import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CostClass, DomainSpec, ZoneSessionConfig } from '../src/zones/index.ts'
import type { PointInput } from './pointsim.ts'
import { domainHashMismatches, FRAME_MS, killPeer, revivePeer, zoneRun, zoneSetup } from './zones/zoneHarness.ts'
import type { DomainHashMismatch, ZoneCtx, ZoneScenario } from './zones/zoneHarness.ts'
import { seatCell, ZonePointFactory } from './zones/zonePointSim.ts'
import type { ZonePointSim } from './zones/zonePointSim.ts'

const factory: ZoneScenario['factory'] = {
  gridCols: 8, gridRows: 8, cellSize: 1000, fieldPerCell: 0, windEvery: 30, windMag: 2, radius: 40,
  stopBelow: 4, sleepTicks: 3, shadowMargin: 1, goalY: 4000, maxGhosts: 16, maxEvents: 8, eventKinds: 1,
}
const PEERS = 4
const link = { rttMs: 40, jitterMs: 4 }

interface Internals {
  cfg: ZoneSessionConfig<PointInput>
  correct: (d: { spec: DomainSpec }, from: number, bytes: Uint8Array, smooth: boolean) => void
  rejoinAt: Float64Array
  awaitingSnapshot: boolean
  lastNews: Float64Array
}
const internals = (ctx: ZoneCtx, p: number): Internals => ctx.sessions[p] as unknown as Internals

/** Every seat holds its starting cell, so control words, and with them the assignments, stay put. */
function pinned(sc: Omit<ZoneScenario, 'peers' | 'factory' | 'movement'>): ZoneScenario {
  const seats = Array.from({ length: PEERS }, (_, s) => s)
  const sim = new ZonePointFactory({ ...factory, seatCount: PEERS }).create({ id: 1, kind: 'seat', cells: [], seats, replicas: [] }, 0)
  const cells = seats.map((s) => seatCell(sim, s))
  return { ...sc, peers: PEERS, factory, link, movement: (seat) => cells[seat] }
}

/** Count shared confirmed samples so an empty comparison cannot pass. */
function sharedSamples(ctx: ZoneCtx, from = 0): number {
  let shared = 0
  for (let a = 0; a < ctx.confirmed.length; a++) {
    for (const [domain, ticks] of ctx.confirmed[a]) {
      for (let b = a + 1; b < ctx.confirmed.length; b++) {
        const other = ctx.confirmed[b].get(domain)
        if (other) for (const tick of ticks.keys()) if (tick >= from && other.has(tick)) shared++
      }
    }
  }
  return shared
}

/** No permanent stall: every live peer confirms each domain it replicates past the scripted frames. */
function assertConfirmedPast(ctx: ZoneCtx, tick: number, label: string): void {
  for (let p = 0; p < ctx.sessions.length; p++) {
    if (!ctx.alive[p]) continue
    const s = ctx.sessions[p]
    for (const spec of s.assignment.domains) {
      if (!s.domain(spec.id)) continue
      assert.ok(s.stats.confirmedTick[spec.id] >= tick, `${label}: peer ${p} domain ${spec.id} confirmed ${s.stats.confirmedTick[spec.id]} < ${tick}`)
    }
  }
}

const corruptFrame = 150

for (const cls of ['tiebreak', 'checkpoint', 'reset'] as const satisfies readonly CostClass[]) {
  test(`zone forced disagreement, ${cls}: only the corrupted domain recovers and every replica agrees again`, () => {
    const sc = pinned({ frames: 480, settle: 180, tuning: cls === 'tiebreak' ? { costClass: { seat: 'tiebreak' } } : {} })
    const ctx = zoneSetup(sc)
    const K = ctx.tuning.epochTicks
    const a = ctx.sessions[0].assignment
    // Reset is the global domain's class by default; the seat domains default to checkpoint.
    const spec = cls === 'reset' ? a.domains.find((d) => d.kind === 'global')! : a.domains.find((d) => d.id === a.seatDomain[1])!
    assert.equal(ctx.tuning.costClass[spec.kind], cls, 'scenario: the target domain has the class under test')
    const victim = spec.replicas[spec.replicas.length - 1]
    assert.notEqual(victim, spec.replicas[0], 'scenario: the victim is not the authority')
    const corrections: { peer: number; from: number; smooth: boolean; tick: number }[] = []
    const resets: { peer: number; tick: number }[] = []
    for (let p = 0; p < PEERS; p++) {
      const s = internals(ctx, p)
      const correct = s.correct.bind(s)
      s.correct = (d, from, bytes, smooth) => {
        if (d.spec.id === spec.id) corrections.push({ peer: p, from, smooth, tick: ctx.sessions[p].stats.tick })
        correct(d, from, bytes, smooth)
      }
      const f = ctx.factories[p], reset = f.reset.bind(f)
      f.reset = (sp, tick) => {
        if (sp.id === spec.id) resets.push({ peer: p, tick })
        return reset(sp, tick)
      }
    }
    let ct = -1
    sc.hook = (frame) => {
      if (frame !== corruptFrame) return
      const s = ctx.sessions[victim]
      ct = s.domain(spec.id)!.sim.tick
      // The global domain only keeps an event ledger; a seat domain hashes positions.
      assert.ok(s.debugCorrupt(spec.id, (sim) => {
        if (spec.kind === 'global') (sim as ZonePointSim).ledger[0]++
        else (sim as ZonePointSim).x[0] += 7
      }))
    }
    const all = zoneRun(sc, ctx)
    assert.ok(ct > 0, 'corruption ran')
    assert.ok(ctx.sessions[victim].stats.desyncs > 0, 'the victim entered an episode')

    let done: number
    if (cls === 'tiebreak') {
      assert.ok(corrections.length > 0 && corrections.every((c) => c.peer === victim), 'only the loser restores')
      const c = corrections.find((x) => x.smooth)
      assert.ok(c && c.from > ct, 'the loser takes the producer snapshot through CorrectionSmoother')
      assert.ok(ctx.sessions[victim].domain(spec.id)!.smoother !== null, 'the loser has a CorrectionSmoother')
      done = Math.max(...corrections.map((x) => x.tick))
    } else if (cls === 'checkpoint') {
      const kf = ctx.tuning.keyframeEvery * K
      for (const p of spec.replicas) {
        const c = corrections.find((x) => x.peer === p)
        assert.ok(c && !c.smooth && c.from % kf === 0 && c.from <= ct, `replica ${p} rolls back to the last agreed keyframe`)
      }
      done = Math.max(...corrections.map((x) => x.tick))
    } else {
      const B = resets.find((r) => r.peer === victim)?.tick
      assert.ok(B !== undefined && B % K === 0 && B > ct, 'the victim resets at the next epoch boundary')
      for (const p of spec.replicas) assert.ok(resets.some((r) => r.peer === p && r.tick === B), `replica ${p} resets at ${B}`)
      done = B
    }
    for (const m of all) {
      assert.equal(m.domain, spec.id, 'disagreement stays in the corrupted domain')
      assert.ok(m.tick > ct && m.tick < done, `disagreement at ${m.tick} lies inside the episode (${ct}, ${done})`)
    }
    assert.ok(sharedSamples(ctx, done) > 0, 'replicas compared hashes after the episode')
    assertConfirmedPast(ctx, sc.frames, cls)
  })
}

/** Records every bot input of one seat: driving peer, tick and virtual time. */
function spyBots(ctx: ZoneCtx, seat: number): { peer: number; tick: number; at: number }[] {
  const bots: { peer: number; tick: number; at: number }[] = []
  for (let p = 0; p < PEERS; p++) {
    const cfg = internals(ctx, p).cfg, botInput = cfg.botInput!
    cfg.botInput = (s, tick, out) => {
      if (s === seat) bots.push({ peer: p, tick, at: ctx.net.now() })
      botInput(s, tick, out)
    }
  }
  return bots
}

test('zone drop: the bot host drives the lost seat after botTakeoverMs and the others play on', () => {
  const sc = pinned({ frames: 600, settle: 180 })
  const ctx = zoneSetup(sc)
  const gone = 3, seat = ctx.roster.peers[gone].seats[0], killFrame = 120
  const bots = spyBots(ctx, seat)
  const reported: { peer: number; lost: number }[] = []
  for (let p = 0; p < PEERS; p++) ctx.sessions[p].onPeerLost = (lost) => { reported.push({ peer: p, lost }) }
  const heard: number[] = []
  sc.hook = (frame) => {
    if (frame === killFrame) {
      killPeer(ctx, gone)
      ctx.net.kill(gone)
    }
    // Nothing from the dropped peer arrives after its kill.
    if (frame === killFrame + 1) for (let p = 0; p < PEERS; p++) heard[p] = internals(ctx, p).lastNews[gone]
  }
  assert.deepEqual(zoneRun(sc, ctx), [])
  assert.ok(sharedSamples(ctx) > 0, 'replicas compared hashes')
  for (let p = 0; p < PEERS; p++) {
    if (p === gone) continue
    assert.ok(reported.some((r) => r.peer === p && r.lost === gone), `peer ${p} reported the drop`)
    assert.deepEqual(ctx.sessions[p].stats.lostPeers, [gone], `peer ${p} lists the lost peer`)
  }
  assert.ok(bots.length > 0, 'a bot drives the lost seat')
  // The elected host may change at each epoch, but one peer drives each tick.
  const driver = new Map<number, number>()
  for (const b of bots) {
    assert.ok((driver.get(b.tick) ?? b.peer) === b.peer, `tick ${b.tick} has a single bot host`)
    driver.set(b.tick, b.peer)
  }
  assert.ok(bots[0].at - heard[bots[0].peer] > ctx.tuning.botTakeoverMs, 'the bot takes over only after botTakeoverMs without news')
  assert.ok(Math.max(...bots.map((b) => b.tick)) >= sc.frames, 'the bot drives the seat to the end')
  assertConfirmedPast(ctx, sc.frames, 'drop')
})

/** Deep copy of one peer's recorded confirmed hashes. */
function recorded(ctx: ZoneCtx, peer: number): Map<number, Map<number, number>> {
  return new Map([...ctx.confirmed[peer]].map(([d, ticks]) => [d, new Map(ticks)]))
}

/**
 * The side that lost a split replaces its history from the split to its switch boundary R: those samples, recorded
 * after `before` was taken and below R, are not part of the established timeline. Everything else is compared.
 */
function mismatchesAfterResync(ctx: ZoneCtx, peer: number, before: Map<number, Map<number, number>>, R: number): DomainHashMismatch[] {
  for (const [domain, ticks] of ctx.confirmed[peer]) {
    for (const tick of [...ticks.keys()]) if (tick < R && !before.get(domain)?.has(tick)) ticks.delete(tick)
  }
  return domainHashMismatches(ctx)
}

/** Tracks the rejoin of one peer: the established side's boundary R, and the rejoiner's observer phase. */
interface RejoinWatch { R: number; observed: boolean; adopted: number; hook: () => void }

function watchRejoin(ctx: ZoneCtx, peer: number): RejoinWatch {
  const w: RejoinWatch = { R: Infinity, observed: false, adopted: Infinity, hook: () => {} }
  w.hook = (): void => {
    const R = internals(ctx, 0).rejoinAt[peer]
    if (w.R === Infinity && R !== Infinity) w.R = R
    const s = internals(ctx, peer)
    if (s.awaitingSnapshot) w.observed = true
    else if (w.observed && w.adopted === Infinity) w.adopted = s.rejoinAt[peer]
  }
  return w
}

/** After the switch, the rejoiner plays its own seat again, on the same assignment as everyone else. */
function assertRejoined(ctx: ZoneCtx, peer: number, w: RejoinWatch, label: string): void {
  const K = ctx.tuning.epochTicks, seat = ctx.roster.peers[peer].seats[0]
  assert.ok(w.observed, `${label}: the returning peer resynced as an observer`)
  assert.ok(w.R !== Infinity && w.R % K === 0, `${label}: the switch is an epoch boundary (${w.R})`)
  assert.equal(w.adopted, w.R, `${label}: both sides switch at the same boundary`)
  const a = ctx.sessions[0].assignment
  for (let p = 0; p < PEERS; p++) {
    const b = ctx.sessions[p].assignment
    assert.equal(b.epoch, a.epoch, `${label}: peer ${p} epoch`)
    assert.deepEqual(b.domains, a.domains, `${label}: peer ${p} domains`)
    assert.equal(b.seatHost[seat], peer, `${label}: peer ${p} sees the owner driving its seat`)
  }
  const d = ctx.sessions[peer].domain(a.seatDomain[seat])
  assert.ok(d && d.start >= w.R, `${label}: the returning peer's seat domain starts at or after the switch`)
}

test('zone rejoin: a returning peer observes, then takes its seat back at the epoch boundary', () => {
  const sc = pinned({ frames: 900, settle: 180 })
  const ctx = zoneSetup(sc)
  const gone = 3, seat = ctx.roster.peers[gone].seats[0], killFrame = 120
  // Longer than lostAfterMs and dropWaitMs together, so the others drop it first.
  const reviveFrame = killFrame + Math.ceil(5000 / FRAME_MS)
  const bots = spyBots(ctx, seat)
  const w = watchRejoin(ctx, gone)
  let before = recorded(ctx, gone)
  sc.hook = (frame) => {
    if (frame === killFrame) killPeer(ctx, gone)
    if (frame === reviveFrame) {
      assert.deepEqual(ctx.sessions[0].stats.lostPeers, [gone], 'the others dropped the peer')
      before = recorded(ctx, gone)
      revivePeer(ctx, gone)
    }
    if (frame > reviveFrame) w.hook()
  }
  zoneRun(sc, ctx)
  assertRejoined(ctx, gone, w, 'rejoin')
  assert.ok(bots.length > 0 && bots.every((b) => b.tick < w.R), 'the bot drives the seat until the switch only')
  assert.deepEqual(mismatchesAfterResync(ctx, gone, before, w.R), [])
  assert.ok(sharedSamples(ctx, w.R) > 0, 'replicas compared hashes after the switch')
  for (let p = 0; p < PEERS; p++) assert.deepEqual(ctx.sessions[p].stats.lostPeers, [], `peer ${p}: nobody stays lost`)
  assertConfirmedPast(ctx, sc.frames, 'rejoin')
})

for (const seconds of [0.5, 2, 5]) {
  test(`zone partition of ${seconds} s heals with no per-domain hash mismatch and no permanent stall`, () => {
    const start = 120, heal = start + Math.round(seconds * 1000 / FRAME_MS)
    const sc = pinned({ frames: heal + 600, settle: 180 })
    const ctx = zoneSetup(sc)
    const minority = 3
    const w = watchRejoin(ctx, minority)
    let before = recorded(ctx, minority)
    sc.hook = (frame) => {
      if (frame === start) {
        before = recorded(ctx, minority)
        ctx.net.partition([[0, 1, 2], [minority]])
      }
      if (frame === heal) ctx.net.heal()
      if (frame > heal) w.hook()
    }
    zoneRun(sc, ctx)
    const split = seconds * 1000 > (internals(ctx, 0).cfg.lostAfterMs ?? 3000)
    if (split) {
      // Both sides dropped each other; the side holding the lowest id keeps its state.
      assertRejoined(ctx, minority, w, `${seconds} s`)
      assert.deepEqual(mismatchesAfterResync(ctx, minority, before, w.R), [])
      assert.ok(sharedSamples(ctx, w.R) > 0, 'replicas compared hashes after the switch')
    } else {
      assert.equal(w.R, Infinity, 'nobody was dropped')
      assert.deepEqual(domainHashMismatches(ctx), [])
      assert.ok(sharedSamples(ctx, heal) > 0, 'replicas compared hashes after the heal')
    }
    for (let p = 0; p < PEERS; p++) assert.deepEqual(ctx.sessions[p].stats.lostPeers, [], `peer ${p}: nobody stays lost`)
    assertConfirmedPast(ctx, sc.frames, `${seconds} s`)
  })
}
