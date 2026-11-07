import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { getR } from "./scenario.ts";
import {
  ProceduralKinematics,
  RapierWorldSim,
  validateProceduralColliders,
} from "../src/index.ts";
import type {
  LocalCollider,
  ProceduralCollider,
  ProceduralColliderFrame,
} from "../src/index.ts";

const R = await getR();

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/procedural-colliders.json", import.meta.url), "utf8"),
) as unknown;
const validated = validateProceduralColliders(fixture);
if (!validated.ok) {
  throw new Error(`fixture invalid at ${validated.error.path}: ${validated.error.message}`);
}
const COLLIDERS: ProceduralCollider[] = validated.colliders;

function localOf({
  instance: _instance,
  key: _key,
  fitted: _fitted,
  ...local
}: ProceduralCollider): LocalCollider {
  return local;
}

const SOURCES = [
  COLLIDERS.find((c) => c.shape === "cuboid")!,
  COLLIDERS.find((c) => c.shape === "capsule")!,
  COLLIDERS.find((c) => c.shape === "convexHull")!,
];

function frames(): ProceduralColliderFrame[] {
  return SOURCES.map((c) => ({
    key: c.key,
    t: c.t,
    r: c.r,
    colliders: [localOf(c)],
  }));
}

type Vec = [number, number, number];
type Quat = [number, number, number, number];

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotate(q: Quat, v: Vec): Vec {
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

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-6;
}

function assertVec(actual: { x: number; y: number; z: number }, expected: Vec, what: string): void {
  assert.ok(close(actual.x, expected[0]), `${what}.x ${actual.x} != ${expected[0]}`);
  assert.ok(close(actual.y, expected[1]), `${what}.y ${actual.y} != ${expected[1]}`);
  assert.ok(close(actual.z, expected[2]), `${what}.z ${actual.z} != ${expected[2]}`);
}

function assertQuat(
  actual: { x: number; y: number; z: number; w: number },
  expected: Quat,
  what: string,
): void {
  const dot =
    actual.x * expected[0] + actual.y * expected[1] + actual.z * expected[2] + actual.w * expected[3];
  const sign = dot < 0 ? -1 : 1;
  const values = [actual.x, actual.y, actual.z, actual.w];
  for (let i = 0; i < 4; i++) {
    assert.ok(
      close(values[i], sign * expected[i]),
      `${what}[${i}] ${values[i]} != ${sign * expected[i]}`,
    );
  }
}

test("(a) reordered input applies in ascending key order and keeps bodies stable", () => {
  const source = frames();
  const sorted = [...source].sort((a, b) => a.key - b.key);
  const A = new RapierWorldSim(R);
  const B = new RapierWorldSim(R);
  const ka = new ProceduralKinematics(A, R);
  const kb = new ProceduralKinematics(B, R);
  ka.apply([...source].reverse());
  kb.apply(source);

  const idsA = sorted.map((f) => ka.bodyOf(f.key));
  const idsB = sorted.map((f) => kb.bodyOf(f.key));
  assert.deepEqual(idsA, idsB);
  for (const id of idsA) assert.equal(typeof id, "number");
  for (let i = 1; i < idsA.length; i++) {
    assert.ok(idsA[i - 1]! < idsA[i]!, "bodies are created in ascending numeric key order");
  }

  ka.apply(source);
  assert.deepEqual(sorted.map((f) => ka.bodyOf(f.key)), idsA);
  for (let i = 0; i < 10; i++) {
    A.step();
    B.step();
  }
  assert.deepEqual(A.takeSnapshot(), B.takeSnapshot());
  ka.dispose();
  kb.dispose();
  A.free();
  B.free();
});

test("(b) missing keys are removed and recreated with fresh bodies, then disposed", () => {
  const source = frames();
  const removedFrame = source[1];
  const sim = new RapierWorldSim(R);
  const kin = new ProceduralKinematics(sim, R);
  kin.apply(source);
  sim.step();
  const before = new Map(source.map((f) => [f.key, kin.bodyOf(f.key)!]));

  kin.apply(source.filter((f) => f.key !== removedFrame.key));
  assert.equal(kin.bodyOf(removedFrame.key), undefined);
  assert.equal(sim.hasBody(before.get(removedFrame.key)!), false);
  for (const f of source) {
    if (f.key !== removedFrame.key) assert.equal(kin.bodyOf(f.key), before.get(f.key));
  }
  sim.step();

  kin.apply(source);
  const recreated = kin.bodyOf(removedFrame.key)!;
  assert.notEqual(recreated, before.get(removedFrame.key));
  assert.equal(sim.hasBody(recreated), true);
  assert.equal(sim.body(recreated).numColliders(), removedFrame.colliders.length);
  sim.step();

  kin.dispose();
  for (const f of source) assert.equal(kin.bodyOf(f.key), undefined);
  for (const id of before.values()) assert.equal(sim.hasBody(id), false);
  kin.dispose();
  sim.free();
});

test("(c) placement moves the body while collider offsets stay local", () => {
  const placement = {
    t: [1, 0, -2] as Vec,
    r: [0, 0.258819045, 0, 0.965925826] as Quat,
  };
  const source = frames();
  const frame = source[1];
  const sim = new RapierWorldSim(R);
  const kin = new ProceduralKinematics(sim, R, { placement, baseId: 1000 });
  assert.equal(kin.baseId, 1000);
  kin.apply([frame]);

  const bodyId = kin.bodyOf(frame.key)!;
  const body = sim.body(bodyId);
  const offset = rotate(placement.r, frame.t);
  const expectedT: Vec = [placement.t[0] + offset[0], placement.t[1] + offset[1], placement.t[2] + offset[2]];
  const expectedR = multiply(placement.r, frame.r);
  assertVec(body.translation(), expectedT, "body.translation");
  assertQuat(body.rotation(), expectedR, "body.rotation");

  const collider = body.collider(0);
  assertVec(collider.translationWrtParent()!, frame.colliders[0].t, "collider.localTranslation");
  assertQuat(collider.rotationWrtParent()!, frame.colliders[0].r, "collider.localRotation");

  const moved: ProceduralColliderFrame = {
    ...frame,
    t: [frame.t[0] + 2, frame.t[1], frame.t[2] - 1],
    r: [0, 0, 0, 1],
  };
  kin.apply([moved]);
  assertVec(sim.body(bodyId).translation(), expectedT, "body does not move before the step");
  sim.step();
  const movedOffset = rotate(placement.r, moved.t);
  assertVec(
    sim.body(bodyId).translation(),
    [placement.t[0] + movedOffset[0], placement.t[1] + movedOffset[1], placement.t[2] + movedOffset[2]],
    "body.nextTranslation",
  );
  assertQuat(
    sim.body(bodyId).rotation(),
    multiply(placement.r, moved.r),
    "body.nextRotation",
  );
  assertVec(
    sim.body(bodyId).collider(0).translationWrtParent()!,
    frame.colliders[0].t,
    "collider offsets are unchanged by body motion",
  );

  kin.dispose();
  sim.free();
});
