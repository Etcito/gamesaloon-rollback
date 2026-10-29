import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainFrontier } from '../src/zones/frontier.ts'
import type { DomainSpec } from '../src/zones/types.ts'
import { zoneRun, zoneSetup } from './zones/zoneHarness.ts'
import type { ZoneScenario } from './zones/zoneHarness.ts'

// Every cell of a 2 by 2 grid touches the others, so the four seats form one component. Cpu class 0 holds two seats,
// so the component splits into two seat domains that shadow each other, whenever no residence lock keeps it apart.
const factory: ZoneScenario['factory'] = {
  gridCols: 2, gridRows: 2, cellSize: 1000, fieldPerCell: 0, windEvery: 30, windMag: 2, radius: 40,
  stopBelow: 4, sleepTicks: 3, shadowMargin: 1, goalY: 1000, maxGhosts: 16, maxEvents: 8, eventKinds: 1,
}

test('zone seat domains that shadow each other confirm at full rate over a slow link', () => {
  // One epoch keeps the pair for the whole run.
  const sc: ZoneScenario = {
    peers: 4, seed: 7, frames: 300, settle: 120, factory, link: { rttMs: 100, jitterMs: 16 }, classes: { cpuClass: 0 },
    tuning: { epochTicks: 600 },
  }
  const ctx = zoneSetup(sc)
  const a = ctx.sessions[0].assignment
  const pair = a.shadows.map((l) => `${l.from}>${l.to}`).sort()
  const seated = [...a.seatDomain].sort((x, y) => x - y)
  assert.deepEqual(pair, [`${seated[0]}>${seated[3]}`, `${seated[3]}>${seated[0]}`], 'scenario: every seat sits in a shadow pair')
  assert.deepEqual(zoneRun(sc, ctx), [])
  // A pair that waits for each other's confirmation of the tick before advances one tick per network trip.
  for (let p = 0; p < sc.peers; p++) {
    const s = ctx.sessions[p]
    for (const spec of s.assignment.domains) {
      if (!s.domain(spec.id)) continue
      const confirmed = s.stats.confirmedTick[spec.id]
      assert.ok(confirmed >= sc.frames, `peer ${p} domain ${spec.id} confirmed ${confirmed}, below ${sc.frames}`)
    }
  }
})

test('zone state started at a boundary reads empty shadows for its first lag ticks, whatever arrives later', () => {
  const lag = 3, start = 60, from = 1
  const spec: DomainSpec = { id: 2, kind: 'seat', cells: [0], seats: [], replicas: [0] }
  const f = new DomainFrontier({ capacity: 64, shadowSlotBytes: 0, neutral: 0, shadowLag: lag }, spec, [from])
  f.startShadows(start)
  assert.equal(f.frontier(), start - 1 + lag)
  // Source ticks start and start + 1 are read at start + lag and after; a replica re-simulating start reads them later.
  assert.equal(f.setShadow(from, start, Uint8Array.of(7)), start + lag)
  f.setShadow(from, start + 1, Uint8Array.of(8))
  for (let t = start; t < start + lag; t++) assert.equal(f.view(t).reader(0).remaining, 0, `tick ${t} is empty`)
  assert.equal(f.view(start + lag).reader(0).u8(), 7)
  assert.equal(f.view(start + lag + 1).reader(0).u8(), 8)
  // The global domain sends nothing back, so it reads events at their own tick.
  const g = new DomainFrontier(f.cfg, { id: 0, kind: 'global', cells: [], seats: [], replicas: [0] }, [from])
  g.startShadows(start)
  assert.equal(g.frontier(), start - 1)
  g.setShadow(from, start, Uint8Array.of(9))
  assert.equal(g.view(start).reader(0).u8(), 9)
})

test('zone seats keep the frame clock through boundary waits for a snapshot', () => {
  // Seats change domains at boundaries; a peer new to a domain waits two trips for its snapshot, then catches up.
  const sc: ZoneScenario = {
    peers: 4, seed: 5, frames: 600, settle: 120, factory, link: { rttMs: 180, jitterMs: 16 }, classes: { cpuClass: 0 },
  }
  const ctx = zoneSetup(sc)
  assert.deepEqual(zoneRun(sc, ctx), [])
  const total = sc.frames + sc.settle!
  for (let p = 0; p < sc.peers; p++) {
    const s = ctx.sessions[p].stats
    assert.ok(s.stallFrames > 0, `scenario: peer ${p} waited`)
    assert.ok(s.tick >= total - 1, `peer ${p} reached tick ${s.tick} after ${total} frames`)
  }
})
