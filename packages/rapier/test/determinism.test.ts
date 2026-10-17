import { test } from "node:test";
import assert from "node:assert";
import { applyInputs, buildScenario, getR, run, tickOnce } from "./scenario.ts";
import { RapierWorldSim, fnv1a32 } from "../src/index.ts";

const R = await getR();

test("(a) two independent worlds, same inputs: hash-identical over 5000 steps", () => {
  const A = buildScenario(R, 200);
  const B = buildScenario(R, 200);
  assert.equal(A.sim.hash(), B.sim.hash(), "identical at tick 0");
  let checks = 0;
  for (let t = 1; t <= 5000; t++) {
    tickOnce(A);
    tickOnce(B);
    if (t % 50 === 0 || t === 5000) {
      assert.equal(A.sim.hash(), B.sim.hash(), `diverged at tick ${t}`);
      checks++;
    }
  }
  console.log(`  (a) ${checks} hash comparisons, final hash ${A.sim.hash().toString(16)}`);
  // bytes, not just the 32-bit hash
  assert.deepEqual(A.sim.takeSnapshot(), B.sim.takeSnapshot());
  A.sim.free();
  B.sim.free();
});

test("(b) snapshot at N, run to N+120, restore, rerun: identical hash (also across instances)", () => {
  const A = buildScenario(R, 200);
  run(A, 300);
  const snap = A.sim.takeSnapshot();
  const hN = A.sim.hash();
  run(A, 120);
  const h1 = A.sim.hash();
  const bytes1 = A.sim.takeSnapshot();

  // same instance, several rollbacks in a row
  for (let r = 0; r < 5; r++) {
    A.sim.restoreSnapshot(snap);
    assert.equal(A.sim.tick, 300);
    assert.equal(A.sim.hash(), hN, "restore reproduces the snapshot hash");
    run(A, 120);
    assert.equal(A.sim.hash(), h1, `rollback #${r} diverged`);
  }
  assert.deepEqual(A.sim.takeSnapshot(), bytes1);

  // a brand new sim (fresh World) restored from the same bytes
  const C = buildScenario(R, 1); // different content on purpose
  C.sim.restoreSnapshot(snap);
  C.dynamic.length = 0;
  C.dynamic.push(...A.dynamic);
  assert.equal(C.sim.hash(), hN);
  run(C, 120);
  assert.equal(C.sim.hash(), h1);
  console.log(`  (b) hash@300=${hN.toString(16)} hash@420=${h1.toString(16)}, snapshot ${snap.length} bytes`);
  A.sim.free();
  C.sim.free();
});

test("(b2) restore at every 8th tick of a window, sleeping + moving bodies mixed", () => {
  const A = buildScenario(R, 200);
  const snaps = new Map<number, Uint8Array>();
  const hashes = new Map<number, number>();
  for (let t = 0; t < 600; t++) {
    if (t % 8 === 0) {
      snaps.set(t, A.sim.takeSnapshot());
      hashes.set(t, A.sim.hash());
    }
    tickOnce(A);
  }
  const finalHash = A.sim.hash();
  for (const t of [0, 8, 96, 232, 400, 592]) {
    A.sim.restoreSnapshot(snaps.get(t)!);
    assert.equal(A.sim.hash(), hashes.get(t));
    run(A, 600 - t);
    assert.equal(A.sim.hash(), finalHash, `restore@${t} then replay diverged`);
  }
  A.sim.free();
});

test("(e) adding/removing bodies between snapshots restores correctly", () => {
  const S = buildScenario(R, 50);
  const { sim } = S;
  const mk = () =>
    sim.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 8, 0), [R.ColliderDesc.ball(0.4)]);
  run(S, 60);
  const snapA = sim.takeSnapshot();
  const idsA = sim.ids();
  const hashA = sim.hash();

  // timeline 1: remove 3 bodies, add 2, add+remove 1, step
  const script = () => {
    sim.removeBody(S.dynamic[3]);
    sim.removeBody(S.dynamic[10]);
    sim.removeBody(S.dynamic[11]);
    const n1 = mk();
    const n2 = mk();
    const n3 = mk();
    sim.removeBody(n3);
    run(S, 40);
    return [n1, n2, n3];
  };
  const created1 = script();
  const hashAfter = sim.hash();
  const snapB = sim.takeSnapshot();
  const idsB = sim.ids();
  assert.ok(!idsB.includes(S.dynamic[3]));
  assert.ok(idsB.includes(created1[0]));

  // roll back to A: removed bodies are back, added ones are gone, handles re-linked
  sim.restoreSnapshot(snapA);
  assert.deepEqual(sim.ids(), idsA);
  assert.equal(sim.hash(), hashA);
  assert.ok(sim.hasBody(S.dynamic[3]) && !sim.hasBody(created1[0]));
  for (const id of idsA) sim.body(id).translation(); // every id still resolves

  // replay the same script: same ids are handed out again, same final state
  const created2 = script();
  assert.deepEqual(created2, created1, "id allocation is restored (nextId is in the snapshot)");
  assert.equal(sim.hash(), hashAfter, "replayed add/remove timeline is bit-identical");

  // roll forward-ish: restore B then A then B
  sim.restoreSnapshot(snapB);
  assert.deepEqual(sim.ids(), idsB);
  assert.equal(sim.hash(), fnv1a32(snapB));
  sim.restoreSnapshot(snapA);
  assert.deepEqual(sim.ids(), idsA);
  sim.free();
});

test("different body insertion order => different state (order is part of the sim)", () => {
  const mkSim = (flip: boolean) => {
    const s = new RapierWorldSim(R);
    const a = () => s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0), [R.ColliderDesc.ball(0.5)]);
    const b = () => s.createBody(R.RigidBodyDesc.dynamic().setTranslation(0.3, 1, 0), [R.ColliderDesc.ball(0.5)]);
    if (flip) { b(); a(); } else { a(); b(); }
    s.createBody(R.RigidBodyDesc.fixed(), [R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0)]);
    for (let i = 0; i < 100; i++) s.step();
    return s.hash();
  };
  assert.equal(mkSim(false), mkSim(false));
  assert.notEqual(mkSim(false), mkSim(true));
});

// keep applyInputs referenced (documented entry point for users of the scenario)
void applyInputs;
