// Near graph over seats: which seats share a domain this epoch. Pure; every radius comes from ZoneTuning.

import { CONTROL_NO_CELL } from './control.ts'
import type { Assignment, DomainId, DomainKind, SeatId, ShadowLink } from './types.ts'
import type { ZoneTuning } from './tuning.ts'

/** Canonical domain ids: global first, then seat domains by lowest seat, then field domains by cell. */
export function domainIdOf(kind: DomainKind, key: number, seatCount: number): DomainId {
  if (kind === 'global') return 0
  if (kind === 'seat') return 1 + key
  return 1 + seatCount + key
}

/** Chebyshev distance between two cell ids of a gridCols-wide grid. */
function cellDistance(a: number, b: number, gridCols: number): number {
  const dr = Math.abs(Math.floor(a / gridCols) - Math.floor(b / gridCols))
  const dc = Math.abs((a % gridCols) - (b % gridCols))
  return dr > dc ? dr : dc
}

function find(parent: Int32Array, i: number): number {
  let root = i
  while (parent[root] !== root) root = parent[root]
  while (parent[i] !== root) {
    const next = parent[i]
    parent[i] = root
    i = next
  }
  return root
}

/** The lower root always wins, so a component's root is its lowest seat whatever the union order. */
function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a)
  const rb = find(parent, b)
  if (ra < rb) parent[rb] = ra
  else if (rb < ra) parent[ra] = rb
}

function prevDomainOf(prev: Assignment | null, seat: SeatId): DomainId {
  if (prev === null || seat >= prev.seatDomain.length) return -1
  return prev.seatDomain[seat]
}

/**
 * Per seat, the root (lowest seat id) of its near component, or -1 for an observer. An edge enters at rEnter and
 * stays up to rExit between seats prev had connected (same domain or a shadow link), so a seat on the boundary does
 * not flap. A locked seat never crosses into another prev domain, and a seat under residence keeps its prev
 * domain-mates joined even when they are unlocked.
 */
export function nearComponents(
  cells: ArrayLike<number>,
  prev: Assignment | null,
  locked: Uint8Array | null,
  tuning: ZoneTuning,
): Int32Array {
  const n = cells.length
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const linked = new Set<string>()
  if (prev !== null) for (const s of prev.shadows) linked.add(`${s.from}:${s.to}`)

  for (let a = 0; a < n; a++) {
    if (cells[a] === CONTROL_NO_CELL) continue
    const domA = prevDomainOf(prev, a)
    const lockA = locked !== null && a < locked.length && locked[a] !== 0
    for (let b = a + 1; b < n; b++) {
      if (cells[b] === CONTROL_NO_CELL) continue
      const domB = prevDomainOf(prev, b)
      const lockB = locked !== null && b < locked.length && locked[b] !== 0
      // Residence only means something against a prev assignment.
      if (prev !== null && (lockA || lockB)) {
        if (domA !== domB) continue
        if (domA >= 0) {
          union(parent, a, b)
          continue
        }
      }
      const d = cellDistance(cells[a], cells[b], tuning.gridCols)
      if (d <= tuning.rEnter) {
        union(parent, a, b)
      } else if (d <= tuning.rExit && domA >= 0 && domB >= 0) {
        if (domA === domB || linked.has(`${domA}:${domB}`) || linked.has(`${domB}:${domA}`)) union(parent, a, b)
      }
    }
  }

  const roots = new Int32Array(n)
  for (let i = 0; i < n; i++) roots[i] = cells[i] === CONTROL_NO_CELL ? -1 : find(parent, i)
  return roots
}

/** Chunks of one component, each sorted by seat, and the seat-domain shadow links between adjacent chunks. */
export interface CapacitySplit {
  chunks: SeatId[][]
  shadows: ShadowLink[]
}

/**
 * Splits a component too large for its replicas in ascending (cell, seat) order, so chunks stay spatially compact
 * and every peer cuts at the same seats. Chunks within rExit of each other shadow each other, both directions.
 */
export function splitByCapacity(
  members: readonly SeatId[],
  cells: ArrayLike<number>,
  cap: number,
  tuning: ZoneTuning,
): CapacitySplit {
  if (members.length <= cap) return { chunks: [[...members].sort((a, b) => a - b)], shadows: [] }
  if (!(cap >= 1)) throw new Error('[zones] assign: capacity below one seat')
  const size = Math.floor(cap)
  const ordered = [...members].sort((a, b) => cells[a] - cells[b] || a - b)
  const chunks: SeatId[][] = []
  for (let i = 0; i < ordered.length; i += size) chunks.push(ordered.slice(i, i + size).sort((a, b) => a - b))

  const shadows: ShadowLink[] = []
  const seatCount = cells.length
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      if (!adjacent(chunks[i], chunks[j], cells, tuning)) continue
      const di = domainIdOf('seat', chunks[i][0], seatCount)
      const dj = domainIdOf('seat', chunks[j][0], seatCount)
      shadows.push({ from: di, to: dj }, { from: dj, to: di })
    }
  }
  shadows.sort((a, b) => a.from - b.from || a.to - b.to)
  return { chunks, shadows }
}

function adjacent(a: readonly SeatId[], b: readonly SeatId[], cells: ArrayLike<number>, tuning: ZoneTuning): boolean {
  for (const sa of a) {
    for (const sb of b) if (cellDistance(cells[sa], cells[sb], tuning.gridCols) <= tuning.rExit) return true
  }
  return false
}
