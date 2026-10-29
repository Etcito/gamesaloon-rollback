import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainIdOf, nearComponents, splitByCapacity } from '../src/zones/nearGraph.ts'
import { CONTROL_NO_CELL } from '../src/zones/control.ts'
import { ZONE_DEFAULTS } from '../src/zones/tuning.ts'
import type { ZoneTuning } from '../src/zones/tuning.ts'
import type { Assignment, ShadowLink } from '../src/zones/types.ts'

const tuning: ZoneTuning = { ...ZONE_DEFAULTS, rEnter: 1, rExit: 2, gridCols: 16 }

function cellAt(row: number, col: number): number {
  return row * tuning.gridCols + col
}

function prevOf(seatDomain: number[], shadows: ShadowLink[] = []): Assignment {
  return {
    epoch: 0,
    domains: [],
    shadows,
    seatDomain: Int32Array.from(seatDomain),
    seatHost: new Int16Array(seatDomain.length),
    residence: new Uint16Array(seatDomain.length),
  }
}

test('zone near graph: the union-find root is the lowest seat', () => {
  // Chain 3 - 1 - 0 - 2 along a row, unioned out of seat order.
  const cells = [cellAt(0, 2), cellAt(0, 1), cellAt(0, 3), cellAt(0, 0), cellAt(5, 5)]
  assert.deepEqual([...nearComponents(cells, null, null, tuning)], [0, 0, 0, 0, 4])
})

test('zone near graph: hysteresis keeps prev neighbours up to rExit', () => {
  const near = [cellAt(0, 0), cellAt(0, 2)]
  assert.deepEqual([...nearComponents(near, null, null, tuning)], [0, 1])
  assert.deepEqual([...nearComponents(near, prevOf([1, 1]), null, tuning)], [0, 0])
  assert.deepEqual([...nearComponents(near, prevOf([1, 2], [{ from: 1, to: 2 }]), null, tuning)], [0, 0])
  assert.deepEqual([...nearComponents(near, prevOf([1, 2]), null, tuning)], [0, 1])
  const far = [cellAt(0, 0), cellAt(0, 3)]
  assert.deepEqual([...nearComponents(far, prevOf([1, 1]), null, tuning)], [0, 1])
})

test('zone near graph: residence lock holds a seat in its prev domain', () => {
  const prev = prevOf([1, 2])
  const cells = [cellAt(0, 0), cellAt(0, 1)]
  assert.deepEqual([...nearComponents(cells, prev, null, tuning)], [0, 0])
  assert.deepEqual([...nearComponents(cells, prev, Uint8Array.from([1, 0]), tuning)], [0, 1])
  assert.deepEqual([...nearComponents(cells, prev, Uint8Array.from([0, 1]), tuning)], [0, 1])
  const apart = [cellAt(0, 0), cellAt(0, 5)]
  assert.deepEqual([...nearComponents(apart, prevOf([1, 1]), Uint8Array.from([1, 1]), tuning)], [0, 0])
  assert.deepEqual([...nearComponents(apart, prevOf([1, 1]), Uint8Array.from([1, 0]), tuning)], [0, 0])
})

test('zone near graph: observers get -1 and never join', () => {
  const cells = [CONTROL_NO_CELL, cellAt(0, 0), CONTROL_NO_CELL, cellAt(0, 1)]
  assert.deepEqual([...nearComponents(cells, prevOf([-1, 2, -1, 2]), null, tuning)], [-1, 1, -1, 1])
})

test('zone near graph: capacity split cuts a line into chunks with symmetric shadows', () => {
  const cells = Array.from({ length: 10 }, (_, i) => cellAt(0, i))
  // Members in scrambled order: chunks follow (cell, seat), not input order.
  const members = [9, 3, 0, 7, 1, 8, 2, 6, 5, 4]
  const { chunks, shadows } = splitByCapacity(members, cells, 4, tuning)
  assert.deepEqual(chunks, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]])
  const ids = chunks.map((c) => domainIdOf('seat', c[0], cells.length))
  assert.deepEqual(shadows, [
    { from: ids[0], to: ids[1] },
    { from: ids[1], to: ids[0] },
    { from: ids[1], to: ids[2] },
    { from: ids[2], to: ids[1] },
  ])
  for (const s of shadows) assert.ok(shadows.some((o) => o.from === s.to && o.to === s.from))
  assert.ok(!shadows.some((s) => (s.from === ids[0] && s.to === ids[2]) || (s.from === ids[2] && s.to === ids[0])))

  const whole = splitByCapacity([2, 0, 1], cells, 4, tuning)
  assert.deepEqual(whole, { chunks: [[0, 1, 2]], shadows: [] })
})

test('zone near graph: domainIdOf for every kind', () => {
  assert.equal(domainIdOf('global', 0, 10), 0)
  assert.equal(domainIdOf('seat', 0, 10), 1)
  assert.equal(domainIdOf('seat', 7, 10), 8)
  assert.equal(domainIdOf('field', 0, 10), 11)
  assert.equal(domainIdOf('field', 42, 10), 53)
})
