// Rollback cost of the Rapier kart: ms per tick, snapshot, restore, hash, 8-tick rollback, snapshot size,
// for 4/8/16 karts on the trimesh circuit (and on a flat cuboid ground as the "no mesh" baseline).
//   node --experimental-strip-types tools/bench.ts [--json]
import { initRapier, fnv1a32 } from "@gamesaloon/rollback-rapier";
import { KartRapierSim } from "../src/kartSim.ts";
import { ChaosBots, recordRun } from "../src/harness.ts";
import { loadReference, loadTracks } from "../src/run.ts";
import { gridSlots } from "../src/track.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES } from "../src/run.ts";

const R = await initRapier();
const tracks = loadTracks();
const ref = loadReference();
const track = tracks.circuit;

interface Row { karts: number; ground: string; step: number; snapshot: number; restore: number; fnv: number; tickSave: number; rollback8: number; bytes: number; ccd: boolean }

const now = (): number => performance.now();

function bench(n: number, trackMode: "trimesh" | "flat", ccd = true): Row {
  const make = (): KartRapierSim => new KartRapierSim(R, { track, slots: gridSlots(track, n), dt: 1 / 60, phys: ref.phys, tuning: { trackMode, ccd } });
  const sim = make();
  const bots = new ChaosBots(n, track, ref.phys.topSpeed, 21);
  recordRun(sim, bots, 400); // warm up (JIT, karts moving, some contacts)
  // steady-state step cost, bots excluded from the timing
  const codesFor: number[][] = [];
  let tStep = 0;
  const STEPS = 600;
  for (let k = 0; k < STEPS; k++) {
    const codes = bots.next(sim);
    codesFor.push(codes);
    const t0 = now();
    sim.step(codes);
    tStep += now() - t0;
  }
  const REP = 200;
  let t0 = now();
  let snap = sim.takeSnapshot();
  for (let i = 0; i < REP; i++) snap = sim.takeSnapshot();
  const tSnap = (now() - t0) / REP;
  t0 = now();
  for (let i = 0; i < REP; i++) sim.restoreSnapshot(snap);
  const tRestore = (now() - t0) / REP;
  t0 = now();
  let h = 0;
  for (let i = 0; i < REP; i++) h ^= fnv1a32(snap);
  const tFnv = (now() - t0) / REP;
  void h;
  // 8-tick rollback = restore + 8 x (step + snapshot), the frame a late input costs
  const hist = codesFor.slice(-8);
  const base = sim.takeSnapshot();
  const R8 = 60;
  t0 = now();
  for (let i = 0; i < R8; i++) {
    sim.restoreSnapshot(base);
    for (let k = 0; k < 8; k++) { sim.step(hist[k]); sim.takeSnapshot(); }
  }
  const tRoll = (now() - t0) / R8;
  // steady state if you snapshot every tick
  t0 = now();
  const TS = 300;
  for (let i = 0; i < TS; i++) { sim.step(codesFor[i % codesFor.length]); sim.takeSnapshot(); }
  const tTickSave = (now() - t0) / TS;
  const row: Row = { karts: n, ground: trackMode, step: tStep / STEPS, snapshot: tSnap, restore: tRestore, fnv: tFnv, tickSave: tTickSave, rollback8: tRoll, bytes: snap.length, ccd };
  sim.free();
  return row;
}

const rows: Row[] = [];
for (const mode of ["trimesh", "flat"] as const) {
  for (const n of [4, 8, 16]) {
    // best of 3 to cut noise
    let best: Row | null = null;
    for (let r = 0; r < 3; r++) {
      const row = bench(n, mode);
      if (!best || row.rollback8 < best.rollback8) best = row;
    }
    rows.push(best!);
  }
}
// CCD cost on the trimesh track
for (const n of [8, 16]) {
  let best: Row | null = null;
  for (let r = 0; r < 3; r++) { const row = bench(n, "trimesh", false); if (!best || row.rollback8 < best.rollback8) best = row; }
  rows.push(best!);
}

const f2 = (v: number): string => v.toFixed(2);
console.log("| karts | ground | CCD | step | snapshot | restore | fnv1a32 | tick+save | rollback 8 ticks | snapshot size |");
console.log("|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.karts} | ${r.ground} | ${r.ccd ? "on" : "off"} | ${f2(r.step)} | ${f2(r.snapshot)} | ${f2(r.restore)} | ${f2(r.fnv)} | ${f2(r.tickSave)} | ${f2(r.rollback8)} | ${(r.bytes / 1024).toFixed(0)} KB |`);
}
if (process.argv.includes("--json")) writeFileSync(join(FIXTURES, "bench.json"), JSON.stringify(rows, null, 1));
