import { test } from "node:test";
import assert from "node:assert";
import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { DomainSpec, ShadowView, SleepEvent } from "@gamesaloon/rollback/zones";
import { getR, mulberry32 } from "./scenario.ts";
import { RapierDomainWorld } from "../src/index.ts";
import type { DomainEntityBuilder, DomainJointBuilder } from "../src/index.ts";
import { exportEntities, kinematicByTick, mergeEntityStreams, rebuildDomain, ShadowProxies } from "../src/domain-rebuild.ts";
import type { EntityExport, KinematicPart, KinematicPose } from "../src/domain-rebuild.ts";

const R = await getR();

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

test("a fresh ShadowProxies on a restored world drops proxies absent from a count-zero payload", () => {
  const original = makeWorld();
  stepN(original, 30);
  new ShadowProxies(R, original).step(shadowView(7, shadowPayload([[5, 1, 2, 3], [6, 4, 5, 6]])));
  assert.notEqual(original.proxyBody(7, 5), undefined);
  assert.notEqual(original.proxyBody(7, 6), undefined);

  const sw = new SnapWriter();
  original.snapshot(sw);
  const restored = new RapierDomainWorld(R, buildEntity, buildJoint);
  restored.restore(new SnapReader(sw.bytes().slice()));
  assert.notEqual(restored.proxyBody(7, 5), undefined, "the envelope carries the proxy table");

  new ShadowProxies(R, restored).step(shadowView(7, shadowPayload([])));
  assert.equal(restored.proxyBody(7, 5), undefined, "no instance-local history: the table is reconciled");
  assert.equal(restored.proxyBody(7, 6), undefined);

  new ShadowProxies(R, original).step(shadowView(7, shadowPayload([])));
  original.step();
  restored.step();
  assert.equal(restored.hash(), original.hash());
  const a = new SnapWriter();
  const b = new SnapWriter();
  original.snapshot(a);
  restored.snapshot(b);
  assert.deepStrictEqual(b.bytes().slice(), a.bytes().slice());
  original.sim.free();
  restored.sim.free();
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

// ---- Two domains A and B on a cell grid: two-peer rebuild, split/merge hash equality ----

/** Cells are 4 m wide along x, from x = -8: A owns cells 0-1 (x < 0), B owns cells 2-3. */
const GRID_ORIGIN_X = -8;
const GRID_CELL = 4;
const GRID_COLS = 4;
const SEED = 0x5eed;
const STEPS = 100;
const B_FIRST_ID = 101;
const JOINT_STACK = 0;
const JOINT_ROPE = 1;
const STACK_HALF = 0.6;
const ROPE_LENGTH = 4;

const SPEC_A: DomainSpec = { id: 1, kind: "seat", cells: [0, 1], seats: [0], replicas: [0, 1] };
const SPEC_B: DomainSpec = { id: 2, kind: "seat", cells: [2, 3], seats: [1], replicas: [0, 1] };
const SPEC_M: DomainSpec = { id: 1, kind: "seat", cells: [0, 1, 2, 3], seats: [0, 1], replicas: [0, 1] };

function cellOf(x: number): number {
  const col = Math.floor((x - GRID_ORIGIN_X) / GRID_CELL);
  return Math.min(GRID_COLS - 1, Math.max(0, col));
}

/** Test-local membership: the cell under the entity's translation is one of the spec's cells. */
function belongsTo(spec: DomainSpec): (e: EntityExport) => boolean {
  return (e) => spec.cells.includes(cellOf(e.translation.x));
}

function posParams(x: number, y: number, z: number): Uint8Array {
  const p = new Uint8Array(24);
  const dv = new DataView(p.buffer);
  dv.setFloat64(0, x, true);
  dv.setFloat64(8, y, true);
  dv.setFloat64(16, z, true);
  return p;
}

/** Every entity is a dynamic ball whose spawn position is its params; the ground is static level. */
const buildBall: DomainEntityBuilder = (_kind, params) => {
  const dv = new DataView(params.buffer, params.byteOffset, params.byteLength);
  const body = R.RigidBodyDesc.dynamic().setTranslation(dv.getFloat64(0, true), dv.getFloat64(8, true), dv.getFloat64(16, true));
  return { body, colliders: [R.ColliderDesc.ball(0.5).setFriction(0.7)] };
};

const buildDomainJoint: DomainJointBuilder = (world, kind, _params, a, b) => {
  const data = kind === JOINT_STACK
    ? R.JointData.spherical({ x: 0, y: STACK_HALF, z: 0 }, { x: 0, y: -STACK_HALF, z: 0 })
    : R.JointData.rope(ROPE_LENGTH, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  return world.createImpulseJoint(data, a, b, true);
};

function buildGround(world: RapierDomainWorld): void {
  world.sim.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [R.ColliderDesc.cuboid(20, 0.5, 20)]);
}

function freshDomain(): RapierDomainWorld {
  const w = new RapierDomainWorld(R, buildBall, buildDomainJoint);
  buildGround(w);
  return w;
}

interface TwoDomains {
  a: RapierDomainWorld;
  b: RapierDomainWorld;
  /** A's end and B's end of the joint that only a merged world can hold. */
  crossA: number;
  crossB: number;
  stackJoint: number;
}

/**
 * A: a jointed stack (ids 1, 2), a loose ball and the A end of the cross joint (x = -1.5).
 * B: from id 101, the B end of the cross joint (x = 1.5) and two loose balls. Offsets come from the seed.
 */
function buildTwoDomains(seed: number): TwoDomains {
  const rnd = mulberry32(seed);
  const jitter = (): number => (rnd() - 0.5) * 0.4;
  const a = freshDomain();
  const s0 = a.spawn(0, posParams(-5 + jitter(), 1, jitter()), 0);
  const s1 = a.spawn(0, posParams(-5 + jitter(), 1 + 2 * STACK_HALF, jitter()), 0);
  const stackJoint = a.join(s0, s1, JOINT_STACK, NO_PARAMS);
  a.spawn(0, posParams(-3 + jitter(), 1, 1 + jitter()), 0);
  const crossA = a.spawn(0, posParams(-1.5 + jitter(), 1, jitter()), 0);

  const b = freshDomain();
  const crossB = b.adopt(B_FIRST_ID, 0, posParams(1.5 + jitter(), 1, jitter()), 1);
  b.spawn(0, posParams(3 + jitter(), 1, -1 + jitter()), 1);
  b.spawn(0, posParams(5 + jitter(), 1.5, 1 + jitter()), 1);
  return { a, b, crossA, crossB, stackJoint };
}

function rebuildFrom(spec: DomainSpec, tick: number, sources: readonly Uint8Array[]): RapierDomainWorld {
  return rebuildDomain({
    R,
    spec,
    tick,
    sources: sources.map((s) => new SnapReader(s)),
    buildEntity: buildBall,
    buildJoint: buildDomainJoint,
    buildStatic: (w) => buildGround(w),
    belongs: belongsTo(spec),
  });
}

function ids(w: RapierDomainWorld): { entities: number[]; joints: number[] } {
  const m = merged(exportBytes(w));
  return { entities: m.entities.map((e) => e.id), joints: m.joints.map((j) => j.id) };
}

function assertReplicasAgree(p: RapierDomainWorld, q: RapierDomainWorld, what: string): void {
  assert.equal(p.tick, q.tick, `${what}: tick`);
  assert.equal(p.hash(), q.hash(), `${what}: hash`);
  assert.deepStrictEqual(exportBytes(p), exportBytes(q), `${what}: export`);
}

interface MergedPair {
  two: TwoDomains;
  /** Peer 1 and peer 2 replicas of the merged domain, each with the cross joint added after the merge. */
  m1: RapierDomainWorld;
  m2: RapierDomainWorld;
  crossJoint: number;
  sourceMax: number;
}

/** Both peers rebuild A+B; peer 2 receives the sources in the other order. Both then add the cross joint. */
function mergeOnTwoPeers(): MergedPair {
  const two = buildTwoDomains(SEED);
  stepN(two.a, STEPS);
  stepN(two.b, STEPS);
  const aBytes = exportBytes(two.a);
  const bBytes = exportBytes(two.b);
  const m1 = rebuildFrom(SPEC_M, two.a.tick, [aBytes, bBytes]);
  const m2 = rebuildFrom(SPEC_M, two.a.tick, [bBytes, aBytes]);
  const sourceMax = Math.max(...ids(two.a).entities, ...ids(two.b).entities);
  const crossJoint = m1.join(two.crossA, two.crossB, JOINT_ROPE, NO_PARAMS);
  assert.equal(m2.join(two.crossA, two.crossB, JOINT_ROPE, NO_PARAMS), crossJoint);
  return { two, m1, m2, crossJoint, sourceMax };
}

function freeAll(...worlds: RapierDomainWorld[]): void {
  for (const w of worlds) w.sim.free();
}

function split(m: RapierDomainWorld): [RapierDomainWorld, RapierDomainWorld] {
  const bytes = exportBytes(m);
  return [rebuildFrom(SPEC_A, m.tick, [bytes]), rebuildFrom(SPEC_B, m.tick, [bytes])];
}

test("two-peer rebuild: both peers merge A and B into the same domain and stay equal", () => {
  const { two, m1, m2, sourceMax } = mergeOnTwoPeers();
  assert.equal(m1.tick, two.a.tick);
  assertReplicasAgree(m1, m2, "merged at rebuild");
  const m = ids(m1);
  assert.deepStrictEqual(m.entities, [...ids(two.a).entities, ...ids(two.b).entities], "ascending ids of both sources");
  assert.ok(m.entities.every((id) => id <= sourceMax));
  assert.ok(m.joints.includes(two.stackJoint), "the joint inside A survives the merge under its id");
  stepN(m1, STEPS);
  stepN(m2, STEPS);
  assertReplicasAgree(m1, m2, "merged after stepping");
  freeAll(two.a, two.b, m1, m2);
});

test("split then merge agrees on two replicas of each domain", () => {
  const { two, m1, m2 } = mergeOnTwoPeers();
  stepN(m1, STEPS);
  stepN(m2, STEPS);
  const [a1, b1] = split(m1);
  const [a2, b2] = split(m2);
  assertReplicasAgree(a1, a2, "A at split");
  assertReplicasAgree(b1, b2, "B at split");
  assert.equal(ids(a1).entities.length + ids(b1).entities.length, ids(m1).entities.length, "every entity lands in one domain");
  for (const w of [a1, b1, a2, b2]) stepN(w, STEPS);
  assertReplicasAgree(a1, a2, "A after stepping");
  assertReplicasAgree(b1, b2, "B after stepping");

  const again1 = rebuildFrom(SPEC_M, a1.tick, [exportBytes(a1), exportBytes(b1)]);
  const again2 = rebuildFrom(SPEC_M, a2.tick, [exportBytes(b2), exportBytes(a2)]);
  assertReplicasAgree(again1, again2, "merged again");
  assert.deepStrictEqual(ids(again1).entities, ids(m1).entities);
  stepN(again1, STEPS);
  stepN(again2, STEPS);
  assertReplicasAgree(again1, again2, "merged again after stepping");
  freeAll(two.a, two.b, m1, m2, a1, b1, a2, b2, again1, again2);
});

test("the cross-domain joint is cut by the split, with the same joint ids on both replicas", () => {
  const { two, m1, m2, crossJoint } = mergeOnTwoPeers();
  assert.ok(ids(m1).joints.includes(crossJoint));
  const [a1, b1] = split(m1);
  const [a2, b2] = split(m2);
  assert.ok(ids(a1).entities.includes(two.crossA) && ids(b1).entities.includes(two.crossB), "each end stays in its domain");
  assert.deepStrictEqual(ids(a1).joints, [two.stackJoint], "A keeps only its inner joint");
  assert.deepStrictEqual(ids(b1).joints, []);
  assert.deepStrictEqual(ids(a2).joints, ids(a1).joints);
  assert.deepStrictEqual(ids(b2).joints, ids(b1).joints);
  freeAll(two.a, two.b, m1, m2, a1, b1, a2, b2);
});

test("ids are not reused: bodies and joints created after a rebuild get ids above every source id", () => {
  const { two, m1, m2, crossJoint, sourceMax } = mergeOnTwoPeers();
  assert.ok(crossJoint > two.stackJoint, "the joint added after the merge is above the source joint ids");
  const spawned = m1.spawn(0, posParams(0, 3, 0), 0);
  assert.ok(spawned > sourceMax, `spawned id ${spawned} must exceed ${sourceMax}`);

  // B never held A's ids, yet its counters continue above everything the merged source carried.
  const [a1, b1] = split(m2);
  const mergedMax = Math.max(...ids(m2).entities);
  const inB = b1.spawn(0, posParams(4, 3, 0), 1);
  assert.ok(inB > mergedMax, `B's new id ${inB} must exceed ${mergedMax}`);
  assert.ok(b1.join(two.crossB, inB, JOINT_STACK, NO_PARAMS) > crossJoint, "a new joint in B is above the cut joint id");
  assert.throws(() => b1.adopt(two.crossA, 0, posParams(0, 1, 0), 0), /never reused/);
  freeAll(two.a, two.b, m1, m2, a1, b1);
});

test("a zero-length shadow reader leaves the domain world unchanged", () => {
  const two = buildTwoDomains(SEED);
  stepN(two.a, STEPS);
  const before = new SnapWriter();
  two.a.snapshot(before);
  const hash = two.a.hash();
  const proxies = new ShadowProxies(R, two.a);
  const empty: ShadowView = { count: 2, fromDomain: (i) => (i === 0 ? SPEC_B.id : SPEC_M.id), reader: () => new SnapReader(new Uint8Array(0)) };
  proxies.step(empty);
  const after = new SnapWriter();
  two.a.snapshot(after);
  assert.equal(two.a.hash(), hash);
  assert.deepStrictEqual(after.bytes(), before.bytes());
  assert.equal(two.a.proxyBody(SPEC_B.id, two.crossB), undefined);
  freeAll(two.a, two.b);
});

test("the merge does not depend on source order or on which peer's exports it reads", () => {
  const { two, m1, m2 } = mergeOnTwoPeers();
  const aBytes = exportBytes(two.a);
  const bBytes = exportBytes(two.b);
  assert.deepStrictEqual(merged(exportBytes(m1)), mergeEntityStreams([new SnapReader(exportBytes(m2))]));
  const ab = mergeEntityStreams([new SnapReader(aBytes), new SnapReader(bBytes)]);
  const ba = mergeEntityStreams([new SnapReader(bBytes), new SnapReader(aBytes)]);
  assert.deepStrictEqual(ab, ba);
  freeAll(two.a, two.b, m1, m2);
});
