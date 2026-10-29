// Zone tuning: every limit of the zone mode is configuration. ZONE_DEFAULTS holds the only numbers.
// Pure. All peers of a match use identical tuning, and its hash is part of the room payload.

import { SnapWriter, fnv1a32 } from '../snap.ts'
import { DEFAULT_MAX_DELAY, DEFAULT_MAX_PREDICTION } from '../timing.ts'

/** Disagreement response of a domain kind: producer wins, roll back to a keyframe, or reset at the next epoch. */
export type CostClass = 'tiebreak' | 'checkpoint' | 'reset'

export interface ZoneTuning {
  /** K: ticks per epoch. */
  epochTicks: number
  /** L: assignment for epoch E reads control words at tick E*K-L. Must exceed maxPrediction + maxDelay. */
  leadTicks: number
  /** Chebyshev cell distance at which seats join the near graph. */
  rEnter: number
  /** Distance at which they leave it. At least rEnter. */
  rExit: number
  /** Epochs before a seat may change domain. */
  minResidenceEpochs: number
  /** R: minimum replicas per domain. */
  replicas: number
  /** Replicas for an untouched domain; may be 1. */
  untouchedReplicas: number
  /** Seat-equivalents a peer can simulate per spare slot, indexed by cpu class. */
  capacityByCpuClass: readonly number[]
  /** Ascending tables mapping measurements to classes 0..15. cpu is the spare ms per tick: higher is more capable. */
  cpuThresholdsMs: readonly number[]
  bwThresholdsKbps: readonly number[]
  /** A higher latClass is a slower link. */
  latThresholdsMs: readonly number[]
  /** Ticks old replicas keep a domain after a handoff. */
  handoffGraceTicks: number
  /** Far-stream stride by cell distance, ascending maxCells. */
  farStrides: readonly { readonly maxCells: number; readonly stride: number }[]
  costClass: { readonly seat: CostClass; readonly field: CostClass; readonly global: CostClass }
  /** Per-game: silence before the bot host drives a seat. */
  botTakeoverMs: number
  /** Snapshot ring size per domain. */
  snapshotRing: number
  /** Epochs between agreed keyframes. */
  keyframeEvery: number
  /** Columns of the cell grid: a cell id decodes as row = id / gridCols, col = id % gridCols. */
  gridCols: number
  /** Ascending cells that hold an untouched interactive area. */
  fieldCells: readonly number[]
}

export const ZONE_DEFAULTS = {
  epochTicks: 60,
  leadTicks: 30,
  rEnter: 1,
  rExit: 2,
  minResidenceEpochs: 2,
  replicas: 2,
  untouchedReplicas: 2,
  capacityByCpuClass: [2, 4, 8, 12, 16, 24, 32, 48, 64, 64, 64, 64, 64, 64, 64, 64],
  cpuThresholdsMs: [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32],
  bwThresholdsKbps: [64, 128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384],
  latThresholdsMs: [20, 40, 60, 80, 100, 120, 150, 180, 220, 260, 300, 400, 500, 700, 1000],
  handoffGraceTicks: 30,
  farStrides: [{ maxCells: 2, stride: 2 }, { maxCells: 6, stride: 6 }, { maxCells: 65535, stride: 15 }],
  costClass: { seat: 'checkpoint', field: 'checkpoint', global: 'reset' },
  botTakeoverMs: 150,
  snapshotRing: 40,
  keyframeEvery: 1,
  gridCols: 256,
  fieldCells: [],
} as const satisfies ZoneTuning

/** Wire widths: classes fit 4 bits (control word), cell and stride fields are u16, 0xFFFF means no cell. */
const MAX_CLASS_ENTRIES = 15
const NO_CELL = 0xffff
const U16_MAX = 0xffff

const COST_CODE = { tiebreak: 0, checkpoint: 1, reset: 2 } as const

function refuse(what: string): never {
  throw new Error(`[zones] tuning: ${what}`)
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function atLeastOne(name: string, v: number): void {
  if (!isInt(v)) refuse(`${name} must be an integer, got ${v}`)
  if (v < 1) refuse(`${name} must be at least 1, got ${v}`)
}

function nonNegative(name: string, v: number): void {
  if (!isInt(v)) refuse(`${name} must be an integer, got ${v}`)
  if (v < 0) refuse(`${name} must not be negative, got ${v}`)
}

function table(name: string, t: readonly number[], ascending: boolean): void {
  if (t.length === 0) refuse(`${name} must not be empty`)
  for (let i = 0; i < t.length; i++) {
    nonNegative(`${name}[${i}]`, t[i])
    if (ascending && i > 0 && !(t[i] > t[i - 1])) refuse(`${name} must be strictly ascending (index ${i})`)
  }
  if (ascending && t.length > MAX_CLASS_ENTRIES) refuse(`${name} has ${t.length} entries, at most ${MAX_CLASS_ENTRIES} (classes fit 4 bits)`)
}

/** Throws Error('[zones] tuning: <what>') on the first invalid field. */
export function validateZoneTuning(
  t: ZoneTuning,
  rollback: { maxPrediction?: number; maxDelay?: number } = {},
): void {
  const maxPrediction = rollback.maxPrediction ?? DEFAULT_MAX_PREDICTION
  const maxDelay = rollback.maxDelay ?? DEFAULT_MAX_DELAY
  atLeastOne('epochTicks', t.epochTicks)
  atLeastOne('replicas', t.replicas)
  atLeastOne('untouchedReplicas', t.untouchedReplicas)
  atLeastOne('snapshotRing', t.snapshotRing)
  atLeastOne('keyframeEvery', t.keyframeEvery)
  atLeastOne('gridCols', t.gridCols)
  nonNegative('leadTicks', t.leadTicks)
  nonNegative('rEnter', t.rEnter)
  nonNegative('rExit', t.rExit)
  nonNegative('minResidenceEpochs', t.minResidenceEpochs)
  nonNegative('handoffGraceTicks', t.handoffGraceTicks)
  nonNegative('botTakeoverMs', t.botTakeoverMs)
  if (t.leadTicks <= maxPrediction + maxDelay) {
    refuse(`leadTicks ${t.leadTicks} must be greater than maxPrediction + maxDelay (${maxPrediction} + ${maxDelay})`)
  }
  if (t.rExit < t.rEnter) refuse(`rExit ${t.rExit} must be at least rEnter ${t.rEnter}`)
  table('cpuThresholdsMs', t.cpuThresholdsMs, true)
  table('bwThresholdsKbps', t.bwThresholdsKbps, true)
  table('latThresholdsMs', t.latThresholdsMs, true)
  table('capacityByCpuClass', t.capacityByCpuClass, false)
  const classes = Math.max(t.cpuThresholdsMs.length, t.bwThresholdsKbps.length, t.latThresholdsMs.length) + 1
  if (t.capacityByCpuClass.length < classes) {
    refuse(`capacityByCpuClass has ${t.capacityByCpuClass.length} entries, needs at least ${classes} (longest threshold table + 1)`)
  }
  if (t.farStrides.length === 0) refuse('farStrides must not be empty')
  for (let i = 0; i < t.farStrides.length; i++) {
    const f = t.farStrides[i]
    atLeastOne(`farStrides[${i}].maxCells`, f.maxCells)
    atLeastOne(`farStrides[${i}].stride`, f.stride)
    if (f.maxCells > U16_MAX || f.stride > U16_MAX) refuse(`farStrides[${i}] does not fit u16`)
    if (i > 0 && !(f.maxCells > t.farStrides[i - 1].maxCells)) refuse(`farStrides maxCells must be ascending (index ${i})`)
  }
  for (const k of ['seat', 'field', 'global'] as const) {
    if (!(t.costClass[k] in COST_CODE)) refuse(`costClass.${k} is not a cost class`)
  }
  for (let i = 0; i < t.fieldCells.length; i++) {
    const c = t.fieldCells[i]
    if (!isInt(c) || c < 0 || c >= NO_CELL) refuse(`fieldCells[${i}] must be an integer below ${NO_CELL}`)
    if (i > 0 && !(c > t.fieldCells[i - 1])) refuse(`fieldCells must be strictly ascending (index ${i})`)
  }
}

function u32Table(w: SnapWriter, t: readonly number[]): void {
  w.u16(t.length)
  for (let i = 0; i < t.length; i++) w.u32(t[i])
}

/**
 * fnv1a32 of the canonical bytes, written in ZoneTuning field declaration order (all peers must agree):
 * integers u32; tables u16 length then u32 entries; farStrides u16 count then (u16 maxCells, u16 stride);
 * costClass three u8 codes in seat, field, global order (tiebreak 0, checkpoint 1, reset 2).
 */
export function tuningHash(t: ZoneTuning): number {
  const w = new SnapWriter()
  w.u32(t.epochTicks)
  w.u32(t.leadTicks)
  w.u32(t.rEnter)
  w.u32(t.rExit)
  w.u32(t.minResidenceEpochs)
  w.u32(t.replicas)
  w.u32(t.untouchedReplicas)
  u32Table(w, t.capacityByCpuClass)
  u32Table(w, t.cpuThresholdsMs)
  u32Table(w, t.bwThresholdsKbps)
  u32Table(w, t.latThresholdsMs)
  w.u32(t.handoffGraceTicks)
  w.u16(t.farStrides.length)
  for (const f of t.farStrides) {
    w.u16(f.maxCells)
    w.u16(f.stride)
  }
  w.u8(COST_CODE[t.costClass.seat])
  w.u8(COST_CODE[t.costClass.field])
  w.u8(COST_CODE[t.costClass.global])
  w.u32(t.botTakeoverMs)
  w.u32(t.snapshotRing)
  w.u32(t.keyframeEvery)
  w.u32(t.gridCols)
  u32Table(w, t.fieldCells)
  return fnv1a32(w.bytes())
}
