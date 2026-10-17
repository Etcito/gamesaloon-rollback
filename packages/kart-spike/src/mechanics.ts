// Game mechanics that sit ABOVE the physics: drift + mini-turbo and the boost stack. They are pure state
// machines over a small Float64 record per kart; the only things they ask of physics are "am I grounded",
// "how fast am I going forward" and "add this much upward velocity". That is why they port to a Rapier
// kart unchanged (constants copied from the Monster Racer simulation). The record is part of the
// game snapshot next to the Rapier world snapshot.
import { clamp } from "./mathx.ts";
import type { KartInput } from "./inputCode.ts";

/** Float64 slots per kart. */
export const M_DRIFT_ACTIVE = 0;
export const M_DRIFT_DIR = 1;
export const M_CHARGE = 2;
export const M_STAGE = 3;
export const M_HOP = 4;
export const M_BOOST_TIME = 5;
export const M_BOOST_FRAC = 6;
export const M_BOOST_ACCEL = 7;
export const M_PREV_DRIFT = 8;
export const MECH_SLOTS = 9;

export type BoostKind = "mt1" | "mt2" | "mt3" | "pad" | "mushroom";
export const BOOST_TABLE: Record<BoostKind, { duration: number; speedFrac: number; accel: number }> = {
  mt1: { duration: 0.5, speedFrac: 0.22, accel: 30 },
  mt2: { duration: 1.0, speedFrac: 0.22, accel: 30 },
  mt3: { duration: 1.6, speedFrac: 0.25, accel: 34 },
  pad: { duration: 0.9, speedFrac: 0.35, accel: 40 },
  mushroom: { duration: 1.1, speedFrac: 0.38, accel: 45 },
};

export const MT_THRESHOLDS = [1.0, 2.1, 3.3];
const MT_KINDS: BoostKind[] = ["mt1", "mt2", "mt3"];
const START_MIN_SPEED = 10;
const START_MIN_STEER = 0.2;
const END_MIN_SPEED = 8;
const END_BRAKE = 0.5;
export const HOP_SPEED = 3;
const HOP_TIME = 0.25;
const CHARGE_BASE = 0.7;
const CHARGE_STEER = 0.6;
const TIME_EPS = 1e-6;

/** Start or extend a boost: longest time and strongest fraction win, the latest kind sets the acceleration. */
export function requestBoost(m: Float64Array, o: number, kind: BoostKind): void {
  const e = BOOST_TABLE[kind];
  m[o + M_BOOST_TIME] = Math.max(m[o + M_BOOST_TIME], e.duration);
  m[o + M_BOOST_FRAC] = Math.max(m[o + M_BOOST_FRAC], e.speedFrac);
  m[o + M_BOOST_ACCEL] = e.accel;
}

/**
 * Drift tick (reference order: before boost, before physics). Returns the upward hop velocity to add
 * (0 unless a drift started this tick). speed = signed forward speed at the start of the tick.
 */
export function stepDrift(m: Float64Array, o: number, inp: KartInput, speed: number, grounded: boolean, dt: number): number {
  let hop = 0;
  if (m[o + M_HOP] > 0) m[o + M_HOP] = Math.max(0, m[o + M_HOP] - dt);
  const prev = m[o + M_PREV_DRIFT] !== 0;
  m[o + M_PREV_DRIFT] = inp.drift ? 1 : 0;
  if (m[o + M_DRIFT_ACTIVE] === 0) {
    if (!inp.drift || prev) return 0;
    const steer = clamp(inp.steer, -1, 1);
    if (!grounded || !(speed > START_MIN_SPEED) || Math.abs(steer) <= START_MIN_STEER) return 0;
    m[o + M_DRIFT_ACTIVE] = 1;
    m[o + M_DRIFT_DIR] = steer > 0 ? 1 : -1;
    m[o + M_CHARGE] = 0;
    m[o + M_STAGE] = 0;
    m[o + M_HOP] = HOP_TIME;
    hop = HOP_SPEED;
    return hop;
  }
  const braking = inp.brake > END_BRAKE;
  if (!inp.drift || !(speed >= END_MIN_SPEED) || braking) {
    const stage = m[o + M_STAGE];
    m[o + M_DRIFT_ACTIVE] = 0;
    m[o + M_DRIFT_DIR] = 0;
    m[o + M_CHARGE] = 0;
    m[o + M_STAGE] = 0;
    if (stage > 0) requestBoost(m, o, MT_KINDS[stage - 1]);
    return 0;
  }
  if (!grounded) return 0;
  const dir = m[o + M_DRIFT_DIR];
  m[o + M_CHARGE] += dt * (CHARGE_BASE + CHARGE_STEER * clamp(inp.steer * dir, 0, 1));
  while (m[o + M_STAGE] < 3 && m[o + M_CHARGE] >= MT_THRESHOLDS[m[o + M_STAGE]]) m[o + M_STAGE] += 1;
  return 0;
}

/** Boost tick: returns the speed bonus and acceleration for THIS tick through out[0], out[1]. */
export function stepBoost(m: Float64Array, o: number, topSpeed: number, dt: number, out: Float64Array): void {
  out[0] = 0;
  out[1] = 0;
  if (m[o + M_BOOST_TIME] > 0) {
    out[0] = m[o + M_BOOST_FRAC] * topSpeed;
    out[1] = m[o + M_BOOST_ACCEL];
    m[o + M_BOOST_TIME] -= dt;
    if (m[o + M_BOOST_TIME] > TIME_EPS) return;
  } else if (m[o + M_BOOST_ACCEL] === 0 && m[o + M_BOOST_FRAC] === 0 && m[o + M_BOOST_TIME] === 0) {
    return;
  }
  m[o + M_BOOST_TIME] = 0;
  m[o + M_BOOST_FRAC] = 0;
  m[o + M_BOOST_ACCEL] = 0;
}
