// Long zone scenario: 64 peers, 60 seats and three link classes over three virtual minutes of moving clusters.
// npm test does not discover this file; a programmatic card runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rng } from '../../src/index.ts'
import { zoneRun, zoneSetup } from '../zones/zoneHarness.ts'
import type { ZoneScenario } from '../zones/zoneHarness.ts'

const PEERS = 64
const SEATS = 60
const GROUP = 12
const PHASE_FRAMES = 15 * 60
const FRAMES = 3 * 60 * 60
const SETTLE = 10 * 60
const STALL_BOUND_TICKS = 5 * 60

const COLS = 32
const ROWS = 20

type LinkOptions = NonNullable<ZoneScenario['link']>
type Links = NonNullable<ZoneScenario['links']>
type Placement = (seat: number) => readonly [number, number]

const CLASSES: readonly LinkOptions[] = [
  { rttMs: 40, jitterMs: 6, loss: 0, reorder: 0 },
  { rttMs: 100, jitterMs: 16, loss: 0, reorder: 0 },
  { rttMs: 180, jitterMs: 30, loss: 0, reorder: 0 },
]

// One class per unordered pair, applied to both directions, so the seeded draw covers every link.
function seededLinks(): Links {
  const rng = new Rng(0x2f6e)
  const links: { from: number; to: number; options: LinkOptions }[] = []
  for (let a = 0; a < PEERS; a++) {
    for (let b = a + 1; b < PEERS; b++) {
      const options = CLASSES[rng.int(0, CLASSES.length - 1)]
      links.push({ from: a, to: b, options }, { from: b, to: a, options })
    }
  }
  return links
}

function blocks(bases: readonly (readonly [number, number])[]): Placement {
  return (seat) => {
    const base = bases[(seat / GROUP) | 0]
    const i = seat % GROUP
    return [base[0] + (i % 4), base[1] + ((i / 4) | 0)]
  }
}

// Groups apart, groups touching in pairs (capacity chunks mix both groups), and all seats interleaved cell by cell.
const LAYOUTS: readonly Placement[] = [
  blocks([[3, 3], [12, 3], [21, 3], [3, 12], [21, 12]]),
  blocks([[3, 3], [7, 4], [21, 3], [25, 4], [12, 12]]),
  blocks([[3, 10], [12, 10], [21, 10], [3, 15], [12, 15]]),
  (seat) => {
    const i = (seat / 5) | 0
    return [3 + (i % 20), 6 + ((i / 20) | 0)]
  },
  blocks([[5, 3], [9, 4], [17, 3], [21, 4], [13, 12]]),
]

function target(seat: number, frame: number): number {
  const [col, row] = LAYOUTS[Math.floor(frame / PHASE_FRAMES) % LAYOUTS.length](seat)
  return row * COLS + col
}

const scenario: ZoneScenario = {
  peers: PEERS,
  seats: Array.from({ length: PEERS }, (_, p) => (p < SEATS ? 1 : 0)),
  seed: 0x2f6e,
  link: { rttMs: 40, jitterMs: 6, loss: 0, reorder: 0 },
  links: seededLinks(),
  frames: FRAMES,
  settle: SETTLE,
  classes: { cpuClass: 3, bwClass: 0, latClass: 0, spareSlots: 1 },
  factory: {
    gridCols: COLS,
    gridRows: ROWS,
    cellSize: 1000,
    fieldPerCell: 1,
    windEvery: 24,
    windMag: 2,
    radius: 500,
    stopBelow: 4,
    sleepTicks: 40,
    shadowMargin: 1,
    goalY: 10 * 1000,
    maxGhosts: 1024,
    maxEvents: 64,
    eventKinds: 1,
  },
  movement: target,
}

test('64 peers agree and keep confirming through merges and splits', { timeout: 3_600_000 }, () => {
  const ctx = zoneSetup(scenario)
  const mismatches = zoneRun(scenario, ctx)
  assert.deepEqual(mismatches, [])

  let latest = 0
  for (const session of ctx.sessions) if (session.stats.tick > latest) latest = session.stats.tick
  assert.ok(latest >= FRAMES, `run reached tick ${latest}, below ${FRAMES}`)

  for (let p = 0; p < PEERS; p++) {
    const session = ctx.sessions[p]
    for (const spec of session.assignment.domains) {
      if (!session.domain(spec.id)) continue
      const confirmed = session.stats.confirmedTick[spec.id]
      assert.ok(confirmed !== undefined, `peer ${p} never confirmed domain ${spec.id}`)
      assert.ok(
        latest - confirmed <= STALL_BOUND_TICKS,
        `peer ${p} domain ${spec.id} is stuck at ${confirmed} while the latest tick is ${latest}`,
      )
    }
  }
})
