import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assign } from '../src/zones/assign.ts'
import { CONTROL_NO_CELL, packControl } from '../src/zones/control.ts'
import { ZONE_DEFAULTS } from '../src/zones/tuning.ts'
import type { ZoneTuning } from '../src/zones/tuning.ts'
import type { Assignment, ControlSample, Roster } from '../src/zones/types.ts'

const base: ZoneTuning = { ...ZONE_DEFAULTS, rEnter: 1, rExit: 2, gridCols: 16 }

interface PeerSetup {
  peer: number
  seats: number[]
  cpuClass: number
  spareSlots: number
}

function rosterOf(seatCount: number, peers: PeerSetup[], dead: number[] = []): Roster {
  const live: boolean[] = []
  for (const p of peers) live[p.peer] = !dead.includes(p.peer)
  return { seatCount, peers: peers.map((p) => ({ peer: p.peer, seats: [...p.seats] })), live }
}

function controlsOf(epoch: number, cells: number[], peers: PeerSetup[]): ControlSample {
  const words = new Uint32Array(cells.length)
  for (const p of peers) {
    for (const seat of p.seats) {
      words[seat] = packControl({ cell: cells[seat], cpuClass: p.cpuClass, bwClass: 0, latClass: 0, spareSlots: p.spareSlots })
    }
  }
  return { epoch, words }
}

/** One peer per seat, each with the same classes. */
function soloPeers(seatCount: number, cpuClass: number, spareSlots: number): PeerSetup[] {
  const peers: PeerSetup[] = []
  for (let s = 0; s < seatCount; s++) peers.push({ peer: s, seats: [s], cpuClass, spareSlots })
  return peers
}

function run(cellsByEpoch: number[][], peers: PeerSetup[], tuning: ZoneTuning): Assignment[] {
  const out: Assignment[] = []
  let prev: Assignment | null = null
  cellsByEpoch.forEach((cells, epoch) => {
    prev = assign(rosterOf(cells.length, peers), controlsOf(epoch, cells, peers), prev, tuning)
    out.push(prev)
  })
  return out
}

test('zone assign: pure, deterministic and fresh outputs', () => {
  const peers = soloPeers(6, 3, 1)
  const roster = rosterOf(6, peers)
  const controls = controlsOf(4, [0, 1, 40, 41, 100, CONTROL_NO_CELL], peers)
  const tuning: ZoneTuning = { ...base, fieldCells: [2, 200] }
  const prev = assign(roster, controlsOf(3, [0, 1, 40, 41, 100, CONTROL_NO_CELL], peers), null, tuning)
  const copies = structuredClone({ roster, controls, prev, tuning })
  const a = assign(roster, controls, prev, tuning)
  const b = assign(roster, controls, prev, tuning)
  assert.deepEqual(a, b)
  assert.notEqual(a.seatDomain, b.seatDomain)
  assert.notEqual(a.domains, b.domains)
  assert.deepEqual({ roster, controls, prev, tuning }, copies)
  // Field cell 2 is next to seat 1 and joins its domain; 200 is untouched.
  assert.deepEqual(a.domains.find((d) => d.id === 1)!.cells, [0, 1, 2])
  const field = a.domains.find((d) => d.kind === 'field')!
  assert.deepEqual([field.id, field.cells, field.seats], [1 + 6 + 200, [200], []])
  assert.equal(a.seatDomain[5], -1)
})

test('zone assign: hysteresis merges at rEnter, holds at rExit, splits beyond', () => {
  // No residence lock, so only the near graph decides.
  const tuning: ZoneTuning = { ...base, minResidenceEpochs: 0 }
  const peers = soloPeers(2, 3, 1)
  const steps = run([[0, 2], [0, 1], [0, 2], [0, 3]], peers, tuning)
  assert.deepEqual(steps.map((a) => [...a.seatDomain]), [[1, 2], [1, 1], [1, 1], [1, 2]])
})

test('zone assign: residence holds a seat in its prev domain until it is old enough', () => {
  const tuning: ZoneTuning = { ...base, minResidenceEpochs: 2 }
  const peers = soloPeers(3, 3, 1)
  // Seats 0 and 1 start together; seat 1 then walks next to seat 2, far from seat 0.
  const moved = [0, 9, 10]
  const steps = run([[0, 1, 10], moved, moved, moved], peers, tuning)
  assert.deepEqual([...steps[0].seatDomain], [1, 1, 3])
  assert.deepEqual([...steps[1].seatDomain], [1, 1, 3], 'residence 0: stays')
  assert.deepEqual([...steps[2].seatDomain], [1, 1, 3], 'residence 1: stays')
  assert.deepEqual([...steps[3].seatDomain], [1, 2, 2], 'residence 2: moves')
  assert.deepEqual([...steps[3].residence], [3, 0, 0])
})

test('zone assign: an over-capacity component splits with symmetric shadows', () => {
  // cpuClass 1 gives a capacity of 4 seat-equivalents per peer.
  const peers = soloPeers(12, 1, 1)
  const cells = Array.from({ length: 12 }, (_, s) => s)
  const a = run([cells], peers, base)[0]
  const seatDomains = a.domains.filter((d) => d.kind === 'seat')
  assert.deepEqual(seatDomains.map((d) => d.seats), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]])
  assert.deepEqual(a.shadows, [{ from: 1, to: 5 }, { from: 5, to: 1 }, { from: 5, to: 9 }, { from: 9, to: 5 }])
  for (const s of a.shadows) assert.ok(a.shadows.some((t) => t.from === s.to && t.to === s.from))
})

test('zone assign: owners replicate even with weight 0', () => {
  const peers: PeerSetup[] = [
    { peer: 0, seats: [0], cpuClass: 3, spareSlots: 0 },
    { peer: 1, seats: [1], cpuClass: 3, spareSlots: 2 },
    { peer: 2, seats: [2], cpuClass: 3, spareSlots: 2 },
  ]
  const a = run([[0, 100, 200]], peers, base)[0]
  const own = a.domains.find((d) => d.id === 1)!
  assert.ok(own.replicas.includes(0))
  assert.equal(own.replicas.length, base.replicas)
  // Owner 0 has score 0, so it sorts last.
  assert.equal(own.replicas[own.replicas.length - 1], 0)
  for (const d of a.domains) if (d.id !== 1 && d.kind === 'seat') assert.ok(!d.replicas.includes(0))
})

test('zone assign: adding a 0-seat peer moves only the replica sets it enters', () => {
  const n = 20
  const owners = soloPeers(n, 8, 1)
  // Seats far apart, one domain each; seat n is an observer seat that carries the extra peer's classes.
  const cells = [...Array.from({ length: n }, (_, s) => s * 3), CONTROL_NO_CELL]
  const extra: PeerSetup = { peer: n, seats: [n], cpuClass: 8, spareSlots: 2 }
  const without = assign(rosterOf(n + 1, owners), controlsOf(1, cells, owners), null, base)
  const withPeers = [...owners, extra]
  const withExtra = assign(rosterOf(n + 1, withPeers), controlsOf(1, cells, withPeers), null, base)
  let entered = 0
  for (let i = 0; i < without.domains.length; i++) {
    const before = without.domains[i]
    const after = withExtra.domains[i]
    assert.equal(after.id, before.id)
    if (after.replicas.includes(n)) entered++
    else assert.deepEqual(after.replicas, before.replicas, `domain ${before.id}`)
  }
  assert.ok(entered > 1, 'the extra peer enters some seat domains')
  const again = assign(rosterOf(n + 1, owners), controlsOf(1, cells, owners), null, base)
  assert.deepEqual(again, without)
})

function fleet(): { peers: PeerSetup[]; cells: number[] } {
  const peers: PeerSetup[] = []
  const cells: number[] = []
  for (let s = 0; s < 64; s++) {
    peers.push({ peer: s, seats: [s], cpuClass: s % 6, spareSlots: s % 3 })
    cells.push(s < 60 ? ((s * 7) % 12) * base.gridCols + ((s * 5) % 12) : CONTROL_NO_CELL)
  }
  return { peers, cells }
}

test('zone assign: 60 seats on 64 peers', () => {
  const { peers, cells } = fleet()
  const steps = run([cells, cells, cells], peers, base)
  const a = steps[2]
  for (let s = 0; s < 60; s++) assert.ok(a.seatDomain[s] > 0, `seat ${s} has a domain`)
  for (let s = 60; s < 64; s++) assert.equal(a.seatDomain[s], -1)
  for (let i = 1; i < a.domains.length; i++) assert.ok(a.domains[i].id > a.domains[i - 1].id)
  const weighted = peers.filter((p) => base.capacityByCpuClass[p.cpuClass] * p.spareSlots > 0).map((p) => p.peer)
  for (const d of a.domains) {
    if (d.kind === 'global') continue
    const eligible = new Set([...weighted, ...d.seats])
    assert.ok(d.replicas.length >= Math.min(base.replicas, eligible.size), `domain ${d.id}`)
    for (const s of d.seats) assert.equal(a.seatDomain[s], d.id)
    for (const s of d.seats) assert.ok(d.replicas.includes(s), 'owner replicates')
  }
  for (let s = 0; s < 64; s++) assert.equal(a.seatHost[s], s)

  const lost = 7
  const dropped = assign(rosterOf(64, peers, [lost]), controlsOf(3, cells, peers), a, base)
  const domain = dropped.domains.find((d) => d.id === dropped.seatDomain[lost])!
  assert.ok(!domain.replicas.includes(lost))
  assert.ok(domain.replicas.includes(dropped.seatHost[lost]), 'a live replica hosts the lost seat')
  for (let s = 0; s < 64; s++) if (s !== lost) assert.equal(dropped.seatHost[s], s)
})

test('zone assign: every live peer replicates the global domain', () => {
  const { peers, cells } = fleet()
  const a = assign(rosterOf(64, peers, [3, 61]), controlsOf(0, cells, peers), null, base)
  const global = a.domains[0]
  assert.equal(global.id, 0)
  assert.deepEqual(global.cells, [])
  assert.deepEqual(global.seats, Array.from({ length: 60 }, (_, s) => s))
  assert.deepEqual([...global.replicas].sort((x, y) => x - y), Array.from({ length: 64 }, (_, p) => p).filter((p) => p !== 3 && p !== 61))
})
