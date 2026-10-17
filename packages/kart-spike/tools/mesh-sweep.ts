// How much of the rollback cost is the static trimesh, and how far can it be reduced without hurting the
// kart? Sweeps mesh resolution / flags and prints size, timing and behaviour checks (8 karts, 60 Hz).
//   node --experimental-strip-types tools/mesh-sweep.ts
import { initRapier } from "@gamesaloon/rollback-rapier";
import { KartRapierSim } from "../src/kartSim.ts";
import type { Tuning } from "../src/kartSim.ts";
import { DEFAULT_MESH, buildRoadMesh, buildWallMesh, gridSlots } from "../src/track.ts";
import type { MeshOptions } from "../src/track.ts";
import { ChaosBots, recordRun } from "../src/harness.ts";
import { lapMetrics, lapScenario, runScenario, wallHit, wallMetrics } from "../src/scenarios.ts";
import { loadReference, loadTracks } from "../src/run.ts";

const R = await initRapier();
const tracks = loadTracks();
const ref = loadReference();
const track = tracks.circuit;
const now = (): number => performance.now();

const variants: [string, Partial<Tuning>][] = [
  ["default: stride2, 5 cols, closed wall, fix-edges", {}],
  ["no FIX_INTERNAL_EDGES", { fixInternalEdges: false }],
  ["3 road columns", { mesh: { ...DEFAULT_MESH, roadColumns: [-1, 0, 1] } }],
  ["2 road columns", { mesh: { ...DEFAULT_MESH, roadColumns: [-1, 1] } }],
  ["2 cols + inner-face wall only", { mesh: { ...DEFAULT_MESH, roadColumns: [-1, 1], wallFaces: "inner" } }],
  ["stride 4, 2 cols, inner wall", { mesh: { ...DEFAULT_MESH, roadColumns: [-1, 1], wallFaces: "inner", rowStride: 4 } }],
  ["stride 8, 2 cols, inner wall", { mesh: { ...DEFAULT_MESH, roadColumns: [-1, 1], wallFaces: "inner", rowStride: 8 } }],
  ["stride 4, 2 cols, inner wall, no fix-edges", { fixInternalEdges: false, mesh: { ...DEFAULT_MESH, roadColumns: [-1, 1], wallFaces: "inner", rowStride: 4 } }],
];

console.log("| mesh | triangles | snapshot size | snapshot ms | step ms | rollback 8 ms | lap 2 (ref 41.68) | wall25deg kept (ref 0.70) | chaos run |");
console.log("|:--|---:|---:|---:|---:|---:|---:|---:|:--|");
for (const [label, tuning] of variants) {
  const mesh: MeshOptions = { ...DEFAULT_MESH, ...(tuning.mesh ?? {}) };
  const tris = (buildRoadMesh(track, mesh).indices.length + buildWallMesh(track, mesh).indices.length) / 3;
  const make = (n: number): KartRapierSim => new KartRapierSim(R, { track, slots: gridSlots(track, n), dt: 1 / 60, phys: ref.phys, tuning });
  // cost, 8 karts
  const sim = make(8);
  const bots = new ChaosBots(8, track, ref.phys.topSpeed, 21);
  recordRun(sim, bots, 400);
  const codes: number[][] = [];
  let tStep = 0;
  for (let k = 0; k < 400; k++) { const c = bots.next(sim); codes.push(c); const t0 = now(); sim.step(c); tStep += now() - t0; }
  let snap = sim.takeSnapshot();
  let t0 = now();
  for (let i = 0; i < 100; i++) snap = sim.takeSnapshot();
  const tSnap = (now() - t0) / 100;
  const hist = codes.slice(-8);
  t0 = now();
  for (let i = 0; i < 40; i++) { sim.restoreSnapshot(snap); for (let k = 0; k < 8; k++) { sim.step(hist[k]); sim.takeSnapshot(); } }
  const tRoll = (now() - t0) / 40;
  sim.free();
  // behaviour
  const lapSc = lapScenario(ref.phys.topSpeed);
  const lap = lapMetrics(runScenario(make(1), lapSc, track), track, 3);
  const wallSc = wallHit(0.2, ref.phys.topSpeed);
  const wm = wallMetrics(runScenario(make(1), wallSc, track), track);
  // 8 chaotic karts for 3000 ticks: nobody may fall through or leave the walls
  const cs = make(8);
  const cb = new ChaosBots(8, track, ref.phys.topSpeed, 33);
  let worstY = 9, worstLat = 0;
  recordRun(cs, cb, 3000, () => {
    for (let i = 0; i < 8; i++) {
      const y = cs.sim.body(cs.ids[i]).translation().y;
      if (y < worstY) worstY = y;
      worstLat = Math.max(worstLat, Math.abs(cb.probes[i].lat));
    }
  });
  cs.free();
  const ok = worstY > 0.1 && worstLat < 9;
  console.log(`| ${label} | ${tris} | ${(snap.length / 1024).toFixed(0)} KB | ${tSnap.toFixed(2)} | ${(tStep / 400).toFixed(2)} | ${tRoll.toFixed(2)} | ${lap.laps[0]?.toFixed(2)} | ${wm.keep1s.toFixed(2)} | ${ok ? "ok" : "ESCAPED"} (min y ${worstY.toFixed(2)}, max |lat| ${worstLat.toFixed(1)}) |`);
}
