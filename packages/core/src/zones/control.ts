// Control seat words: LSB-first wire fields, shared by every peer.

export const CONTROL_NO_CELL = 0xffff

export const CONTROL_BITS = {
  cell: { shift: 0, mask: 0xffff },
  cpuClass: { shift: 16, mask: 0xf },
  bwClass: { shift: 20, mask: 0xf },
  latClass: { shift: 24, mask: 0xf },
  spareSlots: { shift: 28, mask: 0xf },
} as const

export interface ControlFields {
  cell: number
  cpuClass: number
  bwClass: number
  latClass: number
  spareSlots: number
}

/** Mask before shifting: an oversized value in one seat's word must never corrupt another field. */
export function packControl(fields: ControlFields): number {
  return (
    ((fields.cell & CONTROL_BITS.cell.mask) << CONTROL_BITS.cell.shift) |
    ((fields.cpuClass & CONTROL_BITS.cpuClass.mask) << CONTROL_BITS.cpuClass.shift) |
    ((fields.bwClass & CONTROL_BITS.bwClass.mask) << CONTROL_BITS.bwClass.shift) |
    ((fields.latClass & CONTROL_BITS.latClass.mask) << CONTROL_BITS.latClass.shift) |
    ((fields.spareSlots & CONTROL_BITS.spareSlots.mask) << CONTROL_BITS.spareSlots.shift)
  ) >>> 0
}

/** Reuse the caller's fields so decoding each seat each tick does not allocate. */
export function unpackControl(word: number, out: ControlFields): ControlFields {
  out.cell = (word >>> CONTROL_BITS.cell.shift) & CONTROL_BITS.cell.mask
  out.cpuClass = (word >>> CONTROL_BITS.cpuClass.shift) & CONTROL_BITS.cpuClass.mask
  out.bwClass = (word >>> CONTROL_BITS.bwClass.shift) & CONTROL_BITS.bwClass.mask
  out.latClass = (word >>> CONTROL_BITS.latClass.shift) & CONTROL_BITS.latClass.mask
  out.spareSlots = (word >>> CONTROL_BITS.spareSlots.shift) & CONTROL_BITS.spareSlots.mask
  return out
}

/** Count passed thresholds in an ascending table, capped to the class wire width. */
export function classOf(value: number, thresholds: readonly number[]): number {
  if (!(value >= 0)) return 0
  let result = 0
  while (result < thresholds.length && result < CONTROL_BITS.cpuClass.mask && thresholds[result] <= value) {
    result++
  }
  return result
}
