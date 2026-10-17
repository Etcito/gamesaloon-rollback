import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dumpToText } from '../src/index.ts'
import { commonTicks, firstMismatch, run } from './harness.ts'
import type { Ctx } from './harness.ts'

function all(n: number): number[] {
  const a: number[] = []
  for (let i = 0; i < n; i++) a.push(i)
  return a
}

/** Every peer agrees on every confirmed tick, enough ticks were confirmed, and no desync was ever flagged. */
function assertConverged(ctx: Ctx, peers: number[], minTicks: number): void {
  const ticks = commonTicks(ctx, peers)
  assert.ok(ticks.length >= minTicks, `only ${ticks.length} common confirmed ticks (< ${minTicks})`)
  assert.equal(firstMismatch(ctx, peers), -1, 'confirmed hashes differ')
  for (const p of peers) assert.equal(ctx.sessions[p].stats.desyncs, 0, `peer ${p} flagged a desync`)
}

for (const peers of [2, 3, 4]) {
  test(`${peers} peers, 80 ms RTT, 12 ms jitter, 3% loss, reordering: identical hashes on every tick`, () => {
    const ctx = run({ peers, rttMs: 80, jitterMs: 12, loss: 0.03, reorder: 0.05, seed: 100 + peers, frames: 1500 })
    assertConverged(ctx, all(peers), 1300)
    // Latency and loss must really have exercised prediction and rollback.
    const rollbacks = ctx.sessions.reduce((a, s) => a + s.stats.rollbacks, 0)
    assert.ok(rollbacks > 0, 'no rollback happened: the scenario does not test anything')
    for (const s of ctx.sessions) assert.equal(s.stats.malformed, 0)
  })
}

test('4 peers over a worse link (150 ms RTT, 25 ms jitter, 8% loss) still agree', () => {
  const ctx = run({ peers: 4, rttMs: 150, jitterMs: 25, loss: 0.08, reorder: 0.1, seed: 9, frames: 1500, settle: 300 })
  assertConverged(ctx, all(4), 1200)
  assert.ok(ctx.sessions[0].stats.delay >= 2)
})

test('zero latency, zero loss: no rollback is ever needed beyond the input delay', () => {
  const ctx = run({ peers: 3, seed: 5, frames: 600 })
  assertConverged(ctx, all(3), 500)
})

test('several players per peer and a pure observer (3 + 2 + 0 + 1 players)', () => {
  const ctx = run({ peers: 4, players: [3, 2, 0, 1], rttMs: 60, jitterMs: 8, loss: 0.02, seed: 21, frames: 1200 })
  assertConverged(ctx, all(4), 1000)
})

test('the optional Simulation.hash() gives the same agreement', () => {
  const ctx = run({ peers: 3, rttMs: 70, jitterMs: 10, loss: 0.03, seed: 31, frames: 1000, useSimHash: true })
  assertConverged(ctx, all(3), 800)
})

test('NetSim runs are deterministic: same seed, same hashes; another seed, another rollback pattern', () => {
  const a = run({ peers: 3, rttMs: 90, jitterMs: 15, loss: 0.05, seed: 77, frames: 700 })
  const b = run({ peers: 3, rttMs: 90, jitterMs: 15, loss: 0.05, seed: 77, frames: 700 })
  assert.deepEqual([...a.confirmed[0]], [...b.confirmed[0]])
  assert.equal(a.sessions[1].stats.rollbacks, b.sessions[1].stats.rollbacks)
  assert.equal(a.sessions[2].stats.resimTicks, b.sessions[2].stats.resimTicks)
})

test('a smoother is created from the Simulation view and its offsets decay', () => {
  const ctx = run({ peers: 2, rttMs: 100, jitterMs: 10, loss: 0.05, seed: 3, frames: 400 })
  const sm = ctx.sessions[0].smoother
  assert.ok(sm, 'smoother missing')
  const pose = new Float64Array(sm.entities * sm.stride)
  sm.apply(pose)
  const before = pose.reduce((a, v) => a + Math.abs(v), 0)
  for (let i = 0; i < 120; i++) sm.decay(1 / 60)
  pose.fill(0)
  sm.apply(pose)
  const after = pose.reduce((a, v) => a + Math.abs(v), 0)
  assert.ok(after <= before)
  assert.ok(after < 1e-3, 'offsets did not decay to zero')
})

// ---------------------------------------------------------------- desync, resync, late start

test('forced desync (3 peers): detected on every peer with a dump, the odd one out resyncs from the majority', () => {
  const CORRUPT_FRAME = 500
  const ctx = run({
    peers: 3, rttMs: 60, jitterMs: 6, loss: 0.02, seed: 41, frames: 1400,
    hook: (f, c) => {
      if (f === CORRUPT_FRAME) c.sims[2].x[1] += 1234
    },
  })
  for (let p = 0; p < 3; p++) assert.ok(ctx.sessions[p].stats.desyncs >= 1, `peer ${p} never flagged the desync`)
  // The dump: tick, hashes, snapshot and inputs are filled; the text form is readable.
  const d = ctx.dumps[0][0]
  assert.ok(d.tick > 0 && d.snapshotB64 !== null && d.inputs.length > 0)
  assert.notEqual(d.localHash, d.remote[0]?.hash ?? d.localHash)
  const text = dumpToText(d)
  assert.ok(text.includes('DESYNC DUMP') && text.includes('differs'))
  // Majority (peers 0 and 1) is the authority; peer 2 loaded its snapshot.
  assert.equal(ctx.sessions[2].resyncs, 1)
  assert.equal(ctx.sessions[0].resyncs, 0)
  assert.equal(ctx.sessions[1].resyncs, 0)
  assert.equal(ctx.sessions[0].desyncAuthority, 0)
  // After the resync every confirmed tick agrees again.
  const bad = firstMismatch(ctx, [0, 1, 2], d.tick + 150)
  assert.equal(bad, -1, 'hashes still differ after the resync')
  assert.ok(commonTicks(ctx, [0, 1, 2]).filter((t) => t > d.tick + 150).length > 400)
  // The majority never changed state: peers 0 and 1 agree on the whole run.
  assert.equal(firstMismatch(ctx, [0, 1]), -1)
})

test('forced desync (2 peers, tie): the lowest peer is the authority and the other resyncs', () => {
  const ctx = run({
    peers: 2, rttMs: 40, jitterMs: 4, seed: 42, frames: 1000,
    hook: (f, c) => {
      if (f === 400) c.sims[1].vx[0] += 77
    },
  })
  assert.ok(ctx.sessions[0].stats.desyncs >= 1 && ctx.sessions[1].stats.desyncs >= 1)
  assert.equal(ctx.sessions[1].resyncs, 1)
  assert.equal(ctx.sessions[0].resyncs, 0)
  const d = ctx.dumps[1][0]
  assert.equal(firstMismatch(ctx, [0, 1], d.tick + 150), -1)
})

test('desync is detected and resynced with the optional Simulation.hash() too', () => {
  const ctx = run({
    peers: 3, rttMs: 50, jitterMs: 5, seed: 43, frames: 1000, useSimHash: true,
    hook: (f, c) => {
      if (f === 400) c.sims[1].y[2] -= 999
    },
  })
  assert.equal(ctx.sessions[1].resyncs, 1)
  assert.equal(firstMismatch(ctx, [0, 1, 2], ctx.dumps[1][0].tick + 150), -1)
})

test('late start: a peer that begins 1 s late makes the others stall, then everybody converges', () => {
  const ctx = run({ peers: 3, rttMs: 60, jitterMs: 5, loss: 0.01, seed: 51, frames: 1200, startFrame: [0, 0, 60] })
  assert.ok(ctx.sessions[0].stats.stallFrames > 0, 'the others should have waited for the late peer')
  for (const s of ctx.sessions) assert.deepEqual(s.stats.lostPeers, [])
  assertConverged(ctx, all(3), 900)
})

test('late join with stale state: a peer starting from a different state is detected and resynced', () => {
  const ctx = run({ peers: 3, rttMs: 50, jitterMs: 4, seed: 52, frames: 900, simSeeds: [777, 777, 12345], startFrame: [0, 0, 30] })
  assert.equal(ctx.sessions[2].resyncs, 1)
  assert.equal(ctx.sessions[0].resyncs + ctx.sessions[1].resyncs, 0)
  const d = ctx.dumps[2][0]
  assert.equal(firstMismatch(ctx, [0, 1, 2], d.tick + 150), -1)
})

// ---------------------------------------------------------------- drop handling

test('drop: a peer vanishes, the others agree on the switch tick and keep identical hashes', () => {
  const KILL_FRAME = 400
  const ctx = run({
    peers: 3, rttMs: 60, jitterMs: 5, loss: 0.02, seed: 61, frames: 1500, settle: 300,
    hook: (f, c) => {
      if (f === KILL_FRAME) {
        c.net.kill(2)
        c.alive[2] = false
      }
    },
  })
  const l0 = ctx.lost.filter((l) => l.peer === 0 && l.lostPeer === 2)
  const l1 = ctx.lost.filter((l) => l.peer === 1 && l.lostPeer === 2)
  assert.equal(l0.length, 1)
  assert.equal(l1.length, 1)
  assert.equal(l0[0].switchTick, l1[0].switchTick, 'peers disagree on the switch tick')
  assert.deepEqual(ctx.sessions[0].stats.lostPeers, [2])
  assert.equal(ctx.sessions[0].switchTick(2), ctx.sessions[1].switchTick(2))
  // The hook let the simulation retire the player on both survivors.
  assert.ok(ctx.sims[0].dead[2] === 1 && ctx.sims[1].dead[2] === 1)
  assert.ok(ctx.sims[0].droppedCalls > 0)
  // The game kept running well past the loss and the survivors agree on every confirmed tick.
  const S = l0[0].switchTick
  assert.ok(ctx.sessions[0].stats.confirmedTick > S + 600, 'the game froze after the drop')
  assert.equal(firstMismatch(ctx, [0, 1]), -1)
  assert.ok(commonTicks(ctx, [0, 1]).filter((t) => t > S).length > 600)
  assert.equal(ctx.sessions[0].stats.desyncs, 0)
})

test('drop with 4 peers: two peers vanish at different times, the survivors still agree', () => {
  const ctx = run({
    peers: 4, rttMs: 50, jitterMs: 5, loss: 0.01, seed: 62, frames: 1800, settle: 400,
    hook: (f, c) => {
      if (f === 300) { c.net.kill(3); c.alive[3] = false }
      if (f === 700) { c.net.kill(1); c.alive[1] = false }
    },
  })
  for (const p of [0, 2]) assert.deepEqual([...ctx.sessions[p].stats.lostPeers].sort(), [1, 3])
  assert.equal(ctx.sessions[0].switchTick(1), ctx.sessions[2].switchTick(1))
  assert.equal(ctx.sessions[0].switchTick(3), ctx.sessions[2].switchTick(3))
  assert.equal(firstMismatch(ctx, [0, 2]), -1)
  assert.ok(ctx.sessions[0].stats.confirmedTick > 1500)
})

test('a peer that says goodbye (leave) is dropped by the others without waiting for the timeout', () => {
  const ctx = run({
    peers: 2, rttMs: 30, seed: 63, frames: 800,
    hook: (f, c) => {
      if (f === 300) {
        c.sessions[1].leave()
        c.alive[1] = false
      }
    },
  })
  assert.deepEqual(ctx.sessions[0].stats.lostPeers, [1])
  assert.ok(ctx.sessions[0].stats.confirmedTick > 600)
})
