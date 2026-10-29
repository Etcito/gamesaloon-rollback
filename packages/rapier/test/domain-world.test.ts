import { test } from "node:test";
import assert from "node:assert";
import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { SleepEvent } from "@gamesaloon/rollback/zones";
import { initRapier, RapierDomainWorld } from "../src/index.ts";
import type { DomainEntityBuilder, DomainJointBuilder } from "../src/index.ts";

const R = await initRapier();

const KIND_GROUND = 0;
const KIND_BALL = 1;
const NO_PARAMS = new Uint8Array(0);
const UNOWNED = 0xffff;

const buildEntity: DomainEntityBuilder = (kind, params) => {
  if (kind === KIND_GROUND) {
    return { body: R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), colliders: [R.ColliderDesc.cuboid(20, 0.5, 20)] };
  }
  const body = R.RigidBodyDesc.dynamic().setTranslation(params[0] / 10, params[1] / 10, 0);
  return { body, colliders: [R.ColliderDesc.ball(0.5)] };
};

const buildJoint: DomainJointBuilder = (world, _kind, _params, a, b) =>
  world.createImpulseJoint(R.JointData.spherical({ x: 0, y: 0.5, z: 0 }, { x: 0, y: -0.5, z: 0 }), a, b, true);

/** Ground (entity 1), two balls (2, 3) starting at height 2 and joined by a spherical joint. */
function makeWorld(): RapierDomainWorld {
  const w = new RapierDomainWorld(R, buildEntity, buildJoint);
  w.spawn(KIND_GROUND, NO_PARAMS, UNOWNED);
  w.spawn(KIND_BALL, new Uint8Array([0, 20]), 0);
  w.spawn(KIND_BALL, new Uint8Array([10, 20]), 1);
  w.join(2, 3, 0, NO_PARAMS);
  return w;
}

function stepN(w: RapierDomainWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

test("entity and joint ids come from a counter and are never reused", () => {
  const w = makeWorld();
  assert.throws(() => w.adopt(2, KIND_BALL, NO_PARAMS, UNOWNED), /never reused/);
  assert.equal(w.adopt(7, KIND_BALL, new Uint8Array([0, 0]), UNOWNED), 7);
  assert.equal(w.spawn(KIND_BALL, new Uint8Array([0, 0]), UNOWNED), 8);
  assert.equal(w.join(2, 7, 0, NO_PARAMS), 2);
  assert.throws(() => w.join(2, 99, 0, NO_PARAMS), /must join entities/);
  w.sim.free();
});

test("SLEEP once per transition with the sleepPose bytes; WAKE once with an empty pose", () => {
  const w = makeWorld();
  const seen: { id: number; asleep: boolean; pose: Uint8Array }[] = [];
  const out: SleepEvent[] = [];
  for (let t = 0; t < 2000 && seen.filter((e) => e.asleep).length < 2; t++) {
    w.step();
    w.sleepEvents(out);
    for (const e of out) {
      if (e.asleep) {
        const sw = new SnapWriter();
        assert.ok(w.sleepPose(e.id, sw));
        assert.deepStrictEqual(e.pose, sw.bytes());
        assert.equal(e.pose.length, 7 * 8);
      } else {
        assert.equal(e.pose.length, 0);
      }
      seen.push({ id: e.id, asleep: e.asleep, pose: e.pose.slice() });
    }
  }
  for (const id of [2, 3]) {
    assert.deepStrictEqual(
      seen.filter((e) => e.id === id).map((e) => e.asleep),
      [true],
      `ball ${id} sleeps once`,
    );
  }
  stepN(w, 50);
  w.sleepEvents(out);
  assert.equal(out.length, 0, "no transitions while the state holds");

  w.sim.body(w.bodyOf(2)).setLinvel({ x: 0, y: 2, z: 0 }, true);
  w.step();
  w.sleepEvents(out);
  const woke = out.filter((e) => e.id === 2);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].asleep, false);
  assert.equal(woke[0].pose.length, 0);
  w.sim.free();
});

test("snapshot then restore replays to the same hash, joint included", () => {
  const w = makeWorld();
  stepN(w, 120);
  const sw = new SnapWriter();
  w.snapshot(sw);
  const bytes = sw.bytes().slice();
  const tick0 = w.tick;
  const hash0 = w.hash();
  stepN(w, 120);
  const hashA = w.hash();

  w.restore(new SnapReader(bytes));
  assert.equal(w.tick, tick0);
  assert.equal(w.hash(), hash0);
  assert.equal(w.sim.world.impulseJoints.len(), 1);
  stepN(w, 120);
  assert.equal(w.hash(), hashA);
  w.sim.free();
});

test("two worlds from one recipe agree on the hash at every checkpoint", () => {
  const a = makeWorld();
  const b = makeWorld();
  for (let t = 1; t <= 600; t++) {
    a.step();
    b.step();
    if (t % 60 === 0) assert.equal(a.hash(), b.hash(), `diverged at tick ${t}`);
  }
  a.sim.free();
  b.sim.free();
});

test("export lists entities then joints in ascending id, with sleep flags", () => {
  const w = makeWorld();
  stepN(w, 2000);
  const sw = new SnapWriter();
  w.exportEntities(sw);
  const r = new SnapReader(sw.bytes().slice());
  const nEntities = r.u32();
  assert.equal(nEntities, 3);
  const ids: number[] = [];
  const asleep: number[] = [];
  for (let i = 0; i < nEntities; i++) {
    ids.push(r.u32());
    r.u16();
    const paramsLen = r.u16();
    for (let p = 0; p < paramsLen; p++) r.u8();
    r.u16();
    r.u8();
    asleep.push(r.u8());
    r.i32();
    for (let f = 0; f < 13; f++) r.f64();
  }
  assert.deepStrictEqual(ids, [1, 2, 3]);
  assert.deepStrictEqual(asleep, [0, 1, 1]);
  assert.equal(r.u32(), 1);
  assert.deepStrictEqual([r.u32(), r.u32(), r.u32()], [1, 2, 3]);
  assert.equal(r.u16(), 0);
  assert.equal(r.u16(), 0);
  assert.equal(r.remaining, 0);
  w.sim.free();
});
