import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { getR } from "./scenario.ts";
import {
  ProceduralDynamicsSet,
  ProceduralMechanismSet,
  RapierWorldSim,
  validateProceduralColliders,
  validateProceduralDynamics,
} from "../src/index.ts";

const R = await getR();

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/procedural-dynamics.json", import.meta.url), "utf8"),
) as unknown;
const colliderResult = validateProceduralColliders(fixture);
if (!colliderResult.ok) {
  throw new Error(`fixture colliders invalid at ${colliderResult.error.path}: ${colliderResult.error.message}`);
}
const COLLIDERS = colliderResult.colliders;
const dynamicsResult = validateProceduralDynamics(fixture, COLLIDERS.length);
if (!dynamicsResult.ok) {
  throw new Error(`fixture dynamics invalid at ${dynamicsResult.error.path}: ${dynamicsResult.error.message}`);
}
const DYNAMICS = dynamicsResult.dynamics;

interface Level {
  sim: RapierWorldSim;
  set: ProceduralDynamicsSet;
  mechanisms: ProceduralMechanismSet;
}

function buildLevel(): Level {
  const sim = new RapierWorldSim(R);
  const set = new ProceduralDynamicsSet(sim, R, DYNAMICS, COLLIDERS);
  const mechanisms = new ProceduralMechanismSet(sim, R, DYNAMICS, set.bodies, set.joints);
  return { sim, set, mechanisms };
}

function stepLevel(level: Level, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    level.mechanisms.beforeStep();
    level.sim.step();
  }
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: length`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${what}: first difference at byte ${i}`);
  }
}

function doorAngleDeg(q: { y: number; w: number }): number {
  return Math.abs((2 * Math.atan2(q.y, q.w) * 180) / Math.PI);
}

function turnDeg(q: { w: number }): number {
  return (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
}

function refusal(mutate: (v: any) => void): { path: string; message: string } {
  const copy = JSON.parse(JSON.stringify(fixture));
  mutate(copy);
  const result = validateProceduralDynamics(copy, COLLIDERS.length);
  if (result.ok) assert.fail("expected a refusal");
  return result.error;
}

test("(a) two worlds from the fixture: identical world and mechanism state after 240 ticks", () => {
  const A = buildLevel();
  const B = buildLevel();
  stepLevel(A, 240);
  stepLevel(B, 240);
  assertBytesEqual(A.sim.takeSnapshot(), B.sim.takeSnapshot(), "world snapshot");
  assertBytesEqual(A.mechanisms.takeSnapshot(), B.mechanisms.takeSnapshot(), "mechanism state");
  A.sim.free();
  B.sim.free();
});

test("(b) replay from tick 60 gives identical world and mechanism bytes at tick 180", () => {
  const level = buildLevel();
  stepLevel(level, 60);
  const worldAt60 = level.sim.takeSnapshot();
  const mechanismsAt60 = level.mechanisms.takeSnapshot();
  stepLevel(level, 120);
  const recordedWorld = level.sim.takeSnapshot();
  const recordedMechanisms = level.mechanisms.takeSnapshot();
  assert.equal(level.sim.tick, 180);

  level.sim.restoreSnapshot(worldAt60);
  level.mechanisms.restoreSnapshot(mechanismsAt60);
  assert.equal(level.sim.tick, 60);
  stepLevel(level, 120);
  assert.equal(level.sim.tick, 180);
  assertBytesEqual(level.sim.takeSnapshot(), recordedWorld, "replayed world snapshot");
  assertBytesEqual(level.mechanisms.takeSnapshot(), recordedMechanisms, "replayed mechanism state");
  level.sim.free();
});

test("(c) the plate switch turns on, the door passes 45 deg and a spinner turns by tick 240", () => {
  const level = buildLevel();
  stepLevel(level, 240);
  assert.equal(level.mechanisms.signal("plate-switch"), true);
  assert.equal(level.mechanisms.animationStatus("spin-a")?.state, "playing");

  const door = level.sim.body(level.set.bodies.get("b04")!);
  const doorDeg = doorAngleDeg(door.rotation());
  assert.ok(doorDeg > 45, `door hinge is ${doorDeg} deg at tick 240`);

  const spinner = level.sim.body(level.set.bodies.get("b01")!);
  const spinDeg = turnDeg(spinner.rotation());
  assert.ok(spinDeg > 1, `spinner b01 turned ${spinDeg} deg at tick 240`);
  level.sim.free();
});

test("(d) refusals with the exact path", () => {
  const joint = refusal((v) => {
    v.physics.joints[0].axis = [0, 2, 0];
  });
  assert.equal(joint.path, "/physics/joints/0/axis");

  const link = refusal((v) => {
    v.mechanisms.links[0].from = "no-such-signal";
  });
  assert.equal(link.path, "/mechanisms/links/0/from");

  const colliders = refusal((v) => {
    v.physics.bodies[1].colliders = 3;
  });
  assert.equal(colliders.path, "/physics/bodies/1/colliders");
});
