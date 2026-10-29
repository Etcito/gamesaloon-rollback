// One scenario, one process, and the same virtual frame clock as the full-mesh harness.
import { NetSim } from '../../src/index.ts'
import type { NetSimOptions } from '../../src/index.ts'
import { CONTROL_NO_CELL, MAX_PEERS, packControl, ZONE_DEFAULTS, ZoneSession } from '../../src/zones/index.ts'
import type { ControlFields, Roster, ZoneTuning } from '../../src/zones/index.ts'
import { FRAME_MS } from '../harness.ts'
import { BOOST, DOWN, LEFT, RIGHT, UP } from '../pointsim.ts'
import type { PointInput } from '../pointsim.ts'
import { seatCell, ZonePointFactory, zonePointCodec } from './zonePointSim.ts'
import type { ZonePointOptions, ZonePointSim } from './zonePointSim.ts'

export { FRAME_MS }

type LinkOptions = Partial<Omit<NetSimOptions, 'seed'>>

export interface ZoneScenario {
  peers: number
  /** Seats per peer, or one count per peer; zero is a seatless peer. Default 1. */
  seats?: number | readonly number[]
  seed?: number
  link?: LinkOptions
  /** Directed link classes, applied with NetSim.setLink. */
  links?: readonly { from: number; to: number; options: LinkOptions }[]
  frames: number
  /** Quiet frames to confirm the tail. Default 180. */
  settle?: number
  tuning?: Partial<Omit<ZoneTuning, 'costClass'>> & { costClass?: Partial<ZoneTuning['costClass']> }
  factory: Omit<ZonePointOptions, 'seatCount'>
  /** Fixed for the scenario, shared by all seats. */
  classes?: Partial<Omit<ControlFields, 'cell'>>
  /** Target cell for this seat and frame; undefined keeps the ordinary input pattern. */
  movement?: (seat: number, frame: number) => number | undefined
  /** Before the network advances, including settle frames. */
  hook?: (frame: number, ctx: ZoneCtx) => void
}

export interface ZoneCtx {
  net: NetSim
  factories: ZonePointFactory[]
  sessions: ZoneSession<PointInput>[]
  roster: Roster
  tuning: ZoneTuning
  alive: boolean[]
  /** Per peer, domain, then confirmed tick. Kept after a domain leaves the replica set. */
  confirmed: Map<number, Map<number, number>>[]
  frame: number
}

export interface DomainHashMismatch {
  domain: number
  tick: number
  peers: [number, number]
  hashes: [number, number]
}

function pattern(id: number, tick: number): number {
  let h = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul((tick >>> 3) + 7, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) % 32
}

function control(sc: ZoneScenario, cell: number): number {
  return packControl({ cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 1, ...sc.classes, cell })
}

export function zoneSetup(sc: ZoneScenario): ZoneCtx {
  if (!Number.isInteger(sc.peers) || sc.peers < 1 || sc.peers > MAX_PEERS) throw new Error('invalid peer count')
  if (Array.isArray(sc.seats) && sc.seats.length !== sc.peers) throw new Error('one seat count required per peer')
  const peers: Roster['peers'] = []
  let seatCount = 0
  for (let p = 0; p < sc.peers; p++) {
    const count = typeof sc.seats === 'number' ? sc.seats : (sc.seats?.[p] ?? 1)
    if (!Number.isInteger(count) || count < 0) throw new Error('invalid seat count')
    const seats: number[] = []
    for (let j = 0; j < count; j++) seats.push(seatCount++)
    peers.push({ peer: p, seats })
  }
  const tuning: ZoneTuning = {
    ...ZONE_DEFAULTS, gridCols: sc.factory.gridCols, ...sc.tuning,
    costClass: { ...ZONE_DEFAULTS.costClass, ...sc.tuning?.costClass },
  }
  if (tuning.gridCols !== sc.factory.gridCols) throw new Error('factory and tuning gridCols must agree')
  const net = new NetSim(sc.peers, { seed: sc.seed ?? 1, rttMs: 0, jitterMs: 0, loss: 0, reorder: 0, ...sc.link })
  for (const link of sc.links ?? []) net.setLink(link.from, link.to, link.options)
  const roster: Roster = { seatCount, peers, live: new Array(sc.peers).fill(true) }
  const ctx: ZoneCtx = {
    net, factories: [], sessions: [], roster, tuning,
    alive: new Array(sc.peers).fill(true), confirmed: [], frame: 0,
  }
  for (let p = 0; p < sc.peers; p++) {
    const factory = new ZonePointFactory({ ...sc.factory, seatCount })
    // The factory's deterministic placement supplies epoch-zero controls, before sessions exist.
    const initial = factory.create({ id: 1, kind: 'seat', cells: [], seats: peers.flatMap((x) => x.seats), replicas: [] }, 0)
    const controls = new Uint32Array(seatCount)
    for (let seat = 0; seat < seatCount; seat++) controls[seat] = control(sc, seatCell(initial, seat))
    ctx.factories.push(factory)
    ctx.sessions.push(new ZoneSession({
      localPeer: p, roster, tuning, factory, codec: zonePointCodec, controls,
      botInput: (seat, tick, out) => { out.mask = ctx.frame >= sc.frames ? 0 : pattern(seat, tick) },
    }, net.transport(p)))
    ctx.confirmed.push(new Map())
  }
  return ctx
}

function seatSim(session: ZoneSession<PointInput>, seat: number): ZonePointSim | undefined {
  return session.domain(session.assignment.seatDomain[seat])?.sim as ZonePointSim | undefined
}

function steer(sim: ZonePointSim, seat: number, target: number, mask: number): number {
  const o = sim.opts
  if (!Number.isInteger(target) || target < 0 || target >= o.gridCols * o.gridRows || target >= CONTROL_NO_CELL) {
    throw new Error('movement target must be a grid cell')
  }
  const i = sim.id.subarray(0, sim.n).indexOf(seat)
  if (i < 0) return mask
  const dx = (target % o.gridCols + 0.5) * o.cellSize - sim.x[i]
  const dy = (Math.floor(target / o.gridCols) + 0.5) * o.cellSize - sim.y[i]
  // Brake near the target using the same drag horizon as PointSim's velocity decay.
  const x = dx - sim.vx[i] * 16
  const y = dy - sim.vy[i] * 16
  return (mask & BOOST) | (x > 0 ? RIGHT : x < 0 ? LEFT : 0) | (y > 0 ? DOWN : y < 0 ? UP : 0)
}

function recordConfirmed(ctx: ZoneCtx, peer: number): void {
  const session = ctx.sessions[peer]
  const domains = ctx.confirmed[peer]
  for (const spec of session.assignment.domains) {
    if (session.domain(spec.id) && !domains.has(spec.id)) domains.set(spec.id, new Map())
  }
  // Scan retained ids too: an old state's tail can confirm during handoff grace.
  const end = session.stats.tick
  for (const [domain, ticks] of domains) {
    const frontier = session.stats.confirmedTick[domain] ?? end
    for (let tick = Math.max(0, Math.min(frontier, end) - ctx.tuning.snapshotRing); tick <= end; tick++) {
      const hash = session.confirmedHash(domain, tick)
      if (hash !== undefined && !ticks.has(tick)) ticks.set(tick, hash)
    }
  }
}

/** Runs one scenario; pass a setup context to inspect it afterwards. Returns every observed disagreement. */
export function zoneRun(sc: ZoneScenario, ctx = zoneSetup(sc)): DomainHashMismatch[] {
  const total = sc.frames + (sc.settle ?? 180)
  for (let frame = 0; frame < total; frame++) {
    ctx.frame = frame
    sc.hook?.(frame, ctx)
    ctx.net.advance(FRAME_MS)
    for (let p = 0; p < sc.peers; p++) {
      if (!ctx.alive[p]) continue
      const session = ctx.sessions[p]
      const seats = ctx.roster.peers[p].seats
      session.frame(FRAME_MS / 1000, (inputs, controls) => {
        for (let j = 0; j < seats.length; j++) {
          const seat = seats[j]
          const sim = seatSim(session, seat)
          let mask = frame >= sc.frames ? 0 : pattern(seat, sim?.tick ?? session.stats.tick)
          const target = frame < sc.frames ? sc.movement?.(seat, frame) : undefined
          if (sim && target !== undefined) mask = steer(sim, seat, target, mask)
          inputs[j].mask = mask
          controls[j] = control(sc, sim ? seatCell(sim, seat) : CONTROL_NO_CELL)
        }
      })
      recordConfirmed(ctx, p)
    }
  }
  return domainHashMismatches(ctx)
}

/** Compare only shared (domain, tick) samples; absent replicas are not disagreements. */
export function domainHashMismatches(ctx: ZoneCtx): DomainHashMismatch[] {
  const mismatches: DomainHashMismatch[] = []
  const first = new Map<number, Map<number, { peer: number; hash: number }>>()
  for (let peer = 0; peer < ctx.confirmed.length; peer++) {
    for (const [domain, ticks] of ctx.confirmed[peer]) {
      let samples = first.get(domain)
      if (!samples) first.set(domain, samples = new Map())
      for (const [tick, hash] of ticks) {
        const other = samples.get(tick)
        if (!other) samples.set(tick, { peer, hash })
        else if (hash !== other.hash) mismatches.push({ domain, tick, peers: [other.peer, peer], hashes: [other.hash, hash] })
      }
    }
  }
  return mismatches.sort((a, b) => a.domain - b.domain || a.tick - b.tick || a.peers[1] - b.peers[1])
}

function setAlive(ctx: ZoneCtx, peer: number, alive: boolean): void {
  if (!Number.isInteger(peer) || peer < 0 || peer >= ctx.alive.length) throw new Error('invalid peer')
  ctx.alive[peer] = alive
  // Unlisted peers are each isolated; reviving one never reconnects another dead peer.
  ctx.net.partition([ctx.alive.flatMap((live, p) => live ? [p] : [])])
}

export function killPeer(ctx: ZoneCtx, peer: number): void {
  setAlive(ctx, peer, false)
}

export function revivePeer(ctx: ZoneCtx, peer: number): void {
  setAlive(ctx, peer, true)
}

/** Current confirmed tick per peer, or -1 when that peer does not replicate the domain. */
export function domainConfirmedTicks(ctx: ZoneCtx, domain: number): number[] {
  return ctx.sessions.map((session) => session.stats.confirmedTick[domain] ?? -1)
}
