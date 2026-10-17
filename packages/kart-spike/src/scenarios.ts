// Scripted scenarios and metrics shared by BOTH simulations. A scenario is a pure function
// (time, probes of every kart) -> input codes, so the reference sim and the Rapier sim receive the same
// quantised inputs; the runner only talks to the SimDriver interface. Time is measured from GO.
import { datan2 } from "./detmath.ts";
import { clamp } from "./mathx.ts";
import { inputCode, neutralInput, packInput } from "./inputCode.ts";
import type { KartInput } from "./inputCode.ts";
import { curvature, frameAt, newFrame, project } from "./track.ts";
import type { Projection, TrackData } from "./track.ts";

export interface Probe {
  x: number; y: number; z: number;
  /** Heading (rad) = datan2(fx, fz). */
  yaw: number;
  fx: number; fz: number;
  /** Signed forward speed. */
  speed: number;
  vx: number; vy: number; vz: number;
  /** Centre line projection, filled by the runner. */
  s: number; lat: number;
  driftStage: number; driftActive: boolean; boostTime: number;
}

export function newProbe(): Probe {
  return { x: 0, y: 0, z: 0, yaw: 0, fx: 0, fz: 1, speed: 0, vx: 0, vy: 0, vz: 0, s: 0, lat: 0, driftStage: 0, driftActive: false, boostTime: 0 };
}

export interface SimDriver {
  readonly dt: number;
  readonly kartCount: number;
  /** Advance one tick with one input code per kart. */
  step(codes: number[]): void;
  /** Fill p with the state of kart i (s/lat are filled by the runner). */
  probe(i: number, p: Probe): void;
}

export interface Trace {
  dt: number;
  /** Per kart, per tick (index 0 = state at GO). */
  t: number[];
  x: number[][]; z: number[][]; yaw: number[][]; speed: number[][]; s: number[][]; lat: number[][];
  stage: number[][]; boost: number[][];
}

export type TrackId = "circuit" | "skid";

export interface Scenario {
  id: string;
  track: TrackId;
  karts: number;
  duration: number;
  control(t: number, probes: Probe[], track: TrackData): number[];
  /** Optional early stop. */
  done?(t: number, probes: Probe[]): boolean;
}

/** Runs a scenario against a driver that is already at GO (karts on their slots, race phase racing). */
export function runScenario(driver: SimDriver, sc: Scenario, track: TrackData): Trace {
  const n = driver.kartCount;
  const probes: Probe[] = [];
  const proj: Projection = { s: 0, lat: 0 };
  const hint: (number | null)[] = [];
  for (let i = 0; i < n; i++) { probes.push(newProbe()); hint.push(null); }
  const tr: Trace = { dt: driver.dt, t: [], x: [], z: [], yaw: [], speed: [], s: [], lat: [], stage: [], boost: [] };
  for (let i = 0; i < n; i++) { tr.x.push([]); tr.z.push([]); tr.yaw.push([]); tr.speed.push([]); tr.s.push([]); tr.lat.push([]); tr.stage.push([]); tr.boost.push([]); }
  const ticks = Math.round(sc.duration / driver.dt);
  const refresh = (k: number): void => {
    for (let i = 0; i < n; i++) {
      const p = probes[i];
      driver.probe(i, p);
      project(track, p.x, p.z, hint[i], proj, 30);
      hint[i] = proj.s;
      p.s = proj.s; p.lat = proj.lat;
      tr.x[i].push(p.x); tr.z[i].push(p.z); tr.yaw[i].push(p.yaw); tr.speed[i].push(p.speed);
      tr.s[i].push(p.s); tr.lat[i].push(p.lat); tr.stage[i].push(p.driftStage); tr.boost[i].push(p.boostTime);
    }
    tr.t.push(k * driver.dt);
  };
  refresh(0);
  for (let k = 0; k < ticks; k++) {
    const t = k * driver.dt;
    driver.step(sc.control(t, probes, track));
    refresh(k + 1);
    if (sc.done && sc.done((k + 1) * driver.dt, probes)) break;
  }
  return tr;
}

const T_EPS = 1e-9;

// ---------------------------------------------------------------------------------------------
// Bot: waypoint follower (port of the reference bot, same constants). Pure function of the probe.

const MIN_LOOKAHEAD = 12;
const LOOKAHEAD_TIME = 0.5;
const STEER_GAIN = 2.5;
const SLOW_THROTTLE = 0.6;
const SHARP_CURVATURE = 0.033;
const FAST_FRAC = 0.75;
const CURVE_PROBES = [0.5, 1, 1.5, 2];
const _bf = newFrame();

export function botInput(p: Probe, track: TrackData, topSpeed: number, lat = 0, out: KartInput = neutralInput()): KartInput {
  const ahead = Math.max(MIN_LOOKAHEAD, Math.abs(p.speed) * LOOKAHEAD_TIME);
  const F = frameAt(track, p.s + ahead, _bf);
  const tx = F.x + F.rx * lat - p.x, tz = F.z + F.rz * lat - p.z;
  // kart right = (-fz, fx) in the xz plane (heading +Z => right = -X)
  const steer = clamp(datan2(tx * -p.fz + tz * p.fx, tx * p.fx + tz * p.fz) * STEER_GAIN, -1, 1);
  let sharp = false;
  if (p.speed > FAST_FRAC * topSpeed) for (const c of CURVE_PROBES) if (curvature(track, p.s + ahead * c) > SHARP_CURVATURE) sharp = true;
  out.throttle = sharp ? SLOW_THROTTLE : 1;
  out.brake = 0;
  out.steer = Number.isFinite(steer) ? steer : 0;
  out.drift = false;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scenario catalogue

export const STRAIGHT_S = 12;
export const TURN_PRE = 5;
export const TURN_HOLD = 7;
export const DRIFT_PRE = 5;
export const DRIFT_ON = 3;
export const WALL_PRE = 4;
export const WALL_LAT = 7.5;

export function straight(): Scenario {
  const c = inputCode({ throttle: 1 });
  return { id: "straight", track: "circuit", karts: 1, duration: STRAIGHT_S, control: () => [c] };
}

export function steadyTurn(steer: number): Scenario {
  const a = inputCode({ throttle: 1 });
  const b = inputCode({ throttle: 1, steer });
  return { id: `turn${steer >= 0 ? "R" : "L"}${Math.abs(steer)}`, track: "skid", karts: 1, duration: TURN_PRE + TURN_HOLD, control: (t) => [t < TURN_PRE - T_EPS ? a : b] };
}

export function driftScenario(steer = 0.8): Scenario {
  const a = inputCode({ throttle: 1 });
  const b = inputCode({ throttle: 1, steer, drift: true });
  const c = inputCode({ throttle: 1 });
  return {
    id: `drift${steer}`, track: "skid", karts: 1, duration: DRIFT_PRE + DRIFT_ON + 4,
    control: (t) => [t < DRIFT_PRE - T_EPS ? a : t < DRIFT_PRE + DRIFT_ON - T_EPS ? b : c],
  };
}

/** Straight for 4 s, then hold `steer` towards the right wall until contact, then the bot steers back to the line. */
export function wallHit(steer: number, topSpeed: number): Scenario {
  const a = inputCode({ throttle: 1 });
  const b = inputCode({ throttle: 1, steer });
  const inp = neutralInput();
  let hit = false;
  return {
    id: `wall${steer}`, track: "circuit", karts: 1, duration: 14,
    control: (t, pr, track) => {
      if (pr[0].lat >= WALL_LAT) hit = true;
      if (hit) return [packInput(botInput(pr[0], track, topSpeed, 0, inp))]; // drive away along the centre line
      return [t < WALL_PRE - T_EPS ? a : b];
    },
  };
}

/** Bot laps from the standing start. */
export function lapScenario(topSpeed: number): Scenario {
  const inp = neutralInput();
  return {
    id: "lap", track: "circuit", karts: 1, duration: 150,
    control: (_t, pr, track) => [packInput(botInput(pr[0], track, topSpeed, 0, inp))],
  };
}

/** Kart 0 cruises at half throttle on the centre line, kart 1 (behind, other lane) chases it at full throttle and rear-ends it. */
export function bumpScenario(topSpeed: number): Scenario {
  const i0 = neutralInput();
  const i1 = neutralInput();
  return {
    id: "bump", track: "circuit", karts: 2, duration: 8,
    control: (_t, pr, track) => {
      botInput(pr[0], track, topSpeed, 0, i0); i0.throttle = 0.5;
      botInput(pr[1], track, topSpeed, 0, i1); i1.throttle = 1;
      return [packInput(i0), packInput(i1)];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Metrics

function lerpAt(ts: number[], vs: number[], t: number): number {
  if (t <= ts[0]) return vs[0];
  const dt = ts[1] - ts[0];
  const f = t / dt;
  const i = Math.min(vs.length - 2, Math.floor(f));
  const a = f - i;
  return vs[i] * (1 - a) + vs[i + 1] * a;
}

function firstCross(ts: number[], vs: number[], level: number): number {
  for (let i = 1; i < vs.length; i++) {
    if (vs[i] >= level && vs[i - 1] < level) return ts[i - 1] + ((level - vs[i - 1]) / (vs[i] - vs[i - 1])) * (ts[i] - ts[i - 1]);
  }
  return NaN;
}

export function speedAt(tr: Trace, t: number, kart = 0): number { return lerpAt(tr.t, tr.speed[kart], t); }

/** Kasa circle fit; returns radius and centre. */
export function fitCircle(xs: number[], zs: number[]): { r: number; cx: number; cz: number } {
  const n = xs.length;
  let mx = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; mz += zs[i]; }
  mx /= n; mz /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx, v = zs[i] - mz;
    suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det;
  const vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det;
  return { r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n), cx: uc + mx, cz: vc + mz };
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface StraightMetrics { topSpeed: number; t50: number; t90: number; t99: number; v3: number; v6: number; v12: number; dist12: number }
export function straightMetrics(tr: Trace, top: number): StraightMetrics {
  const sp = tr.speed[0];
  let maxV = 0;
  for (const v of sp) maxV = Math.max(maxV, v);
  let d = 0;
  for (let i = 1; i < sp.length; i++) d += 0.5 * (sp[i] + sp[i - 1]) * (tr.t[i] - tr.t[i - 1]);
  return { topSpeed: maxV, t50: firstCross(tr.t, sp, 0.5 * top), t90: firstCross(tr.t, sp, 0.9 * top), t99: firstCross(tr.t, sp, 0.99 * top), v3: speedAt(tr, 3), v6: speedAt(tr, 6), v12: speedAt(tr, 12), dist12: d };
}

export interface TurnMetrics { radius: number; speed: number; yawRate: number }
export function turnMetrics(tr: Trace): TurnMetrics {
  const t1 = tr.t[tr.t.length - 1], t0 = t1 - 3;
  const xs: number[] = [], zs: number[] = [];
  let sp = 0, n = 0;
  for (let i = 0; i < tr.t.length; i++) if (tr.t[i] >= t0) { xs.push(tr.x[0][i]); zs.push(tr.z[0][i]); sp += tr.speed[0][i]; n++; }
  const i0 = tr.t.findIndex((t) => t >= t0);
  let dy = 0;
  for (let i = i0 + 1; i < tr.t.length; i++) dy += angDiff(tr.yaw[0][i], tr.yaw[0][i - 1]);
  return { radius: fitCircle(xs, zs).r, speed: sp / n, yawRate: Math.abs(dy) / (t1 - tr.t[i0]) };
}

export interface DriftMetrics { yawRate: number; slipDeg: number; speedMean: number; speedBeforeRelease: number; peakAfter: number; gainAfter: number; radius: number; stageFinal: number; boostSeen: boolean }
export function driftMetrics(tr: Trace): DriftMetrics {
  const a = DRIFT_PRE + 0.6, b = DRIFT_PRE + DRIFT_ON;
  let n = 0, yawSum = 0, slip = 0, sp = 0;
  const xs: number[] = [], zs: number[] = [];
  let peak = 0, stage = 0, boost = false;
  for (let i = 1; i < tr.t.length; i++) {
    const t = tr.t[i];
    if (t >= a && t <= b) {
      yawSum += Math.abs(angDiff(tr.yaw[0][i], tr.yaw[0][i - 1])) / (tr.t[i] - tr.t[i - 1]);
      sp += tr.speed[0][i];
      xs.push(tr.x[0][i]); zs.push(tr.z[0][i]);
      n++;
      const vx = tr.x[0][i] - tr.x[0][i - 1], vz = tr.z[0][i] - tr.z[0][i - 1];
      if (vx * vx + vz * vz > 1e-9) slip += Math.abs(angDiff(datan2(vx, vz), tr.yaw[0][i]));
    }
    if (t <= b + 1e-9) stage = Math.max(stage, tr.stage[0][i]);
    if (t > b) { peak = Math.max(peak, tr.speed[0][i]); if (tr.boost[0][i] > 0) boost = true; }
  }
  const before = speedAt(tr, b - 0.01);
  return { yawRate: yawSum / n, slipDeg: (slip / n) * 180 / Math.PI, speedMean: sp / n, speedBeforeRelease: before, peakAfter: peak, gainAfter: peak - before, radius: fitCircle(xs, zs).r, stageFinal: stage, boostSeen: boost };
}

export interface WallMetrics { hit: boolean; tHit: number; angleDeg: number; vPre: number; vMin: number; v1s: number; keep1s: number; recover95: number }
export function wallMetrics(tr: Trace, track: TrackData): WallMetrics {
  const lat = tr.lat[0];
  const ih = lat.findIndex((l, i) => i > 0 && l >= WALL_LAT);
  if (ih < 0) return { hit: false, tHit: NaN, angleDeg: NaN, vPre: NaN, vMin: NaN, v1s: NaN, keep1s: NaN, recover95: NaN };
  const f = frameAt(track, tr.s[0][ih], newFrame());
  const hx = Math.sin(tr.yaw[0][ih]), hz = Math.cos(tr.yaw[0][ih]);
  const angle = Math.abs(datan2(f.tx * hz - f.tz * hx, f.tx * hx + f.tz * hz));
  const tHit = tr.t[ih];
  const vPre = speedAt(tr, tHit - 0.05);
  let vMin = Infinity;
  for (let i = ih; i < tr.t.length && tr.t[i] <= tHit + 1; i++) vMin = Math.min(vMin, tr.speed[0][i]);
  const v1s = speedAt(tr, tHit + 1);
  let rec = NaN;
  for (let i = ih; i < tr.t.length; i++) if (tr.speed[0][i] >= 0.95 * vPre && tr.t[i] > tHit + 0.05) { rec = tr.t[i] - tHit; break; }
  return { hit: true, tHit, angleDeg: (angle * 180) / Math.PI, vPre, vMin, v1s, keep1s: v1s / vPre, recover95: rec };
}

export interface LapMetrics { laps: number[]; total: number; firstCross: number }
/** Lap times from unwrapped centre-line progress: lap k = time between crossings of the start line (s = 0). */
export function lapMetrics(tr: Trace, track: TrackData, want = 3): LapMetrics {
  const L = track.length;
  const s = tr.s[0];
  let cum = s[0] > L / 2 ? s[0] - L : s[0]; // slots sit just behind the line
  const crossings: number[] = [];
  let prev = s[0];
  let target = 0;
  for (let i = 1; i < s.length; i++) {
    let d = s[i] - prev;
    if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
    cum += d;
    prev = s[i];
    while (cum >= target) { crossings.push(tr.t[i]); target += L; }
  }
  const laps: number[] = [];
  for (let i = 1; i < crossings.length; i++) laps.push(crossings[i] - crossings[i - 1]);
  return { laps: laps.slice(0, want - 1), total: crossings.length >= want ? crossings[want - 1] : NaN, firstCross: crossings[0] ?? NaN };
}

export interface BumpMetrics { contact: boolean; tContact: number; vApproach: number; vA0: number; vB0: number; vA1: number; vB1: number }
export function bumpMetrics(tr: Trace): BumpMetrics {
  let ic = -1;
  for (let i = 0; i < tr.t.length; i++) {
    const d = Math.hypot(tr.x[0][i] - tr.x[1][i], tr.z[0][i] - tr.z[1][i]);
    if (d < 2.3) { ic = i; break; }
  }
  if (ic < 0) return { contact: false, tContact: NaN, vApproach: NaN, vA0: NaN, vB0: NaN, vA1: NaN, vB1: NaN };
  const t = tr.t[ic];
  return { contact: true, tContact: t, vApproach: speedAt(tr, t - 0.05, 1), vA0: speedAt(tr, t - 0.05, 0), vB0: speedAt(tr, t - 0.05, 1), vA1: speedAt(tr, t + 0.4, 0), vB1: speedAt(tr, t + 0.4, 1) };
}

/** Downsample a trace to a given rate for storage. */
export function downsample(tr: Trace, hz: number, kart = 0): { t: number[]; speed: number[]; x: number[]; z: number[]; yaw: number[] } {
  const stride = Math.max(1, Math.round(1 / tr.dt / hz));
  const o = { t: [] as number[], speed: [] as number[], x: [] as number[], z: [] as number[], yaw: [] as number[] };
  for (let i = 0; i < tr.t.length; i += stride) {
    o.t.push(+tr.t[i].toFixed(4)); o.speed.push(+tr.speed[kart][i].toFixed(4)); o.x.push(+tr.x[kart][i].toFixed(3)); o.z.push(+tr.z[kart][i].toFixed(3)); o.yaw.push(+tr.yaw[kart][i].toFixed(4));
  }
  return o;
}
