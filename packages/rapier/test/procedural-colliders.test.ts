import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { getR } from "./scenario.ts";
import {
  ProceduralColliderSet,
  RapierWorldSim,
  validateProceduralColliders,
} from "../src/index.ts";
import type { ProceduralCollider } from "../src/index.ts";

const R = await getR();

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/procedural-colliders.json", import.meta.url), "utf8"),
) as unknown;
const validated = validateProceduralColliders(fixture);
if (!validated.ok) {
  throw new Error(`fixture invalid at ${validated.error.path}: ${validated.error.message}`);
}
const COLLIDERS: ProceduralCollider[] = validated.colliders;

const PLACEMENT = {
  t: [1, 0, -2] as [number, number, number],
  r: [0, 0.258819045, 0, 0.965925826] as [number, number, number, number],
};

function rotate(
  q: readonly [number, number, number, number],
  v: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function expectRefusal(input: unknown, path: string): void {
  const result = validateProceduralColliders(input);
  if (result.ok) assert.fail(`expected a refusal for ${JSON.stringify(input)}`);
  assert.equal(result.error.path, path);
}

const CUBOID = COLLIDERS.find((c) => c.shape === "cuboid" && c.fitted !== true)!;
const HULL = COLLIDERS.find((c) => c.shape === "convexHull")!;

test("(a) two independent worlds: identical snapshot after 120 ticks", () => {
  const build = () => {
    const sim = new RapierWorldSim(R);
    new ProceduralColliderSet(sim, R, COLLIDERS, { placement: PLACEMENT });
    const target = COLLIDERS.find((c) => c.shape === "capsule")!;
    const p = rotate(PLACEMENT.r, target.t);
    sim.createBody(
      R.RigidBodyDesc.dynamic().setTranslation(
        PLACEMENT.t[0] + p[0],
        4,
        PLACEMENT.t[2] + p[2],
      ),
      [R.ColliderDesc.ball(0.3)],
    );
    return sim;
  };
  const A = build();
  const B = build();
  for (let i = 0; i < 120; i++) {
    A.step();
    B.step();
  }
  assert.deepEqual(A.takeSnapshot(), B.takeSnapshot());
  assert.equal(A.hash(), B.hash());
  A.free();
  B.free();
});

test("(b) set layout: handles, entity ids and dispose", () => {
  const sim = new RapierWorldSim(R);
  const set = new ProceduralColliderSet(sim, R, COLLIDERS, { baseId: 1000 });
  assert.equal(set.handles.length, COLLIDERS.length);
  assert.equal(set.entityIds.length, COLLIDERS.length);
  for (let i = 0; i < COLLIDERS.length; i++) {
    assert.equal(set.entityIds[i], (1000 + COLLIDERS[i].key) >>> 0);
  }
  assert.equal(sim.hasBody(set.body), true);
  set.dispose();
  assert.equal(sim.hasBody(set.body), false);
  set.dispose();
  assert.equal(sim.hasBody(set.body), false);
  sim.free();
});

test("(c) refusals with the exact path", () => {
  const noShape: Record<string, unknown> = { ...CUBOID };
  delete noShape.shape;
  expectRefusal({ colliders: [noShape] }, "/colliders/0/shape");
  expectRefusal({ colliders: [{ ...CUBOID, r: [0, 0, 0, 2] }] }, "/colliders/0/r");
  expectRefusal(
    { colliders: [{ ...CUBOID, shape: "cuboid", halfExtents: [1, 0, 1] }] },
    "/colliders/0/halfExtents/1",
  );
  expectRefusal(
    { colliders: [{ ...HULL, points: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] },
    "/colliders/0/points",
  );
  expectRefusal({ colliders: [{ ...CUBOID, fitted: false }] }, "/colliders/0/fitted");
  expectRefusal({ colliders: [{ ...CUBOID, key: -1 }] }, "/colliders/0/key");
  expectRefusal(42, "");
  expectRefusal([42], "/colliders/0");
});

test("(d) desc mapping: created colliders carry the record translation and rotation", () => {
  const sim = new RapierWorldSim(R);
  const set = new ProceduralColliderSet(sim, R, COLLIDERS);
  const body = sim.body(set.body);
  for (let i = 0; i < COLLIDERS.length; i++) {
    const record = COLLIDERS[i];
    const collider = body.collider(i);
    const t = collider.translation();
    const r = collider.rotation();
    const worldT = [t.x, t.y, t.z];
    const worldR = [r.x, r.y, r.z, r.w];
    for (let k = 0; k < 3; k++) {
      assert.ok(
        Math.abs(worldT[k] - record.t[k]) <= 1e-6,
        `record ${record.instance} translation[${k}] is ${worldT[k]}, expected ${record.t[k]}`,
      );
    }
    for (let k = 0; k < 4; k++) {
      assert.ok(
        Math.abs(worldR[k] - record.r[k]) <= 1e-6,
        `record ${record.instance} rotation[${k}] is ${worldR[k]}, expected ${record.r[k]}`,
      );
    }
  }
  set.dispose();
  sim.free();
});
