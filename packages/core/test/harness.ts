// Test harness: N peers, each with its own PointSim and RollbackSession, wired through NetSim on a virtual clock.
import { NetSim, RollbackSession } from '../src/index.ts'
import type { DesyncDump, PeerConfig, RollbackConfig } from '../src/index.ts'
import { PointSim, pointCodec } from './pointsim.ts'
import type { PointInput } from './pointsim.ts'

export const FRAME_MS = 1000 / 60

export interface Scenario {
  peers: number
  /** Players per peer (a number for all, or one per peer). Default 1. */
  players?: number | number[]
  rttMs?: number
  jitterMs?: number
  loss?: number
  reorder?: number
  seed?: number
  frames: number
  /** Extra quiet frames at the end so the last ticks get confirmed. Default 180. */
  settle?: number
  useSimHash?: boolean
  /** First frame at which each peer starts calling frame() (default 0). */
  startFrame?: number[]
  /** Seed of the sim of each peer (default: all the same). */
  simSeeds?: number[]
  /** Called at the start of every frame, before the network advances. */
  hook?: (frame: number, ctx: Ctx) => void
}

export interface Ctx {
  net: NetSim
  sims: PointSim[]
  sessions: RollbackSession<PointInput>[]
  alive: boolean[]
  /** confirmed hash of each tick, per peer. */
  confirmed: Map<number, number>[]
  dumps: DesyncDump[][]
  lost: { peer: number; lostPeer: number; switchTick: number }[]
  playerCount: number
  frame: number
}

export function splitPlayers(sc: Scenario): { cfgs: PeerConfig[]; total: number } {
  const cfgs: PeerConfig[] = []
  let next = 0
  for (let p = 0; p < sc.peers; p++) {
    const n = Array.isArray(sc.players) ? sc.players[p] : (sc.players ?? 1)
    const players: number[] = []
    for (let j = 0; j < n; j++) players.push(next++)
    cfgs.push({ peer: p, players })
  }
  return { cfgs, total: next }
}

function pattern(id: number, tick: number): number {
  let h = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul((tick >>> 3) + 7, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) % 32
}

export function setup(sc: Scenario): Ctx {
  const { cfgs, total } = splitPlayers(sc)
  const net = new NetSim(sc.peers, { seed: sc.seed ?? 1, rttMs: sc.rttMs ?? 0, jitterMs: sc.jitterMs ?? 0, loss: sc.loss ?? 0, reorder: sc.reorder ?? 0 })
  const ctx: Ctx = { net, sims: [], sessions: [], alive: [], confirmed: [], dumps: [], lost: [], playerCount: total, frame: 0 }
  for (let p = 0; p < sc.peers; p++) {
    const sim = new PointSim(total, sc.simSeeds ? sc.simSeeds[p] : 777, sc.useSimHash ?? false)
    const cfg: RollbackConfig<PointInput> = { localPeer: p, playerCount: total, peers: cfgs, codec: pointCodec, dumpInfo: () => ({ peer: p }) }
    const s = new RollbackSession<PointInput>(sim, cfg, net.transport(p))
    ctx.dumps.push([])
    s.onDesync = (d) => ctx.dumps[p].push(d)
    s.onPeerLost = (lostPeer, switchTick) => ctx.lost.push({ peer: p, lostPeer, switchTick })
    ctx.sims.push(sim)
    ctx.sessions.push(s)
    ctx.alive.push(true)
    ctx.confirmed.push(new Map())
  }
  return ctx
}

/** Runs the scenario and returns the context. */
export function run(sc: Scenario): Ctx {
  const ctx = setup(sc)
  const { cfgs } = splitPlayers(sc)
  const lastRecorded: number[] = new Array(sc.peers).fill(-1)
  const total = sc.frames + (sc.settle ?? 180)
  for (let f = 0; f < total; f++) {
    ctx.frame = f
    if (sc.hook) sc.hook(f, ctx)
    ctx.net.advance(FRAME_MS)
    for (let p = 0; p < sc.peers; p++) {
      if (!ctx.alive[p]) continue
      if (sc.startFrame && f < sc.startFrame[p]) continue
      const s = ctx.sessions[p]
      const sim = ctx.sims[p]
      const mine = cfgs[p].players
      const quiet = f >= sc.frames
      s.frame(1 / 60, (out) => {
        for (let j = 0; j < mine.length; j++) out[j].mask = quiet ? 0 : pattern(mine[j], sim.tick)
      })
      const c = s.stats.confirmedTick
      for (let t = lastRecorded[p] + 1; t <= c; t++) {
        const h = s.confirmedHash(t)
        if (h !== undefined) ctx.confirmed[p].set(t, h)
      }
      if (c > lastRecorded[p]) lastRecorded[p] = c
    }
  }
  return ctx
}

/** Ticks confirmed by every listed peer, ascending. */
export function commonTicks(ctx: Ctx, peers: number[]): number[] {
  const out: number[] = []
  const first = ctx.confirmed[peers[0]]
  for (const t of first.keys()) {
    let all = true
    for (let i = 1; i < peers.length; i++) if (!ctx.confirmed[peers[i]].has(t)) all = false
    if (all) out.push(t)
  }
  return out.sort((a, b) => a - b)
}

/** First tick (>= from) at which the listed peers disagree, or -1. */
export function firstMismatch(ctx: Ctx, peers: number[], from = 0): number {
  for (const t of commonTicks(ctx, peers)) {
    if (t < from) continue
    const h = ctx.confirmed[peers[0]].get(t)
    for (let i = 1; i < peers.length; i++) if (ctx.confirmed[peers[i]].get(t) !== h) return t
  }
  return -1
}
