import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_BITS, CONTROL_NO_CELL, classOf, packControl, unpackControl } from '../src/zones/control.ts'
import type { ControlFields } from '../src/zones/control.ts'
import { ZONE_DEFAULTS } from '../src/zones/tuning.ts'

test('zone control: fields follow the LSB-first wire layout', () => {
  assert.equal(CONTROL_NO_CELL, 0xffff)
  assert.deepEqual(CONTROL_BITS, {
    cell: { shift: 0, mask: 0xffff },
    cpuClass: { shift: 16, mask: 0xf },
    bwClass: { shift: 20, mask: 0xf },
    latClass: { shift: 24, mask: 0xf },
    spareSlots: { shift: 28, mask: 0xf },
  })
  const fields = { cell: 0x5678, cpuClass: 4, bwClass: 3, latClass: 2, spareSlots: 1 }
  assert.equal(packControl(fields), 0x12345678)
  assert.deepEqual(unpackControl(0x12345678, { ...fields, cell: 0 }), fields)
})

test('zone control: many combinations round trip as unsigned words into reused fields', () => {
  const fields: ControlFields = { cell: 0, cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 15 }
  const out: ControlFields = { cell: -1, cpuClass: -1, bwClass: -1, latClass: -1, spareSlots: -1 }
  for (const cell of [0, 1, 0x1234, CONTROL_NO_CELL]) {
    fields.cell = cell
    for (let cpu = 0; cpu <= 15; cpu++) {
      fields.cpuClass = cpu
      for (let bw = 0; bw <= 15; bw++) {
        fields.bwClass = bw
        for (let lat = 0; lat <= 15; lat++) {
          fields.latClass = lat
          const word = packControl(fields)
          assert.equal(word >>> 0, word)
          assert.equal(unpackControl(word, out), out)
          assert.deepEqual(out, fields)
        }
      }
    }
  }
  for (let spare = 0; spare <= 15; spare++) {
    fields.spareSlots = spare
    const word = packControl(fields)
    assert.equal(word >>> 0, word)
    assert.equal(unpackControl(word, out), out)
    assert.deepEqual(out, fields)
  }
  assert.equal(packControl({ cell: CONTROL_NO_CELL, cpuClass: 15, bwClass: 15, latClass: 15, spareSlots: 15 }), 0xffffffff)
  assert.equal(packControl({ cell: 0, cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 0 }), 0)
})

test('zone control: oversized fields are masked without changing neighbours', () => {
  const base: ControlFields = { cell: 0x2345, cpuClass: 3, bwClass: 4, latClass: 5, spareSlots: 6 }
  const out = { ...base }
  for (const key of ['cell', 'cpuClass', 'bwClass', 'latClass', 'spareSlots'] as const) {
    const overflow = key === 'cell' ? 0x10000 : 16
    for (const value of [overflow, overflow + 1, -1]) {
      const fields = { ...base, [key]: value }
      const expected = { ...base, [key]: value & CONTROL_BITS[key].mask }
      assert.deepEqual(unpackControl(packControl(fields), out), expected)
    }
  }
  assert.deepEqual(unpackControl(packControl({ ...base, cell: 0x10000, cpuClass: 16 }), out), {
    ...base, cell: 0, cpuClass: 0,
  })
})

test('zone control: CPU classes count inclusive tuning thresholds', () => {
  const thresholds = ZONE_DEFAULTS.cpuThresholdsMs
  assert.equal(classOf(thresholds[0] - 0.5, thresholds), 0)
  assert.equal(classOf(thresholds[0], thresholds), 1)
  assert.equal(classOf(thresholds[thresholds.length - 1] + 1, thresholds), 15)
  for (let i = 0; i < thresholds.length; i++) {
    assert.equal(classOf(thresholds[i], thresholds), i + 1)
    assert.equal(classOf(thresholds[i] - 0.5, thresholds), i)
  }
})

test('zone control: classes use the supplied table and cap at its length or the wire width', () => {
  const short = [0.25, 0.75, 2.5] as const
  assert.equal(classOf(0, short), 0)
  assert.equal(classOf(0.25, short), 1)
  assert.equal(classOf(0.75, short), 2)
  assert.equal(classOf(2.5, short), short.length)
  assert.equal(classOf(Infinity, short), short.length)
  assert.equal(classOf(100, []), 0)
  const long = Array.from({ length: 20 }, (_, i) => i)
  assert.equal(classOf(Infinity, long), 15)
  for (const value of [NaN, -1, -Infinity]) {
    assert.equal(classOf(value, [-2, -1, 0]), 0)
  }
})
