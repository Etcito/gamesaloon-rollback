import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { SleepEvent } from "@gamesaloon/rollback/zones";
import { mergeEntityStreams } from "../src/domain-rebuild.ts";
import { EMPTY, LEFT, RIGHT, MERGED, factory, shadow, snapshot, exported, shadowBytes } from "./domain-scenario.ts";

test("DOMAIN_SNAPSHOT into a fresh sim removes restored proxies on a count-zero shadow", (t) => {
  const original = factory.create(LEFT, 0);
  const restored = factory.create(LEFT, 0);
  t.after(() => { original.world.sim.free(); restored.world.sim.free(); });
  const payload = new SnapWriter();
  payload.u16(1);
  payload.u32(5);
  for (const v of [4, 2, 0, 0, 0, 0, 1]) payload.f64(v);
  original.step([0], shadow(RIGHT.id, payload.bytes()));
  original.seatHost(0, 1, true);
  restored.restore(new SnapReader(snapshot(original)));
  assert.notEqual(restored.world.proxyBody(RIGHT.id, 5), undefined);
  assert.equal(restored.host[0], 1);
  assert.equal(restored.bot[0], 1);

  // No SHADOW received preserves the restored table; an arrived count-zero payload clears it.
  original.step([0], shadow(RIGHT.id, EMPTY));
  restored.step([0], shadow(RIGHT.id, EMPTY));
  assert.notEqual(restored.world.proxyBody(RIGHT.id, 5), undefined);
  const zero = new SnapWriter();
  zero.u16(0);
  original.step([0], shadow(RIGHT.id, zero.bytes()));
  restored.step([0], shadow(RIGHT.id, zero.bytes()));
  assert.equal(restored.world.proxyBody(RIGHT.id, 5), undefined);
  assert.equal(original.world.proxyBody(RIGHT.id, 5), undefined);
  assert.equal(restored.hash(), original.hash());
  assert.deepEqual(snapshot(restored), snapshot(original));
});

test("checkpoint restore replays Rapier inputs, host state and kinematic tick poses", (t) => {
  const sim = factory.create(LEFT, 12);
  t.after(() => sim.world.sim.free());
  sim.seatHost(0, 1, true);
  sim.step([0], shadow());
  const checkpoint = snapshot(sim);
  for (let i = 0; i < 30; i++) sim.step([i % 2 ? 0.01 : -0.01], shadow());
  const expected = snapshot(sim);
  const expectedHash = sim.hash();
  sim.seatHost(0, 0, false);
  sim.restore(new SnapReader(checkpoint));
  assert.equal(sim.tick, 13);
  assert.equal(sim.host[0], 1);
  assert.equal(sim.bot[0], 1);
  sim.beginResim();
  assert.equal(sim.resimulating, true);
  for (let i = 0; i < 30; i++) sim.step([i % 2 ? 0.01 : -0.01], shadow());
  sim.endResim();
  assert.equal(sim.resimulating, false);
  assert.equal(sim.hash(), expectedHash);
  assert.deepEqual(snapshot(sim), expected);
  assert.equal(sim.world.sim.body(2).translation().x, sim.tick);
});

test("reset is deterministic from spec and tick after the old world diverges", (t) => {
  const old = factory.create(LEFT, 0);
  old.step([1], shadow());
  const a = factory.reset(LEFT, 60);
  const b = factory.create(LEFT, 60);
  t.after(() => { for (const sim of [old, a, b]) sim.world.sim.free(); });
  assert.equal(a.tick, 60);
  assert.deepEqual(snapshot(a), snapshot(b));
  for (let i = 0; i < 30; i++) {
    a.step([0], shadow());
    b.step([0], shadow());
    assert.equal(a.hash(), b.hash());
  }
});

test("factory merge and split keep stable ids and replica hashes across source order", (t) => {
  const left = factory.create(LEFT, 0);
  const right = factory.create(RIGHT, 0);
  const sims = [left, right];
  t.after(() => { for (const sim of sims) sim.world.sim.free(); });
  for (let i = 0; i < 20; i++) {
    const a = shadowBytes(left);
    const b = shadowBytes(right);
    left.step([0], shadow(RIGHT.id, b));
    right.step([0], shadow(LEFT.id, a));
  }
  const sources = [exported(left), exported(right)];
  const a = factory.rebuild(MERGED, left.tick, sources.map((b) => new SnapReader(b)));
  const b = factory.rebuild(MERGED, left.tick, sources.slice().reverse().map((b) => new SnapReader(b)));
  sims.push(a, b);
  assert.equal(a.hash(), b.hash());
  assert.deepEqual(mergeEntityStreams([new SnapReader(exported(a))]).entities.map((e) => e.id), [1, 2]);
  a.world.join(1, 2, 0, EMPTY);
  b.world.join(1, 2, 0, EMPTY);
  for (let i = 0; i < 20; i++) {
    a.step([0, 0], shadow());
    b.step([0, 0], shadow());
    assert.equal(a.hash(), b.hash());
  }
  for (const spec of [LEFT, RIGHT]) {
    const x = factory.rebuild(spec, a.tick, [new SnapReader(exported(a))]);
    const y = factory.rebuild(spec, b.tick, [new SnapReader(exported(b))]);
    sims.push(x, y);
    const records = mergeEntityStreams([new SnapReader(exported(x))]);
    assert.deepEqual(records.entities.map((e) => e.id), spec.seats.map((seat) => seat + 1));
    assert.deepEqual(records.joints, []);
    x.step([0], shadow());
    y.step([0], shadow());
    assert.equal(x.hash(), y.hash());
  }
});

test("sleep, far, shadow and event payloads use the domain's entity state", (t) => {
  const sim = factory.create(LEFT, 0);
  t.after(() => sim.world.sim.free());
  sim.world.sim.body(sim.world.bodyOf(1)).sleep();
  sim.step([0], shadow());
  const transitions: SleepEvent[] = [];
  sim.sleepEvents(transitions);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].asleep, true);
  const pose = new SnapWriter();
  assert.equal(sim.sleepPose(1, pose), true);
  assert.deepEqual(pose.bytes(), transitions[0].pose);
  assert.equal(sim.sleepPose(999, pose), false);
  const far = new SnapWriter();
  sim.far(far, 1);
  assert.equal(new SnapReader(far.bytes()).u16(), 0);
  const boundary = new SnapReader(shadowBytes(sim));
  assert.equal(boundary.u16(), 1);
  assert.equal(boundary.u32(), 1);
  const events = new SnapWriter();
  sim.events(events);
  const r = new SnapReader(events.bytes());
  assert.equal(r.u16(), 1);
  assert.equal(r.i32(), sim.tick);
  sim.step([0.1], shadow());
  sim.sleepEvents(transitions);
  assert.equal(transitions[0].asleep, false);
});
