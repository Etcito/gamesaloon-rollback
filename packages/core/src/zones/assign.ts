// The pure epoch assignment: control words in, domains, replicas and seat hosts out. Every limit comes from ZoneTuning.

import { fnv1a32 } from '../snap.ts'
import { CONTROL_NO_CELL, unpackControl } from './control.ts'
import type { ControlFields } from './control.ts'
import { domainIdOf, nearComponents, splitByCapacity } from './nearGraph.ts'
import { rendezvousRank, seatHostFor } from './rendezvous.ts'
import type { Assignment, ControlSample, DomainId, DomainSpec, Roster, SeatId, ShadowLink } from './types.ts'
import type { ZoneTuning } from './tuning.ts'

const scoreKey = new Uint8Array(3)

// The contract score; used to order owners (possibly weight 0) together with the rendezvous fill.
function replicaScore(domainId: DomainId, peer: number, weight: number): number {
  scoreKey[0] = domainId & 0xff
  scoreKey[1] = (domainId >>> 8) & 0xff
  scoreKey[2] = peer
  return (fnv1a32(scoreKey) >>> 8) * weight
}

function orderReplicas(domainId: DomainId, set: number[], weightOf: (peer: number) => number): number[] {
  const scores = new Map<number, number>()
  for (const p of set) scores.set(p, replicaScore(domainId, p, weightOf(p)))
  return set.sort((a, b) => scores.get(b)! - scores.get(a)! || a - b)
}

function cellDistance(a: number, b: number, gridCols: number): number {
  const dr = Math.abs(Math.floor(a / gridCols) - Math.floor(b / gridCols))
  const dc = Math.abs((a % gridCols) - (b % gridCols))
  return dr > dc ? dr : dc
}

/** assign(roster, controls, prev, tuning): contract steps 1 to 7. Never mutates its inputs. */
export function assign(
  roster: Roster,
  controls: ControlSample,
  prev: Assignment | null,
  tuning: ZoneTuning,
): Assignment {
  const seatCount = roster.seatCount
  const live = (p: number): boolean => p >= 0 && roster.live[p] === true

  // Setup: one unpack per seat; a peer's classes come from any of its seats.
  const fields: ControlFields = { cell: 0, cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 0 }
  const cells = new Uint16Array(seatCount).fill(CONTROL_NO_CELL)
  const owner = new Int32Array(seatCount).fill(-1)
  const peerIds: number[] = []
  const weight: number[] = []
  const peerCap: number[] = []
  for (const entry of roster.peers) {
    peerIds.push(entry.peer)
    for (const seat of entry.seats) {
      if (seat < 0 || seat >= seatCount) continue
      owner[seat] = entry.peer
      unpackControl(controls.words[seat], fields)
      cells[seat] = fields.cell
      const cap = tuning.capacityByCpuClass[fields.cpuClass] ?? 0
      peerCap[entry.peer] = cap
      weight[entry.peer] = cap * fields.spareSlots
    }
  }
  peerIds.sort((a, b) => a - b)
  const weightOf = (p: number): number => weight[p] ?? 0
  const weighted = peerIds.filter((p) => live(p) && weightOf(p) > 0)

  // Residence lock. A seat with no prev domain has nothing to stay with.
  let locked: Uint8Array | null = null
  if (prev !== null) {
    locked = new Uint8Array(seatCount)
    for (let s = 0; s < seatCount && s < prev.residence.length; s++) {
      if (prev.residence[s] < tuning.minResidenceEpochs && prev.seatDomain[s] >= 0 && live(owner[s])) locked[s] = 1
    }
  }
  const roots = nearComponents(cells, prev, locked, tuning)

  const components = new Map<number, SeatId[]>()
  for (let s = 0; s < seatCount; s++) {
    if (roots[s] < 0) continue
    const members = components.get(roots[s])
    if (members === undefined) components.set(roots[s], [s])
    else members.push(s)
  }

  // Capacity: every replica simulates the whole domain, so the weakest of the best R bounds its size.
  const seatChunks: SeatId[][] = []
  const shadows: ShadowLink[] = []
  for (const members of components.values()) {
    const pool = new Set<number>(weighted)
    for (const s of members) if (live(owner[s])) pool.add(owner[s])
    const caps = [...pool].map((p) => peerCap[p]).sort((a, b) => b - a)
    if (caps.length === 0) {
      seatChunks.push(members)
      continue
    }
    const cap = caps[Math.min(tuning.replicas, caps.length) - 1]
    const split = splitByCapacity(members, cells, cap, tuning)
    for (const chunk of split.chunks) seatChunks.push(chunk)
    for (const link of split.shadows) shadows.push(link)
  }
  shadows.sort((a, b) => a.from - b.from || a.to - b.to)

  const seatDomain = new Int32Array(seatCount).fill(-1)
  const domainCells = new Map<DomainId, Set<number>>()
  const domainSeats = new Map<DomainId, SeatId[]>()
  for (const chunk of seatChunks) {
    const id = domainIdOf('seat', Math.min(...chunk), seatCount)
    const sorted = [...chunk].sort((a, b) => a - b)
    domainSeats.set(id, sorted)
    domainCells.set(id, new Set(sorted.map((s) => cells[s])))
    for (const s of sorted) seatDomain[s] = id
  }

  // Field domains: an untouched cell is its own domain, a touched one joins the nearest seat's domain.
  const fieldCells: number[] = []
  for (const cell of tuning.fieldCells) {
    let best = -1
    let bestDist = 0
    for (let s = 0; s < seatCount; s++) {
      if (seatDomain[s] < 0) continue
      const d = cellDistance(cell, cells[s], tuning.gridCols)
      if (d > tuning.rEnter) continue
      if (best < 0 || d < bestDist || (d === bestDist && seatDomain[s] < best)) {
        best = seatDomain[s]
        bestDist = d
      }
    }
    if (best < 0) fieldCells.push(cell)
    else domainCells.get(best)!.add(cell)
  }

  // Replicas: live owners always, then the weighted rendezvous fill, then one canonical order.
  const replicasOf = (id: DomainId, seats: readonly SeatId[], target: number): number[] => {
    const set: number[] = []
    for (const s of seats) if (live(owner[s]) && !set.includes(owner[s])) set.push(owner[s])
    if (set.length < target) {
      const others = weighted.filter((p) => !set.includes(p))
      for (const p of rendezvousRank(id, others, others.map(weightOf), [])) {
        if (set.length >= target) break
        set.push(p)
      }
    }
    return orderReplicas(id, set, weightOf)
  }

  const playing: SeatId[] = []
  for (let s = 0; s < seatCount; s++) if (seatDomain[s] >= 0) playing.push(s)
  const domains: DomainSpec[] = [
    { id: 0, kind: 'global', cells: [], seats: playing, replicas: orderReplicas(0, peerIds.filter(live), weightOf) },
  ]
  for (const [id, seats] of domainSeats) {
    const specCells = [...domainCells.get(id)!].sort((a, b) => a - b)
    domains.push({ id, kind: 'seat', cells: specCells, seats, replicas: replicasOf(id, seats, tuning.replicas) })
  }
  for (const cell of fieldCells) {
    const id = domainIdOf('field', cell, seatCount)
    domains.push({ id, kind: 'field', cells: [cell], seats: [], replicas: replicasOf(id, [], tuning.untouchedReplicas) })
  }
  domains.sort((a, b) => a.id - b.id)

  const byId = new Map<DomainId, DomainSpec>()
  for (const d of domains) byId.set(d.id, d)
  const seatHost = new Int16Array(seatCount)
  const residence = new Uint16Array(seatCount)
  for (let s = 0; s < seatCount; s++) {
    const id = seatDomain[s]
    if (live(owner[s])) seatHost[s] = owner[s]
    else seatHost[s] = id >= 0 ? seatHostFor(s, controls.epoch, byId.get(id)!.replicas) : -1
    const kept = prev !== null && s < prev.seatDomain.length && prev.seatDomain[s] === id
    residence[s] = kept ? Math.min(prev.residence[s] + 1, 0xffff) : 0
  }

  return { epoch: controls.epoch, domains, shadows, seatDomain, seatHost, residence }
}
