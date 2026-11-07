import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Use MAMA's native procgen::call integration (MAMA@85a1425). Runtime handles
// must stay in one process; the single-call procgen-eval CLI cannot retain them.
function nativeFrames(): { tick: number; ok: boolean; colliderFrames: ProceduralColliderFrame[] }[] {
  const dir = mkdtempSync(join(tmpdir(), "kinematic-native-"));
  const mama = resolve(process.env.MAMA_ROOT ?? fileURLToPath(new URL("../../../../MAMA", import.meta.url)));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]
name = "kinematic-replay-frames"
version = "0.0.0"
edition = "2024"
[dependencies]
mama-procgen = { path = ${JSON.stringify(join(mama, "crates/procgen"))} }
`);
    writeFileSync(join(dir, "src/main.rs"), String.raw`
use std::io::{self, Read};
use procgen::{call, json::{self, Json}};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let created = call(5, input.as_bytes()).unwrap();
    let Json::Obj(fields) = json::parse(std::str::from_utf8(&created).unwrap()).unwrap() else { panic!("object") };
    let Json::Num(handle) = fields.iter().find(|(k, _)| k == "handle").unwrap().1 else { panic!("handle") };
    let last: u32 = std::env::args().nth(1).unwrap().parse().unwrap();
    for tick in (0..=last).chain(61..=last) {
        let request = format!(r#"{{"handle":{handle},"tick":{tick}}}"#);
        let result = call(7, request.as_bytes()).unwrap();
        println!("{}", std::str::from_utf8(&result).unwrap());
    }
    call(8, format!(r#"{{"handle":{handle}}}"#).as_bytes()).unwrap();
}
`);
    const built = spawnSync("cargo", ["build", "--offline", "--quiet", "--manifest-path", join(dir, "Cargo.toml"), "--target-dir", join(dir, "target"), "-j", "1"], { encoding: "utf8", timeout: 60000 });
    assert.equal(built.status, 0, `${built.error ?? ""}\n${built.stderr}`);
    const input = {
      version: 1, timeTicks: 0, paramValues: {},
      sources: { "prim:prim": { kind: "primitive", tree: { root: "box", nodes: {
        box: { kind: "box", params: { size: [4, 0.5, 4] },
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          pivot: [0, 0, 0], op: "union", smooth: 0, visible: true,
          color: "#ffffff", material: "", gameCollision: true, round: 0 },
      } } } },
      graph: {
        format: "sdfm.procedural-graph", version: 1, seed: 0,
        nodes: [
          { id: "prim", type: "input_primitive", params: { primitive: { kind: "box", params: { size: [4, 0.5, 4] } } } },
          { id: "points", type: "array_radial", params: { count: 1, faceOutward: false } },
          { id: "place", type: "instance_on_points" },
          { id: "out", type: "output" },
        ],
        links: [
          { from: { node: "points", port: "out" }, to: { node: "place", port: "points" } },
          { from: { node: "prim", port: "out" }, to: { node: "place", port: "geometry" } },
          { from: { node: "place", port: "out" }, to: { node: "out", port: "in" } },
        ],
        params: [{ name: "radius", label: "Radius", type: "number", default: 1,
          binds: [{ node: "points", param: "radius" }],
          driver: { kind: "time", wave: "sine", period: 2, amplitude: 0.25, offset: 1 } }],
      },
    };
    const run = (last: number) => {
      const result = spawnSync(join(dir, "target/debug/kinematic-replay-frames"), [String(last)], {
        input: JSON.stringify(input), encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
      return result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    };
    const probe = run(0);
    assert.equal(probe[0].ok, true, JSON.stringify(probe[0].issues));
    assert.equal(probe[0].colliderFrames.length, 1);
    return run(120);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P11: native kinematic frames replay byte-identically after tick-60 restore with dynamic contact", () => {
  const deltas = nativeFrames();
  assert.equal(deltas.length, 181);
  const initial = deltas[0].colliderFrames[0];
  assert.notDeepEqual(deltas[30].colliderFrames[0].t, initial.t, "native driver moves the platform");
  const sim = new RapierWorldSim(R);
  const kin = new ProceduralKinematics(sim, R);
  try {
    kin.apply(deltas[0].colliderFrames);
    const platformId = kin.bodyOf(initial.key)!;
    const ballId = sim.createBody(R.RigidBodyDesc.dynamic().setTranslation(1, 1, 0), [R.ColliderDesc.ball(0.25).setFriction(1)]);
    const snapshots: Uint8Array[] = [];
    let contacts = 0;
    for (let tick = 0; tick <= 120; tick++) {
      const delta = deltas[tick];
      assert.equal(delta.ok, true);
      assert.equal(delta.tick, tick);
      kin.apply(delta.colliderFrames);
      sim.step();
      sim.world.contactPair(sim.body(platformId).collider(0), sim.body(ballId).collider(0), (manifold) => {
        contacts += manifold.numSolverContacts();
      });
      snapshots.push(sim.takeSnapshot());
    }
    assert.ok(contacts > 0, "the dynamic ball contacts the moving platform");
    assert.notEqual(sim.body(ballId).translation().x, 1, "contact transfers platform motion to the ball");
    // Invalidate the live map, including recreation, before restoring its old identity.
    kin.apply([]);
    kin.apply(deltas[120].colliderFrames);
    assert.notEqual(kin.bodyOf(initial.key), platformId);
    sim.restoreSnapshot(snapshots[60]);
    assert.equal(kin.bodyOf(initial.key), platformId);
    for (let tick = 61; tick <= 120; tick++) {
      const replay = deltas[121 + tick - 61];
      assert.equal(replay.ok, true);
      assert.equal(replay.tick, tick);
      assert.deepEqual(replay.colliderFrames, deltas[tick].colliderFrames);
      kin.apply(replay.colliderFrames);
      sim.step();
      assert.deepEqual(sim.takeSnapshot(), snapshots[tick], `snapshot bytes at tick ${tick}`);
    }
    kin.apply([]);
    sim.restoreSnapshot(snapshots[60]);
    kin.dispose();
    assert.equal(sim.hasBody(platformId), false, "dispose also reconciles restored bodies");
    assert.equal(sim.hasBody(ballId), true);
  } finally {
    kin.dispose();
    sim.free();
  }
});
