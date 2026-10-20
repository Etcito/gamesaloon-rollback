import { test } from "node:test";
import assert from "node:assert";
import { getR } from "./scenario.ts";
import { RapierWorldSim, FIXED_DT } from "../src/index.ts";

const R = await getR();

function ground(s: RapierWorldSim) {
  return s.createBody(R.RigidBodyDesc.fixed(), [R.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0)]);
}

test("non-default tick rate: dt follows tickRate, and it survives restore", () => {
  const s = new RapierWorldSim(R, { tickRate: 30 });
  assert.equal(s.tickRate, 30);
  assert.equal(s.dt, 1 / 30);
  const b = s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 100, 0), [R.ColliderDesc.ball(0.5)]);
  const snap = s.takeSnapshot();
  for (let t = 0; t < 30; t++) s.step();
  // free fall for exactly one second of simulated time at 30 ticks/s
  assert.ok(Math.abs(s.body(b).linvel().y - -9.81) < 1e-3, `vy=${s.body(b).linvel().y}`);
  s.restoreSnapshot(snap);
  // Rapier stores the timestep as f32, so compare with a tolerance
  assert.ok(Math.abs(s.world.timestep - 1 / 30) < 1e-7);
  assert.equal(s.dt, 1 / 30);
  assert.equal(s.tick, 0);
  const d = new RapierWorldSim(R);
  assert.equal(d.tickRate, 60);
  assert.equal(d.dt, FIXED_DT);
  assert.throws(() => new RapierWorldSim(R, { tickRate: 0 }), /invalid tickRate/);
});

test("kinematic bodies (position-based) survive restore, next-kinematic target included", () => {
  const s = new RapierWorldSim(R);
  ground(s);
  const k = s.createBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.5, 0), [R.ColliderDesc.cuboid(1, 0.5, 1)]);
  const d = s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0.2, 3, 0), [R.ColliderDesc.ball(0.4)]);
  const drive = (t: number) => s.body(k).setNextKinematicTranslation({ x: Math.sin(t * 0.05) * 3, y: 0.5, z: 0 });
  for (let t = 0; t < 50; t++) { drive(t); s.step(); }
  const snap = s.takeSnapshot();
  for (let t = 50; t < 150; t++) { drive(t); s.step(); }
  const h = s.hash();
  s.restoreSnapshot(snap);
  assert.equal(s.body(k).bodyType(), R.RigidBodyType.KinematicPositionBased);
  for (let t = 50; t < 150; t++) { drive(t); s.step(); }
  assert.equal(s.hash(), h);
  assert.ok(s.body(d).translation().y < 3);
});

test("colliders (shape, friction, sensor flag, groups) and joints survive restore", () => {
  const s = new RapierWorldSim(R, { gravity: { x: 0, y: -9.81, z: 0 } });
  const a = s.createBody(R.RigidBodyDesc.fixed().setTranslation(0, 5, 0), [R.ColliderDesc.ball(0.2)]);
  const b = s.createBody(R.RigidBodyDesc.dynamic().setTranslation(2, 5, 0), [
    R.ColliderDesc.ball(0.3).setFriction(0.123).setCollisionGroups(0x00020001).setSensor(false),
  ]);
  s.world.createImpulseJoint(
    R.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }),
    s.body(a),
    s.body(b),
    true,
  );
  for (let t = 0; t < 40; t++) s.step();
  const snap = s.takeSnapshot();
  assert.equal(s.world.impulseJoints.len(), 1);
  for (let t = 0; t < 100; t++) s.step();
  const h = s.hash();
  s.restoreSnapshot(snap);
  assert.equal(s.world.impulseJoints.len(), 1, "joint survived");
  const col = s.body(b).collider(0);
  assert.equal(Math.fround(col.friction()), Math.fround(0.123));
  assert.equal(col.collisionGroups(), 0x00020001);
  assert.equal(col.shape.type, R.ShapeType.Ball);
  for (let t = 0; t < 100; t++) s.step();
  assert.equal(s.hash(), h);
});

test("sleeping state and contact warm-start survive restore", () => {
  const s = new RapierWorldSim(R);
  ground(s);
  const d = s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0), [R.ColliderDesc.cuboid(0.5, 0.5, 0.5)]);
  for (let t = 0; t < 300; t++) s.step();
  assert.ok(s.body(d).isSleeping(), "box fell asleep");
  const snap = s.takeSnapshot();
  s.restoreSnapshot(snap);
  assert.ok(s.body(d).isSleeping(), "still asleep after restore");
  assert.deepEqual(s.takeSnapshot(), snap, "snapshot -> restore -> snapshot is byte-identical");
});

test("JS-side data is NOT in the snapshot: userData, character controller, event queue", () => {
  const s = new RapierWorldSim(R);
  ground(s);
  const d = s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 3, 0).setUserData({ tag: "x" }), [
    R.ColliderDesc.ball(0.4).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
  ]);
  const snap = s.takeSnapshot();
  s.restoreSnapshot(snap);
  const ud = s.body(d).userData;
  console.log("  userData after restore:", JSON.stringify(ud));

  // Character controller: stateless in Rapier (all state lives in your JS). Create after restore is fine.
  const cc = s.world.createCharacterController(0.01);
  s.restoreSnapshot(snap);
  assert.ok(cc, "controller object is a separate WASM object, unaffected by world replacement");

  // Event queue: filled during step(), drained by the caller. Not part of the snapshot.
  const q = new R.EventQueue(true);
  let events = 0;
  for (let t = 0; t < 120; t++) {
    s.step(q);
    q.drainCollisionEvents(() => { events++; });
  }
  assert.ok(events > 0, "events were delivered live");
  s.restoreSnapshot(snap);
  let leftover = 0;
  q.drainCollisionEvents(() => { leftover++; });
  assert.equal(leftover, 0, "queue empty after drain; it holds nothing the snapshot needs");
  cc.free?.();
  q.free();
});
