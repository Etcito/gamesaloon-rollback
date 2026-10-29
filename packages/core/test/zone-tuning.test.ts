import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZONE_DEFAULTS, tuningHash, validateZoneTuning } from '../src/zones/tuning.ts'
import type { ZoneTuning } from '../src/zones/tuning.ts'

const base = (): ZoneTuning => structuredClone(ZONE_DEFAULTS) as ZoneTuning
const refused = /\[zones\]/

test('zone tuning: the defaults validate', () => {
  validateZoneTuning(ZONE_DEFAULTS)
  assert.equal(ZONE_DEFAULTS.capacityByCpuClass.length, 16)
})

test('zone tuning: lead must exceed maxPrediction + maxDelay', () => {
  assert.throws(() => validateZoneTuning({ ...base(), leadTicks: 24 }), refused)
  validateZoneTuning({ ...base(), leadTicks: 25 })
  validateZoneTuning({ ...base(), leadTicks: 24 }, { maxPrediction: 10, maxDelay: 4 })
  assert.throws(() => validateZoneTuning(base(), { maxPrediction: 30 }), refused)
})

test('zone tuning: rExit below rEnter is refused', () => {
  assert.throws(() => validateZoneTuning({ ...base(), rEnter: 2, rExit: 1 }), refused)
})

test('zone tuning: an empty table is refused', () => {
  for (const key of ['capacityByCpuClass', 'cpuThresholdsMs', 'bwThresholdsKbps', 'latThresholdsMs', 'farStrides'] as const) {
    assert.throws(() => validateZoneTuning({ ...base(), [key]: [] }), refused, key)
  }
})

test('zone tuning: a threshold table must be strictly ascending and at most 15 entries', () => {
  for (const key of ['cpuThresholdsMs', 'bwThresholdsKbps', 'latThresholdsMs'] as const) {
    const flat = [...ZONE_DEFAULTS[key]]
    flat[3] = flat[2]
    assert.throws(() => validateZoneTuning({ ...base(), [key]: flat }), refused, key)
    const down = [...ZONE_DEFAULTS[key]].reverse()
    assert.throws(() => validateZoneTuning({ ...base(), [key]: down }), refused, key)
    const long = [...ZONE_DEFAULTS[key], ZONE_DEFAULTS[key][14] + 1]
    assert.throws(() => validateZoneTuning({ ...base(), [key]: long }), refused, key)
  }
})

test('zone tuning: capacity covers every class and farStrides ascend', () => {
  assert.throws(() => validateZoneTuning({ ...base(), capacityByCpuClass: [2, 4, 8] }), refused)
  const swapped = [{ maxCells: 6, stride: 6 }, { maxCells: 2, stride: 2 }]
  assert.throws(() => validateZoneTuning({ ...base(), farStrides: swapped }), refused)
})

test('zone tuning: counts below 1 and fractions are refused', () => {
  for (const key of ['epochTicks', 'replicas', 'untouchedReplicas', 'snapshotRing', 'keyframeEvery', 'gridCols'] as const) {
    assert.throws(() => validateZoneTuning({ ...base(), [key]: 0 }), refused, key)
    assert.throws(() => validateZoneTuning({ ...base(), [key]: 1.5 }), refused, key)
  }
})

test('zone tuning: fieldCells ascend and stay below 0xFFFF', () => {
  validateZoneTuning({ ...base(), fieldCells: [3, 9, 40] })
  assert.throws(() => validateZoneTuning({ ...base(), fieldCells: [9, 3] }), refused)
  assert.throws(() => validateZoneTuning({ ...base(), fieldCells: [3, 3] }), refused)
  assert.throws(() => validateZoneTuning({ ...base(), fieldCells: [3, 0xffff] }), refused)
})

test('zone tuning: the hash is stable for a deep copy', () => {
  assert.equal(tuningHash(base()), tuningHash(ZONE_DEFAULTS))
  assert.equal(tuningHash(base()), tuningHash(base()))
})

test('zone tuning: the hash changes with every kind of field', () => {
  const h = tuningHash(base())
  const cpu = [...ZONE_DEFAULTS.cpuThresholdsMs]
  cpu[4] += 1
  const variants: ZoneTuning[] = [
    { ...base(), leadTicks: 31 },
    { ...base(), cpuThresholdsMs: cpu },
    { ...base(), costClass: { ...ZONE_DEFAULTS.costClass, global: 'tiebreak' } },
    { ...base(), gridCols: 128 },
    { ...base(), fieldCells: [7] },
    { ...base(), farStrides: [{ maxCells: 2, stride: 3 }, ...ZONE_DEFAULTS.farStrides.slice(1)] },
  ]
  const seen = new Set([h])
  for (const v of variants) seen.add(tuningHash(v))
  assert.equal(seen.size, variants.length + 1)
})
