import { initRapier, RapierWorldSim } from "../src/index.ts";
import type { BodyId, RapierModule } from "../src/index.ts";

/** Integer-only PRNG (mulberry32). Never use Math.random in sim code. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function getR(): Promise<RapierModule> {
  return initRapier();
}

export interface Scenario {
  sim: RapierWorldSim;
  dynamic: BodyId[];
}

/**
 * Ground + walls + n dynamic bodies (alternating balls and boxes) dropped in a grid.
 * Built from a fixed seed, so two calls give two identical worlds.
 */
export function buildScenario(R: RapierModule, n: number, seed = 1234, canSleep = true): Scenario {
  const sim = new RapierWorldSim(R);
  const rnd = mulberry32(seed);
  const fixed = (x: number, y: number, z: number, hx: number, hy: number, hz: number) =>
    sim.createBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z), [R.ColliderDesc.cuboid(hx, hy, hz)]);
  fixed(0, -0.5, 0, 60, 0.5, 60);
  fixed(-30, 5, 0, 0.5, 5, 30);
  fixed(30, 5, 0, 0.5, 5, 30);
  fixed(0, 5, -30, 30, 5, 0.5);
  fixed(0, 5, 30, 30, 5, 0.5);
  const dynamic: BodyId[] = [];
  const perRow = 10;
  for (let i = 0; i < n; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow) % perRow;
    const layer = Math.floor(i / (perRow * perRow));
    const x = (col - perRow / 2) * 1.5 + (rnd() - 0.5) * 0.3;
    const z = (row - perRow / 2) * 1.5 + (rnd() - 0.5) * 0.3;
    const y = 1 + layer * 1.6 + (rnd() - 0.5) * 0.2;
    const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z);
    const col2 = i % 2 === 0 ? R.ColliderDesc.ball(0.5) : R.ColliderDesc.cuboid(0.4, 0.4, 0.4);
    dynamic.push(sim.createBody(desc.setCanSleep(canSleep), [col2.setRestitution(0.3).setFriction(0.7)]));
  }
  return { sim, dynamic };
}

/**
 * Deterministic "player inputs" for a tick: a pure function of (tick, ids).
 * Every 7th tick, a handful of bodies get an impulse. Iterates ids in registry order.
 */
export function applyInputs(sim: RapierWorldSim, dynamic: BodyId[], tick: number): void {
  if (tick % 7 !== 0) return;
  const rnd = mulberry32(tick * 2654435761);
  const hits = Math.min(4, dynamic.length);
  for (let k = 0; k < hits; k++) {
    const id = dynamic[Math.floor(rnd() * dynamic.length)];
    if (!sim.hasBody(id)) continue;
    const b = sim.body(id);
    b.applyImpulse({ x: (rnd() - 0.5) * 4, y: rnd() * 6, z: (rnd() - 0.5) * 4 }, true);
  }
}

/** One game tick: inputs for the tick being simulated, then Rapier step. */
export function tickOnce(s: Scenario): void {
  applyInputs(s.sim, s.dynamic, s.sim.tick);
  s.sim.step();
}

export function run(s: Scenario, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickOnce(s);
}
