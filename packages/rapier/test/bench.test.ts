import { test } from "node:test";
import { buildScenario, getR, run } from "./scenario.ts";
import { fnv1a32 } from "../src/index.ts";

const R = await getR();
const now = () => performance.now();

function avg(fn: () => void, iters: number): number {
  for (let i = 0; i < Math.min(10, iters); i++) fn(); // warm-up
  const t0 = now();
  for (let i = 0; i < iters; i++) fn();
  return (now() - t0) / iters;
}

test("(c)+(d) cost and size per snapshot / restore / step", () => {
  const rows: Record<string, string | number>[] = [];
  for (const [n, canSleep] of [[50, true], [200, true], [1000, true], [50, false], [200, false], [1000, false]] as [number, boolean][]) {
    const s = buildScenario(R, n, 1234, canSleep);
    run(s, 180); // bodies landed, many in contact
    const snap = s.sim.takeSnapshot();
    const step = avg(() => s.sim.step(), 200);
    const take = avg(() => { s.sim.takeSnapshot(); }, 100);
    const restore = avg(() => s.sim.restoreSnapshot(snap), 100);
    const hashOnly = avg(() => { fnv1a32(snap); }, 100);
    const hash = avg(() => { s.sim.hash(); }, 100);

    // a realistic rollback frame: 8 ticks resimulated, each followed by a snapshot save
    const rollback8 = avg(() => {
      s.sim.restoreSnapshot(snap);
      for (let i = 0; i < 8; i++) { s.sim.step(); s.sim.takeSnapshot(); }
    }, 30);
    // steady state tick cost: step + save snapshot (done every tick to have any tick to roll back to)
    const tickSave = avg(() => { s.sim.step(); s.sim.takeSnapshot(); }, 100);

    rows.push({
      bodies: n, sleep: canSleep ? "yes" : "never",
      "step ms": +step.toFixed(3),
      "snapshot ms": +take.toFixed(3),
      "restore ms": +restore.toFixed(3),
      "fnv1a32 ms": +hashOnly.toFixed(3),
      "hash() ms": +hash.toFixed(3),
      "tick+save ms": +tickSave.toFixed(3),
      "rollback 8 ticks ms": +rollback8.toFixed(2),
      "snapshot bytes": snap.length,
      "bytes/body": Math.round(snap.length / n),
    });
    s.sim.free();
  }
  console.table(rows);
  console.log("BENCH_JSON " + JSON.stringify(rows));
});
