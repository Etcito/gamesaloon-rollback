// The arcade DRIVING LAW: pure functions of (speed, input, parameters). These are the numbers that
// define how the kart feels (acceleration curve, steering falloff with speed, brake, reverse, grip).
// Copied from the Monster Racer simulation so a Rapier kart can reuse the exact same law; Rapier then
// replaces everything that is geometry (ground following, walls, kart-kart contact, integration).
import { clamp } from "./mathx.ts";
import type { KartInput } from "./inputCode.ts";

export interface KartStats { speed: number; accel: number; weight: number; handling: number }
export interface PhysParams { topSpeed: number; accel: number; mass: number; steerRate: number; radius: number; rideHeight: number }

export type Cc = 50 | 100 | 150 | 200;
export const CLASS_PARAMS: Record<Cc, { topSpeed: number; accelScale: number; steerScale: number }> = {
  50: { topSpeed: 18, accelScale: 0.8, steerScale: 1.05 },
  100: { topSpeed: 23, accelScale: 0.9, steerScale: 1.0 },
  150: { topSpeed: 28, accelScale: 1.0, steerScale: 0.95 },
  200: { topSpeed: 35, accelScale: 1.15, steerScale: 0.9 },
};

export const KART_RADIUS = 1.1;
export const RIDE_HEIGHT = 0.4;

export function derivePhys(stats: KartStats, cc: Cc): PhysParams {
  const C = CLASS_PARAMS[cc];
  return {
    topSpeed: C.topSpeed * (0.88 + 0.024 * stats.speed),
    accel: 11 * C.accelScale * (0.7 + 0.06 * stats.accel),
    mass: 0.8 + 0.06 * stats.weight,
    steerRate: 1.6 * (0.8 + 0.04 * stats.handling) * C.steerScale,
    radius: KART_RADIUS,
    rideHeight: RIDE_HEIGHT,
  };
}

/** Stats of the default build used by both sims in the comparison (rex/classic/standard/wing). */
export const SPIKE_STATS: KartStats = { speed: 5, accel: 5, weight: 4, handling: 6 };

export const GRAVITY = 21.6;

export const BRAKE_DECEL = 32;
export const REVERSE_MAX = 6;
export const REVERSE_ACCEL = 8;
export const COAST_DECEL = 3;
export const OVERSPEED_DECEL = 10;
export const MIN_TOP = 1;
export const MIN_ACCEL_FRAC = 0.2;
export const STEER_FULL_SPEED = 8;
export const STEER_HIGH_SPEED_CUT = 0.35;
export const DRIFT_BASE = 0.55;
export const DRIFT_STEER = 0.45;
export const GRIP_RATE = 10;
export const DRIFT_GRIP_RATE = 2.5;
export const AIR_STEER = 0.25;

/** Yaw rate (rad/s, positive turns right) for the signed forward speed. */
export function yawRate(steerRate: number, input: KartInput, speed: number, top: number, driftDir: number): number {
  const steer = clamp(input.steer, -1, 1);
  if (driftDir !== 0) return steerRate * (DRIFT_BASE * driftDir + DRIFT_STEER * steer);
  const a = Math.abs(speed);
  const w = steer * steerRate * clamp(a / STEER_FULL_SPEED, 0, 1) * (1 - STEER_HIGH_SPEED_CUT * clamp(a / top, 0, 1));
  return speed < 0 ? -w : w;
}

/** New signed forward speed: accelerate, brake then reverse, coast, or shed speed above top. */
export function driveSpeed(v: number, top: number, accel: number, input: KartInput, dt: number): number {
  const thr = clamp(input.throttle, 0, 1);
  const brk = clamp(input.brake, 0, 1);
  if (brk > 0 && brk >= thr) {
    if (v > 0) return Math.max(0, v - BRAKE_DECEL * brk * dt);
    const target = -REVERSE_MAX * brk;
    return v > target ? Math.max(target, v - REVERSE_ACCEL * dt) : Math.min(target, v + COAST_DECEL * dt);
  }
  if (v < 0) {
    if (thr === 0) return Math.min(0, v + COAST_DECEL * dt);
    v = Math.min(0, v + BRAKE_DECEL * thr * dt);
    if (v < 0) return v;
  }
  if (v > top) return Math.max(top, v - OVERSPEED_DECEL * dt);
  const target = thr * top;
  if (v < target) {
    const x = v / top;
    return Math.min(target, v + accel * Math.max(MIN_ACCEL_FRAC, 1 - x * x) * dt);
  }
  return Math.max(target, v - COAST_DECEL * dt);
}
