import { test } from "node:test";
import assert from "node:assert";
import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { SleepEvent } from "@gamesaloon/rollback/zones";
import { getR, mulberry32 } from "./scenario.ts";
import { RapierDomainWorld } from "../src/index.ts";
import type { DomainEntityBuilder, DomainJointBuilder } from "../src/index.ts";

const R = await getR();

const KIND_GROUND = 0;
const KIND_BOX = 1;
const KIND_ANCHOR = 2;
const NO_PARAMS = new Uint8Array(0);
const UNOWNED = 0xffff;

/** Params are (x*10, y*10, rest). Fixed anchors stay put; boxes fall and settle. */
const buildEntity: DomainEntityBuilder = (kind, params) => {
  if (kind === KIND_GROUND) {
    return { body: R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), colliders: [R.ColliderDesc.cuboid(20, 0.5, 20)] };
  }
  const x = params[0] / 10;
  const y = params[1] / 10;
  if (kind === KIND_ANCHOR) {
    return { body: R.RigidBodyDesc.fixed().setTranslation(x, y, 0), colliders: [R.ColliderDesc.cuboid(0.2, 0.2, 0.2)] };
  }
  return {
    body: R.RigidBodyDesc.dynamic().setTranslation(x, y, 0),
    colliders: [R.ColliderDesc.cuboid(0.5, 0.5, 0.5).setFriction(0.8)],
  };
};

const buildJoint: DomainJointBuilder = (world, _kind, _params, a, b) =>
  world.createImpulseJoint(R.JointData.spherical({ x: 0, y: 0.5, z: 0 }, { x: 0, y: -0.5, z: 0 }), a, b, true);

/** Ground (1), two boxes (2, 3) and a fixed anchor (4). */
function makeWorld(): RapierDomainWorld {
  const w = new RapierDomainWorld(R, buildEntity, buildJoint);
  w.spawn(KIND_GROUND, NO_PARAMS, UNOWNED);
  w.spawn(KIND_BOX, new Uint8Array([0, 30]), 0);
  w.spawn(KIND_BOX, new Uint8Array([12, 30]), 1);
  w.spawn(KIND_ANCHOR, new Uint8Array([0, 30]), UNOWNED);
  return w;
}

/** Ground (1) and one box (2) that settles and sleeps. */
function makeSleepWorld(): RapierDomainWorld {
  const w = new RapierDomainWorld(R, buildEntity, buildJoint);
  w.spawn(KIND_GROUND, NO_PARAMS, UNOWNED);
  w.spawn(KIND_BOX, new Uint8Array([0, 20]), UNOWNED);
  return w;
}

function stepN(w: RapierDomainWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

/** Steps until the first body sleeps; returns the copied SLEEP events. */
function settle(w: RapierDomainWorld, maxTicks: number): SleepEvent[] {
  const out: SleepEvent[] = [];
  const sleeps: SleepEvent[] = [];
  for (let t = 0; t < maxTicks && sleeps.length === 0; t++) {
    w.step();
    w.sleepEvents(out);
    for (const e of out) if (e.asleep) sleeps.push({ ...e, pose: e.pose.slice() });
  }
  return sleeps;
}

/** Rewrites the first sleepTick of an envelope in place, to prove the digest covers it. */
function bumpFirstSleepTick(src: Uint8Array): Uint8Array {
  const out = src.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let o = 0;
  const u16 = (): number => {
    const v = dv.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = (): number => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  u32(); // magic
  u32(); // version
  u32(); // next entity id
  u32(); // next joint id
  const nEntities = u32();
  for (let i = 0; i < nEntities; i++) {
    o += 4 + 4 + 2; // id, body, kind
    const paramsLen = u16();
    o += paramsLen + 2; // params, owner
  }
  const nJoints = u32();
  for (let i = 0; i < nJoints; i++) {
    o += 4 + 4 + 4 + 2; // id, a, b, kind
    const paramsLen = u16();
    o += paramsLen + 8; // params, handle
  }
  const nProxies = u32();
  o += nProxies * (2 + 4 + 4);
  const nSleep = u32();
  assert.ok(nSleep > 0, "expected a sleeping body");
  dv.setInt32(o + 4, dv.getInt32(o + 4, true) + 1, true);
  return out;
}

test("ids are never reused after removals or a snapshot/restore round trip", () => {
  const removed = makeWorld();
  const gone = removed.spawn(KIND_BOX, new Uint8Array([40, 10]), UNOWNED);
  assert.equal(gone, 5);
  removed.sim.removeBody(removed.bodyOf(gone));
  assert.equal(removed.spawn(KIND_BOX, new Uint8Array([50, 10]), UNOWNED), 6);
  removed.sim.free();

  const w = makeWorld();
  assert.equal(w.join(2, 3, 0, NO_PARAMS), 1);
  const sw = new SnapWriter();
  w.snapshot(sw);
  w.restore(new SnapReader(sw.bytes().slice()));
  assert.equal(w.spawn(KIND_BOX, new Uint8Array([40, 10]), UNOWNED), 5);
  assert.equal(w.join(2, 3, 0, NO_PARAMS), 2);
  w.sim.free();
});

test("a joint between two dynamic boxes and a fixed anchor survives restore", () => {
  const w = makeWorld();
  w.join(2, 3, 0, NO_PARAMS);
  w.join(2, 4, 0, NO_PARAMS);
  stepN(w, 90);
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
  assert.equal(w.sim.world.impulseJoints.len(), 2);
  stepN(w, 120);
  assert.equal(w.hash(), hashA);
  w.sim.free();
});

test("SLEEP and WAKE each fire once, with the sleepPose bytes and an empty WAKE pose", () => {
  const w = makeSleepWorld();
  const out: SleepEvent[] = [];
  const sleeps = settle(w, 3000);
  assert.equal(sleeps.length, 1);
  const sleep = sleeps[0];
  assert.equal(sleep.id, 2);
  assert.equal(sleep.asleep, true);
  assert.ok(sleep.pose.length > 0);
  const pose = new SnapWriter();
  assert.ok(w.sleepPose(sleep.id, pose));
  assert.deepStrictEqual(sleep.pose, pose.bytes());

  stepN(w, 60);
  w.sleepEvents(out);
  assert.equal(out.length, 0, "no duplicate SLEEP while asleep");

  w.sim.body(w.bodyOf(2)).applyImpulse({ x: 0, y: 4, z: 0 }, true);
  w.step();
  w.sleepEvents(out);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 2);
  assert.equal(out[0].asleep, false);
  assert.equal(out[0].pose.length, 0);

  stepN(w, 5);
  w.sleepEvents(out);
  assert.equal(out.length, 0, "no duplicate WAKE after the transition");
  w.sim.free();
});

test("the hash changes when a sleeping body's sleepTick differs", () => {
  const a = makeSleepWorld();
  assert.equal(settle(a, 3000).length, 1);
  const sw = new SnapWriter();
  a.snapshot(sw);
  const bytes = sw.bytes().slice();

  const b = makeSleepWorld();
  b.restore(new SnapReader(bytes));
  assert.equal(b.hash(), a.hash());

  const c = makeSleepWorld();
  c.restore(new SnapReader(bumpFirstSleepTick(bytes)));
  assert.notEqual(c.hash(), a.hash());

  a.sim.free();
  b.sim.free();
  c.sim.free();
});

test("export lists entities and joints in strictly ascending id after restore", () => {
  const w = makeWorld();
  w.join(2, 3, 0, NO_PARAMS);
  stepN(w, 30);
  const sw = new SnapWriter();
  w.snapshot(sw);
  w.restore(new SnapReader(sw.bytes().slice()));

  const rnd = mulberry32(7);
  const y = 40 + Math.floor(rnd() * 20);
  assert.equal(w.adopt(10, KIND_BOX, new Uint8Array([40, y]), UNOWNED), 10);
  assert.equal(w.spawn(KIND_BOX, new Uint8Array([60, y]), UNOWNED), 11);

  const ew = new SnapWriter();
  w.exportEntities(ew);
  const r = new SnapReader(ew.bytes().slice());
  const nEntities = r.u32();
  const ids: number[] = [];
  for (let i = 0; i < nEntities; i++) {
    ids.push(r.u32());
    r.u16();
    const paramsLen = r.u16();
    for (let p = 0; p < paramsLen; p++) r.u8();
    r.u16();
    r.u8();
    r.u8();
    r.i32();
    for (let f = 0; f < 13; f++) r.f64();
  }
  assert.deepStrictEqual(ids, [1, 2, 3, 4, 10, 11]);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], "entity ids are strictly ascending");

  const nJoints = r.u32();
  const jointIds: number[] = [];
  for (let i = 0; i < nJoints; i++) {
    jointIds.push(r.u32());
    r.u32();
    r.u32();
    r.u16();
    const paramsLen = r.u16();
    for (let p = 0; p < paramsLen; p++) r.u8();
  }
  assert.deepStrictEqual(jointIds, [1]);
  assert.equal(r.remaining, 0);
  w.sim.free();
});

test("proxyIds lists one source's proxies in ascending id, also after restore", () => {
  const w = makeWorld();
  const kinematic = () => w.sim.createBody(R.RigidBodyDesc.kinematicPositionBased(), [R.ColliderDesc.ball(0.1)]);
  w.setProxy(2, 7, kinematic());
  w.setProxy(2, 3, kinematic());
  w.setProxy(2, 5, kinematic());
  w.setProxy(9, 4, kinematic());
  const sw = new SnapWriter();
  w.snapshot(sw);

  const fresh = makeWorld();
  fresh.restore(new SnapReader(sw.bytes().slice()));
  const out: number[] = [9, 9];
  fresh.proxyIds(2, out);
  assert.deepStrictEqual(out, [3, 5, 7]);
  fresh.proxyIds(9, out);
  assert.deepStrictEqual(out, [4]);
  fresh.proxyIds(1, out);
  assert.deepStrictEqual(out, []);
  w.sim.free();
  fresh.sim.free();
});
