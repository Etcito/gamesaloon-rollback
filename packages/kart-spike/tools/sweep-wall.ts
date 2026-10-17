// Tuning helper: wall-hit metrics of the Rapier kart for several wall models/parameters next to the reference.
//   node --experimental-strip-types tools/sweep-wall.ts [--hz 60]
import { wallMetrics, runScenario, wallHit } from "../src/scenarios.ts";
import type { WallMetrics } from "../src/scenarios.ts";
import { loadReference, loadTracks, makeRapierFactory } from "../src/run.ts";
import type { Tuning } from "../src/kartSim.ts";

const hz = Number(process.argv[process.argv.indexOf("--hz") + 1] || 120);
const ref = loadReference();
const tracks = loadTracks();
const steers = [0.08, 0.2, 0.5];

const row = (label: string, ms: WallMetrics[]): void => {
  console.log(label.padEnd(34), ms.map((m) => `${m.angleDeg.toFixed(0)}deg vMin ${m.vMin.toFixed(1)} v1s ${m.v1s.toFixed(1)} rec ${m.recover95.toFixed(2)}`).join(" | "));
};

row("reference", steers.map((s) => ref.metrics[`wall${s}`] as unknown as WallMetrics));
const variants: [string, Partial<Tuning>][] = [
  ["rapier reference-law", { wallModel: "reference" }],
  ["rapier friction mu0.3 e0.3", { wallModel: "friction", wallFriction: 0.3, wallRestitution: 0.3 }],
  ["rapier friction mu0.35 e0.3", { wallModel: "friction", wallFriction: 0.35, wallRestitution: 0.3 }],
  ["rapier friction mu0.3 e0.15", { wallModel: "friction", wallFriction: 0.3, wallRestitution: 0.15 }],
  ["rapier friction mu0.3 e0.45", { wallModel: "friction", wallFriction: 0.3, wallRestitution: 0.45 }],
  ["rapier friction mu0.5 e0.3", { wallModel: "friction", wallFriction: 0.5, wallRestitution: 0.3 }],
];
for (const [label, tuning] of variants) {
  const make = await makeRapierFactory(tracks, ref.phys, hz, tuning);
  const ms = steers.map((s) => {
    const sc = wallHit(s, ref.phys.topSpeed);
    return wallMetrics(runScenario(make(sc), sc, tracks.circuit), tracks.circuit);
  });
  row(label, ms);
}
