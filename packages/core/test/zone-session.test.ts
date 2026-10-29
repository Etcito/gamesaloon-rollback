import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapReader, SnapWriter } from '../src/index.ts'
import { decodeZone, ZMSG } from '../src/zones/index.ts'
import type { FarSink, ZoneSessionConfig } from '../src/zones/index.ts'
import type { PointInput } from './pointsim.ts'
import { zoneRun, zoneSetup } from './zones/zoneHarness.ts'
import type { ZoneCtx, ZoneScenario } from './zones/zoneHarness.ts'
import type { ZonePointSim } from './zones/zonePointSim.ts'

const factory: ZoneScenario['factory'] = {
  gridCols: 8, gridRows: 8, cellSize: 1000, fieldPerCell: 0, windEvery: 30, windMag: 2, radius: 40,
  stopBelow: 4, sleepTicks: 3, shadowMargin: 1, goalY: 4000, maxGhosts: 16, maxEvents: 8, eventKinds: 1,
}

/** (domain, tick) samples confirmed by two peers or more: proof that hashes were actually compared. */
function sharedSamples(ctx: ZoneCtx): number {
  let shared = 0
  for (let a = 0; a < ctx.confirmed.length; a++) {
    for (const [domain, ticks] of ctx.confirmed[a]) {
      for (let b = a + 1; b < ctx.confirmed.length; b++) {
        const other = ctx.confirmed[b].get(domain)
        if (other) for (const tick of ticks.keys()) if (other.has(tick)) shared++
      }
    }
  }
  return shared
}

test('zone replicas agree on every shared per-domain confirmed hash, 2 to 8 peers', () => {
  for (const peers of [2, 3, 5, 8]) {
    const sc: ZoneScenario = { peers, seed: peers, frames: 240, settle: 120, factory, link: { rttMs: 40, jitterMs: 8 } }
    const ctx = zoneSetup(sc)
    assert.deepEqual(zoneRun(sc, ctx), [], `${peers} peers`)
    assert.ok(sharedSamples(ctx) > 0, `${peers} peers compared no hash`)
    for (const s of ctx.sessions) assert.ok(s.stats.confirmedTick[0] >= sc.frames, `${peers} peers: global confirmed`)
  }
})

test('zone local seat keeps predicting while a far domain stalls', () => {
  // One epoch: the stall window crosses no boundary, whose plan would wait for the late controls too.
  const sc: ZoneScenario = { peers: 4, frames: 240, settle: 180, factory, tuning: { epochTicks: 600 } }
  const ctx = zoneSetup(sc)
  const late = 3, start = 60, end = 120, probe = [80, 120]
  const a = ctx.sessions[0].assignment
  const lateDomain = a.seatDomain[ctx.roster.peers[late].seats[0]]
  // A peer that replicates the late peer's seat domain without owning a seat in it.
  const watcher = a.domains.find((d) => d.id === lateDomain)!.replicas.find((p) => p !== late)!
  const locals = [0, 1, 2].filter((p) => {
    const d = a.seatDomain[ctx.roster.peers[p].seats[0]]
    return d !== lateDomain && !a.shadows.some((l) => l.to === d)
  })
  assert.ok(watcher !== undefined && locals.includes(watcher), 'scenario: the watcher has an independent seat domain')
  const at: { tick: number; stall: number; own: number; far: number; global: number }[][] = []
  sc.hook = (frame) => {
    if (frame === start || frame === end) {
      for (let p = 0; p < sc.peers; p++) if (p !== late) ctx.net.setLink(late, p, { rttMs: frame === start ? 2000 : 0 })
    }
    if (!probe.includes(frame)) return
    at.push(locals.map((p) => {
      const s = ctx.sessions[p]
      return {
        tick: s.stats.tick, stall: s.stats.stallFrames,
        own: s.domain(s.assignment.seatDomain[ctx.roster.peers[p].seats[0]])!.sim.tick,
        far: s.domain(lateDomain)?.sim.tick ?? -1,
        global: s.domain(0)!.sim.tick,
      }
    }))
  }
  assert.deepEqual(zoneRun(sc, ctx), [])
  const span = probe[1] - probe[0]
  for (let k = 0; k < locals.length; k++) {
    const [b, e] = [at[0][k], at[1][k]], p = locals[k]
    assert.equal(e.stall, b.stall, `peer ${p}: local seats never waited`)
    assert.ok(e.tick - b.tick >= span - 1, `peer ${p}: session tick advanced`)
    assert.ok(e.own - b.own >= span - 1, `peer ${p}: own seat domain kept stepping`)
    // The global domain takes events from every domain, the late one included, so it stops at its prediction limit.
    assert.ok(e.global - b.global < span / 2, `peer ${p}: global domain stalled`)
    if (p === watcher) assert.ok(e.far - b.far < span / 2, `peer ${p}: far seat domain stalled`)
  }
  for (const s of ctx.sessions) assert.equal(s.stats.lostPeers.length, 0)
  for (const s of ctx.sessions) assert.ok(s.stats.confirmedTick[0] >= sc.frames, 'the stalled domains caught up')
})

interface Transition { producer: number; replicas: number[]; asleep: boolean; pose: Uint8Array }

test('zone SLEEP and WAKE reach each non-replica once, with the pose the producer\'s sleepPose writes', () => {
  // One epoch keeps every replica set, so the audience of each transition is fixed.
  const sc: ZoneScenario = { peers: 5, frames: 240, settle: 120, factory, tuning: { epochTicks: 600 } }
  const ctx = zoneSetup(sc)
  const expected = new Map<string, Transition>()
  /** Per peer: wire SLEEP/WAKE frames by transition key, and the sink's pose copy of each. */
  const wire = ctx.sessions.map(() => new Map<string, { from: number; n: number }>())
  const seen = ctx.sessions.map(() => new Map<string, Uint8Array>())
  const last = ctx.sessions.map(() => new Map<string, string>())
  const w = new SnapWriter()
  for (let p = 0; p < sc.peers; p++) {
    const session = ctx.sessions[p]
    const sink: FarSink = {
      far: () => {},
      sleep: (domain, id, tick, asleep, pose) => {
        const key = `${domain}:${id}:${tick}:${asleep}`
        assert.ok(!seen[p].has(key), `peer ${p}: one sink call per transition`)
        seen[p].set(key, pose.slice())
        last[p].set(`${domain}:${id}`, key)
        if (asleep) assert.deepEqual(session.sleepPoseOf(domain, id), pose)
        else {
          assert.equal(pose.length, 0)
          assert.equal(session.sleepPoseOf(domain, id), null)
        }
        const d = session.domain(domain)
        if (!d?.producer) return
        // The step of `tick` produced the transition: its result is the state at tick + 1, live or in the ring.
        let sim = d.sim as ZonePointSim
        if (sim.tick !== tick + 1) {
          sim = ctx.factories[p].create(d.spec, 0)
          sim.restore(new SnapReader(d.ring.bytesAt(tick + 1)!))
        }
        w.reset()
        if (asleep) assert.ok(sim.sleepPose(id, w), 'the producer holds the sleeper')
        expected.set(key, { producer: p, replicas: d.spec.replicas.slice(), asleep, pose: w.bytes().slice() })
      },
    }
    // zoneSetup builds the sessions; the sink is read from their config at each transition.
    ;(session as unknown as { cfg: ZoneSessionConfig<PointInput> }).cfg.farSink = sink
    const transport = ctx.net.transport(p)
    const drain = transport.drain.bind(transport)
    transport.drain = (out) => {
      drain(out)
      for (const pkt of out) {
        const m = decodeZone(pkt.data)
        if (!m || (m.type !== ZMSG.SLEEP && m.type !== ZMSG.WAKE)) continue
        const key = `${m.domain}:${m.id}:${m.tick}:${m.type === ZMSG.SLEEP}`
        const got = wire[p].get(key)
        if (got) got.n++
        else wire[p].set(key, { from: m.from, n: 1 })
      }
    }
  }
  assert.deepEqual(zoneRun(sc, ctx), [])

  let sleeps = 0, wakes = 0, delivered = 0
  for (const [key, t] of expected) {
    if (t.asleep) sleeps++
    else wakes++
    for (let p = 0; p < sc.peers; p++) {
      assert.ok(seen[p].has(key), `peer ${p} saw ${key}`)
      if (t.replicas.includes(p)) {
        assert.equal(wire[p].get(key), undefined, `replica ${p} gets no ${key}`)
        continue
      }
      delivered++
      assert.deepEqual(wire[p].get(key), { from: t.producer, n: 1 }, `peer ${p}: exactly one frame for ${key}`)
      assert.deepEqual(seen[p].get(key), t.pose, `peer ${p}: pose of ${key}`)
    }
  }
  // No frame for a transition the producer did not confirm.
  for (let p = 0; p < sc.peers; p++) for (const key of wire[p].keys()) assert.ok(expected.has(key), `peer ${p}: unexpected ${key}`)
  assert.ok(sleeps > 0 && wakes > 0 && delivered > 0, `transitions: ${sleeps} SLEEP, ${wakes} WAKE, ${delivered} delivered`)
  // The table ends at each body's last transition: the SLEEP pose, or nothing after WAKE.
  for (let p = 0; p < sc.peers; p++) {
    for (const [body, key] of last[p]) {
      const [domain, id] = body.split(':').map(Number)
      const t = expected.get(key)!
      if (t.replicas.includes(p)) continue
      if (t.asleep) assert.deepEqual(ctx.sessions[p].sleepPoseOf(domain, id), t.pose)
      else assert.equal(ctx.sessions[p].sleepPoseOf(domain, id), null)
    }
  }
})
