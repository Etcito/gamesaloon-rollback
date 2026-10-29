import { test } from "node:test";
import assert from "node:assert";
import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { DomainSpec, ShadowView, SleepEvent } from "@gamesaloon/rollback/zones";
import { initRapier, RapierDomainWorld } from "../src/index.ts";
import type { DomainEntityBuilder, DomainJointBuilder } from "../src/index.ts";
import { exportEntities, kinematicByTick, mergeEntityStreams, rebuildDomain, ShadowProxies } from "../src/domain-rebuild.ts";
import type { KinematicPart, KinematicPose } from "../src/domain-rebuild.ts";

const R = await initRapier();

const KIND_GROUND = 0;
const KIND_BALL = 1;
const NO_PARAMS = new Uint8Array(0);
const NO_OWNER = 0xffff;
const SPEC: DomainSpec = { id: 1, kind: "seat", cells: [0], seats: [0], replicas: [0] };

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
  w.spawn(KIND_GROUND, NO_PARAMS, NO_OWNER);
  w.spawn(KIND_BALL, new Uint8Array([0, 20]), 0);
  w.spawn(KIND_BALL, new Uint8Array([10, 20]), 1);
  w.join(2, 3, 0, NO_PARAMS);
  return w;
}

function exportBytes(w: RapierDomainWorld): Uint8Array {
  const sw = new SnapWriter();
  exportEntities(w, sw);
  return sw.bytes().slice();
}

function merged(bytes: Uint8Array) {
  return mergeEntityStreams([new SnapReader(bytes)]);
}

function stepN(w: RapierDomainWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

test("merge is ascending, deduplicated and keeps the first source occurrence", () => {
  const a = makeWorld();
  stepN(a, 30);
  const aBytes = exportBytes(a);

  const b = new RapierDomainWorld(R, buildEntity, buildJoint);
  b.adopt(1, KIND_BALL, new Uint8Array([50, 50]), NO_OWNER);
  b.adopt(4, KIND_BALL, new Uint8Array([30, 30]), NO_OWNER);
  const bBytes = exportBytes(b);

  const ab = mergeEntityStreams([new SnapReader(aBytes), new SnapReader(bBytes)]);
  assert.deepStrictEqual(ab.entities.map((e) => e.id), [1, 2, 3, 4]);
  assert.deepStrictEqual(ab.joints.map((j) => j.id), [1]);
  assert.equal(ab.entities[0].kind, KIND_GROUND, "the first source wins the duplicate id 1");

  const ba = mergeEntityStreams([new SnapReader(bBytes), new SnapReader(aBytes)]);
  assert.equal(ba.entities[0].kind, KIND_BALL);

  const again = mergeEntityStreams([new SnapReader(aBytes), new SnapReader(aBytes)]);
  assert.equal(again.entities.length, 3);
  assert.equal(again.joints.length, 1);

  const c = new RapierDomainWorld(R, buildEntity, buildJoint);
  c.adopt(10, KIND_BALL, new Uint8Array([1, 1]), NO_OWNER);
  const d = new RapierDomainWorld(R, buildEntity, buildJoint);
  d.adopt(20, KIND_BALL, new Uint8Array([2, 2]), NO_OWNER);
  const cd = mergeEntityStreams([new SnapReader(exportBytes(c)), new SnapReader(exportBytes(d))]);
  const dc = mergeEntityStreams([new SnapReader(exportBytes(d)), new SnapReader(exportBytes(c))]);
  assert.deepStrictEqual(cd.entities.map((e) => e.id), [10, 20]);
  assert.deepStrictEqual(dc.entities.map((e) => e.id), [10, 20]);
  for (const w of [a, b, c, d]) w.sim.free();
});

test("rebuild restores ids, pose, velocities, joints and the tick", () => {
  const src = makeWorld();
  stepN(src, 120);
  const bytes = exportBytes(src);
  const rebuilt = rebuildDomain({
    R,
    spec: SPEC,
    tick: src.tick,
    sources: [new SnapReader(bytes)],
    buildEntity,
    buildJoint,
    belongs: () => true,
  });
  assert.equal(rebuilt.tick, src.tick);
  assert.equal(rebuilt.hash(), src.hash());
  assert.deepStrictEqual(exportBytes(rebuilt), bytes);
  src.sim.free();
  rebuilt.sim.free();
});

test("rebuild filters entities, cuts cross-domain joints and never reuses ids", () => {
  const src = makeWorld();
  stepN(src, 60);
  const bytes = exportBytes(src);
  const rebuilt = rebuildDomain({
    R,
    spec: SPEC,
    tick: src.tick,
    sources: [new SnapReader(bytes)],
    buildEntity,
    buildJoint,
    belongs: (e) => e.id === 2,
  });
  assert.deepStrictEqual(merged(exportBytes(rebuilt)).entities.map((e) => e.id), [2]);
  assert.equal(merged(exportBytes(rebuilt)).joints.length, 0, "joint 1/2-3 loses its other end");
  assert.equal(rebuilt.spawn(KIND_BALL, new Uint8Array([0, 0]), NO_OWNER), 4, "max seen entity id was 3");
  assert.throws(() => rebuilt.adopt(3, KIND_BALL, new Uint8Array([0, 0]), NO_OWNER), /below next id 5/);
  assert.equal(rebuilt.join(2, 4, 0, NO_PARAMS), 2, "max seen joint id was 1");
  src.sim.free();
  rebuilt.sim.free();
});

test("rebuild restores the sleep set with its sleepTick and emits no SLEEP again", () => {
  const src = makeWorld();
  stepN(src, 2000);
  const bytes = exportBytes(src);
  const records = merged(bytes).entities;
  const asleep = records.filter((e) => e.asleep);
  assert.deepStrictEqual(asleep.map((e) => e.id), [2, 3]);
  for (const e of asleep) assert.ok(e.sleepTick > 0);

  const rebuilt = rebuildDomain({
    R,
    spec: SPEC,
    tick: src.tick,
    sources: [new SnapReader(bytes)],
    buildEntity,
    buildJoint,
    belongs: () => true,
  });
  assert.equal(rebuilt.hash(), src.hash());
  assert.deepStrictEqual(
    merged(exportBytes(rebuilt)).entities.filter((e) => e.asleep).map((e) => [e.id, e.sleepTick]),
    asleep.map((e) => [e.id, e.sleepTick]),
  );
  // A fresh Rapier world has no contact pairs yet, so its first step may re-evaluate the sleepers. The restored
  // sleep set must still report only WAKE transitions, never a second SLEEP for a body that was already asleep.
  const out: SleepEvent[] = [];
  rebuilt.step();
  rebuilt.sleepEvents(out);
  assert.ok(out.every((e) => !e.asleep), "no SLEEP is emitted for a body restored asleep");
  src.sim.free();
  rebuilt.sim.free();
});

function shadowPayload(records: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const w = new SnapWriter();
  w.u16(records.length);
  for (const [id, x, y, z] of records) {
    w.u32(id);
    w.f64(x);
    w.f64(y);
    w.f64(z);
    w.f64(0);
    w.f64(0);
    w.f64(0);
    w.f64(1);
  }
  return w.bytes().slice();
}

function shadowView(from: number, bytes: Uint8Array): ShadowView {
  return { count: 1, fromDomain: () => from, reader: () => new SnapReader(bytes) };
}

test("shadow proxies: create on first sight, follow the next pose, remove when absent", () => {
  const world = new RapierDomainWorld(R, buildEntity, buildJoint);
  const proxies = new ShadowProxies(R, world);

  proxies.step(shadowView(7, shadowPayload([[5, 1, 2, 3]])));
  const first = world.proxyBody(7, 5);
  assert.notEqual(first, undefined);
  assert.equal(world.sim.body(first!).bodyType(), R.RigidBodyType.KinematicPositionBased);
  let t = world.sim.body(first!).translation();
  assert.deepStrictEqual([t.x, t.y, t.z], [1, 2, 3]);

  proxies.step(shadowView(7, shadowPayload([[5, 4, 5, 6], [6, 7, 8, 9]])));
  assert.equal(world.proxyBody(7, 5), first, "the existing proxy is reused");
  assert.notEqual(world.proxyBody(7, 6), undefined);
  world.step();
  t = world.sim.body(world.proxyBody(7, 5)!).translation();
  assert.deepStrictEqual([t.x, t.y, t.z], [4, 5, 6]);
  t = world.sim.body(world.proxyBody(7, 6)!).translation();
  assert.deepStrictEqual([t.x, t.y, t.z], [7, 8, 9]);

  proxies.step(shadowView(7, shadowPayload([[6, 7, 8, 9]])));
  assert.equal(world.proxyBody(7, 5), undefined, "absent from an arrived payload: removed");
  assert.notEqual(world.proxyBody(7, 6), undefined);

  proxies.step(shadowView(7, shadowPayload([])));
  assert.equal(world.proxyBody(7, 6), undefined, "an empty payload (count 0) removes the rest");

  proxies.step(shadowView(7, shadowPayload([[6, 1, 1, 1]])));
  proxies.step(shadowView(9, new Uint8Array(0)));
  assert.notEqual(world.proxyBody(7, 6), undefined, "a zero-length link is skipped without reading");
  assert.equal(world.proxyBody(9, 6), undefined);
  world.sim.free();
});

test("kinematic-by-tick parts follow the tick and stay out of the entity table", () => {
  const world = new RapierDomainWorld(R, buildEntity, buildJoint);
  const body = world.sim.createBody(R.RigidBodyDesc.kinematicPositionBased());
  const part: KinematicPart = {
    body,
    pose(tick: number, out: KinematicPose): void {
      out.translation.x = tick * 2;
      out.translation.y = 1;
      out.translation.z = 0;
      out.rotation.x = 0;
      out.rotation.y = 0;
      out.rotation.z = 0;
      out.rotation.w = 1;
    },
  };
  kinematicByTick(world, 5, [part]);
  let t = world.sim.body(body).translation();
  assert.deepStrictEqual([t.x, t.y, t.z], [10, 1, 0]);

  kinematicByTick(world, 7, [part]);
  t = world.sim.body(body).translation();
  assert.deepStrictEqual([t.x, t.y, t.z], [14, 1, 0]);

  const empty = new RapierDomainWorld(R, buildEntity, buildJoint);
  assert.equal(world.hash(), empty.hash(), "parts are not hashed or snapshotted per domain");
  assert.deepStrictEqual(merged(exportBytes(world)).entities, []);
  world.sim.free();
  empty.sim.free();
});
