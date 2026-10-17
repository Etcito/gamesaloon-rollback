// Runs the REFERENCE game's own simulation headless on the spike tracks and writes
//   fixtures/track-circuit.json, fixtures/track-skid.json   (centre-line frames the Rapier side builds meshes from)
//   fixtures/reference.json                                 (metrics + 20 Hz traces of every catalogue scenario)
// The reference checkout is READ-ONLY and is located by the KART_REF_DIR environment variable.
// Usage: KART_REF_DIR=/path/to/reference node --experimental-strip-types tools/ref-run.ts
import "./ref-hooks.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { datan2 } from "../src/detmath.ts";
import { circuitPoints, skidPoints } from "../src/trackdefs.ts";
import type { ControlPointDef } from "../src/trackdefs.ts";
import { packInput, unpackInput, neutralInput, NEUTRAL_CODE } from "../src/inputCode.ts";
import { runCatalog } from "../src/catalog.ts";
import type { Probe, SimDriver, TrackId } from "../src/scenarios.ts";
import type { TrackData } from "../src/track.ts";

const REF = process.env.KART_REF_DIR;
if (!REF) throw new Error("set KART_REF_DIR to the reference game checkout (read-only)");
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
mkdirSync(fixtures, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const imp = (p: string): Promise<any> => import(pathToFileURL(join(REF, "src", p)).href);
const THREE = await import(pathToFileURL(join(REF, "node_modules", "three", "build", "three.module.js")).href);
const { buildTrack } = await imp("track/build.ts");
const { RaceSession } = await imp("sim/race.ts");
const { SIM_SYSTEMS } = await imp("sim/systems.ts");
const { statsOf, DEFAULT_BUILD } = await imp("content/roster.ts");
const { FIXED_DT } = await imp("core/types.ts");

function trackDef(id: string, pts: ControlPointDef[]): unknown {
  return {
    id, name: id, cupId: "spike", index: 0, seed: 1, laps: 3,
    main: { id: "main", points: pts.map((c) => (c.width === undefined ? { p: c.p } : { p: c.p, width: c.width })), closed: true },
    branches: [], zones: [], rails: [], itemRows: [], coins: [], hazards: [],
    biomes: [{ biome: "test", u0: 0, u1: 1 }], startU: 0, songId: "test", ground: "none",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exportTrack(id: string, built: any): TrackData {
  const main = built.main;
  const length: number = main.length;
  const count = Math.ceil(length);
  const step = length / count;
  const out: TrackData = { id, length, count, step, startS: built.startS, pos: [], tan: [], up: [], right: [], width: [], grid: [] };
  const V = THREE.Vector3;
  const frame = { pos: new V(), tangent: new V(), up: new V(), right: new V(), width: 0, s: 0 };
  const samp = (s: number): typeof frame => main.sample(s, frame);
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  for (let i = 0; i < count; i++) {
    const F = samp(i * step);
    out.pos.push(r(F.pos.x), r(F.pos.y), r(F.pos.z));
    out.tan.push(r(F.tangent.x), r(F.tangent.y), r(F.tangent.z));
    out.up.push(r(F.up.x), r(F.up.y), r(F.up.z));
    out.right.push(r(F.right.x), r(F.right.y), r(F.right.z));
    out.width.push(r(F.width));
  }
  for (const g of built.grid) {
    out.grid.push({ pos: [r(g.pos.x), r(g.pos.y), r(g.pos.z)], tan: [r(g.tangent.x), r(g.tangent.y), r(g.tangent.z)], up: [r(g.up.x), r(g.up.y), r(g.up.z)], right: [r(g.right.x), r(g.right.y), r(g.right.z)], width: r(g.width), s: r(g.s) });
  }
  return out;
}

const built: Record<TrackId, unknown> = {
  circuit: buildTrack(trackDef("spike-circuit", circuitPoints())),
  skid: buildTrack(trackDef("spike-skid", skidPoints())),
};
const tracks: Record<TrackId, TrackData> = { circuit: exportTrack("circuit", built.circuit), skid: exportTrack("skid", built.skid) };
writeFileSync(join(fixtures, "track-circuit.json"), JSON.stringify(tracks.circuit));
writeFileSync(join(fixtures, "track-skid.json"), JSON.stringify(tracks.skid));

// Physics + the two mechanics the Rapier kart re-implements (drift, boost). Slipstream, tricks, glide, rails,
// coins, items and hazards are game mechanics above the physics layer and are left out of the comparison.
const KEEP = new Set(["modsReset", "physics", "kartCollisions", "progress", "drift", "boost"]);

class RefDriver implements SimDriver {
  readonly dt: number = FIXED_DT;
  codes: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  race: any;
  readonly kartCount: number;
  constructor(kartCount: number, track: unknown) {
    this.kartCount = kartCount;
    this.codes = new Array(kartCount).fill(NEUTRAL_CODE);
    const racers = [];
    for (let i = 0; i < kartCount; i++) racers.push({ name: "k" + i, build: { ...DEFAULT_BUILD }, controller: "bot", color: 0 });
    const setup = { trackId: "spike", cc: 100, racers, mode: "timeTrial", laps: 3, seed: 1, items: false };
    const self = this;
    this.race = new RaceSession(setup, track, {
      systems: SIM_SYSTEMS().filter((sy: { id: string }) => KEEP.has(sy.id)),
      statsOf,
      controllers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bot: (_race: any, kart: any) => {
          const inp = neutralInput();
          return { update: () => unpackInput(self.codes[kart.index], inp) };
        },
      },
    });
    while (this.race.phase !== "racing") this.race.step(FIXED_DT);
  }
  step(codes: number[]): void {
    this.codes = codes;
    this.race.step(FIXED_DT);
  }
  probe(i: number, p: Probe): void {
    const k = this.race.karts[i];
    const q = k.quat;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    p.x = k.pos.x; p.y = k.pos.y; p.z = k.pos.z;
    p.fx = fx; p.fz = fz; p.yaw = datan2(fx, fz);
    p.speed = k.speed;
    p.vx = k.vel.x; p.vy = k.vel.y; p.vz = k.vel.z;
    p.driftStage = k.drift.stage; p.driftActive = k.drift.active; p.boostTime = k.boost.time;
  }
}

// Make sure the quantiser used by the scenarios is the one the reference ships (self check).
{
  const probe = unpackInput(packInput({ ...neutralInput(), throttle: 0.5, steer: -0.3, drift: true }));
  if (Math.abs(probe.steer - -0.2992) > 1e-3) throw new Error("input codec mismatch");
}

const probeKart = new RefDriver(1, built.circuit).race.karts[0];
const phys = { ...probeKart.phys };
const top = phys.topSpeed as number;
const result = runCatalog((sc) => new RefDriver(sc.karts, built[sc.track]), tracks, top);
writeFileSync(join(fixtures, "reference.json"), JSON.stringify({ sim: "reference", tickHz: Math.round(1 / FIXED_DT), phys, stats: probeKart.stats, ...result }, null, 1));
console.log("reference phys", phys);
console.log(JSON.stringify(result.metrics, null, 1));
