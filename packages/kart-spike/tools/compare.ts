// Runs the scenario catalogue on the Rapier kart and prints it next to the reference numbers.
//   node --experimental-strip-types tools/compare.ts [--hz 60|120] [--wall friction|reference] [--mu 0.3]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCatalog } from "../src/catalog.ts";
import { FIXTURES, loadReference, loadTracks, makeRapierFactory } from "../src/run.ts";
import type { Tuning } from "../src/kartSim.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const hz = Number(arg("--hz", "60"));
const tuning: Partial<Tuning> = { wallModel: arg("--wall", "friction") as Tuning["wallModel"] };
if (arg("--mu", "")) tuning.wallFriction = Number(arg("--mu", "0.3"));
const quiet = args.includes("--quiet");

const ref = loadReference();
const tracks = loadTracks();
const make = await makeRapierFactory(tracks, ref.phys, hz, tuning);
const res = runCatalog((sc) => make(sc), tracks, ref.phys.topSpeed);
writeFileSync(join(FIXTURES, `rapier-${hz}-${tuning.wallModel}.json`), JSON.stringify({ sim: "rapier", tickHz: hz, tuning, ...res }, null, 1));

const f = (v: unknown): string => (typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(3) : "n/a") : v === null ? "n/a" : String(v));
if (!quiet) {
  console.log(`reference ${ref.tickHz} Hz vs rapier ${hz} Hz  (wall=${tuning.wallModel})`);
  for (const id of Object.keys(ref.metrics)) {
    const a = ref.metrics[id] as Record<string, unknown>;
    const b = res.metrics[id] as Record<string, unknown>;
    console.log(`\n== ${id}`);
    for (const k of Object.keys(a)) {
      const av = a[k], bv = b[k];
      if (Array.isArray(av)) {
        console.log(`  ${k.padEnd(18)} ${JSON.stringify((av as number[]).map((x) => +x.toFixed(2)))}  ${JSON.stringify((bv as number[]).map((x) => +x.toFixed(2)))}`);
        continue;
      }
      const d = typeof av === "number" && typeof bv === "number" && av !== 0 ? `  (${(((bv - av) / Math.abs(av)) * 100).toFixed(1)}%)` : "";
      console.log(`  ${k.padEnd(18)} ${f(av).padStart(10)}  ${f(bv).padStart(10)}${d}`);
    }
  }
}
