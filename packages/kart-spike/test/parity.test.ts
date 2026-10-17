// Rapier kart vs the reference simulation (numbers captured in fixtures/reference.json by tools/ref-run.ts).
// The handling model is the same code, so straight/turn/drift/lap must match tightly; wall and bump
// responses come out of Rapier's solver and match within the documented tolerance.
import { test } from "node:test";
import assert from "node:assert";
import { runCatalog } from "../src/catalog.ts";
import { loadReference, loadTracks, makeRapierFactory } from "../src/run.ts";

type M = Record<string, number | boolean | number[]>;
const ref = loadReference();
const tracks = loadTracks();

function near(label: string, a: number, b: number, relTol: number, absTol = 0): void {
  const ok = Math.abs(a - b) <= Math.max(absTol, relTol * Math.abs(b));
  assert.ok(ok, `${label}: rapier ${a} vs reference ${b} (tol ${relTol * 100}% / ${absTol})`);
}

for (const hz of [120, 60]) {
  test(`parity at ${hz} Hz`, async () => {
    const make = await makeRapierFactory(tracks, ref.phys, hz);
    const res = runCatalog((sc) => make(sc), tracks, ref.phys.topSpeed);
    const m = res.metrics as Record<string, M>;
    const r = ref.metrics as Record<string, M>;
    const num = (o: M, k: string): number => o[k] as number;

    // straight line
    near("top speed", num(m.straight, "topSpeed"), num(r.straight, "topSpeed"), 0.005);
    near("t50", num(m.straight, "t50"), num(r.straight, "t50"), 0.03);
    near("t90", num(m.straight, "t90"), num(r.straight, "t90"), 0.01);
    near("dist12", num(m.straight, "dist12"), num(r.straight, "dist12"), 0.01);
    // steady turns
    for (const id of ["turnR1", "turnR0.5", "turnL1"]) {
      near(id + " radius", num(m[id], "radius"), num(r[id], "radius"), 0.01);
      near(id + " speed", num(m[id], "speed"), num(r[id], "speed"), 0.01);
    }
    // drift + mini turbo
    near("drift yaw rate", num(m["drift0.8"], "yawRate"), num(r["drift0.8"], "yawRate"), 0.01);
    near("drift slip", num(m["drift0.8"], "slipDeg"), num(r["drift0.8"], "slipDeg"), 0.04);
    near("drift peak after boost", num(m["drift0.8"], "peakAfter"), num(r["drift0.8"], "peakAfter"), 0.01);
    assert.equal(m["drift0.8"].stageFinal, r["drift0.8"].stageFinal);
    // lap time with the waypoint bot (this is the headline number)
    const lm = m.lap.laps as number[], lr = r.lap.laps as number[];
    near("lap 2", lm[0], lr[0], 0.01);
    near("lap 3", lm[1], lr[1], 0.01);
    near("3 lap total", num(m.lap, "total"), num(r.lap, "total"), 0.01);
    // wall: same impact angle, retained speed within 30 % (it is Rapier's friction/restitution, not the reference rule)
    for (const id of ["wall0.08", "wall0.2", "wall0.5"]) {
      assert.ok(Math.abs(num(m[id], "angleDeg") - num(r[id], "angleDeg")) < 1.5, id + " impact angle");
      near(id + " speed kept after 1 s", num(m[id], "keep1s"), num(r[id], "keep1s"), 0.30);
    }
    // kart-kart rear end
    assert.ok(m.bump.contact);
    near("bump leader speed after", num(m.bump, "vA1"), num(r.bump, "vA1"), 0.05);
    near("bump chaser speed after", num(m.bump, "vB1"), num(r.bump, "vB1"), 0.05);
  });
}
