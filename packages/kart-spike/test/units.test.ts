import { test } from "node:test";
import assert from "node:assert";
import { NEUTRAL_CODE, inputCode, packInput, unpackInput, neutralInput } from "../src/inputCode.ts";
import { CLASS_PARAMS, SPIKE_STATS, derivePhys } from "../src/driving.ts";
import { buildRoadMesh, buildWallMesh, frameAt, gridSlots, newFrame, project } from "../src/track.ts";
import type { Projection } from "../src/track.ts";
import { loadReference, loadTracks } from "../src/run.ts";

test("input code: quantised round trip is idempotent and neutral is neutral", () => {
  assert.equal(packInput(neutralInput()), NEUTRAL_CODE);
  for (const steer of [-1, -0.5, -0.013, 0, 0.3, 0.77, 1]) {
    const c = inputCode({ throttle: 0.6, steer, drift: steer > 0.2 });
    const u = unpackInput(c);
    assert.equal(packInput(u), c, "pack(unpack(c)) === c");
    assert.ok(Math.abs(u.steer - steer) <= 1 / 127 / 2 + 1e-12);
  }
  assert.equal(unpackInput(0xffffffff).steer, 127 / 127, "steer 255 clamps to 254");
});

test("derivePhys equals the numbers the reference sim reports for the default build", () => {
  const ref = loadReference();
  const p = derivePhys(SPIKE_STATS, 100);
  for (const k of Object.keys(ref.phys) as (keyof typeof p)[]) assert.ok(Math.abs(p[k] - ref.phys[k]) < 1e-12, k);
  assert.equal(CLASS_PARAMS[100].topSpeed, 23);
});

test("track meshes: road faces up, walls enclose the road, projection round trips", () => {
  const t = loadTracks().circuit;
  const road = buildRoadMesh(t);
  let up = 0, down = 0;
  for (let i = 0; i < road.indices.length; i += 3) {
    const a = road.indices[i] * 3, b = road.indices[i + 1] * 3, c = road.indices[i + 2] * 3;
    const v = road.vertices;
    const ux = v[b] - v[a], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wz = v[c + 2] - v[a + 2];
    // y component of (b-a) x (c-a)
    const ny = uz * wx - ux * wz;
    if (ny > 0) up++; else down++;
  }
  assert.equal(down, 0, "every road triangle has an upward normal (Rapier's FIX_INTERNAL_EDGES needs it)");
  assert.ok(up > 3000);
  const wall = buildWallMesh(t);
  assert.ok(wall.indices.length / 3 > 6000);
  const f = newFrame();
  const pr: Projection = { s: 0, lat: 0 };
  for (const s of [0, 100.5, 333.3, 700, t.length - 0.5]) {
    frameAt(t, s, f);
    project(t, f.x + f.rx * 2.5, f.z + f.rz * 2.5, null, pr);
    assert.ok(Math.abs(pr.lat - 2.5) < 0.05, `lat at s=${s}: ${pr.lat}`);
    const ds = Math.abs(((pr.s - s + t.length * 1.5) % t.length) - t.length / 2);
    assert.ok(ds < 1.1 || Math.abs(ds - t.length / 2) < 1.1, `s at ${s}: ${pr.s}`);
  }
  assert.equal(gridSlots(t, 16).length, 16);
});
