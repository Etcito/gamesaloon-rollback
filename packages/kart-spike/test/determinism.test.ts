import { test } from "node:test";
import assert from "node:assert";
import { initRapier } from "@gamesaloon/rollback-rapier";
import { KartRapierSim } from "../src/kartSim.ts";
import { ChaosBots, recordRun } from "../src/harness.ts";
import { loadReference, loadTracks } from "../src/run.ts";
import { gridSlots } from "../src/track.ts";

const R = await initRapier();
const tracks = loadTracks();
const ref = loadReference();
const track = tracks.circuit;

function build(n = 8, extra: object = {}): KartRapierSim {
  return new KartRapierSim(R, { track, slots: gridSlots(track, n), dt: 1 / 60, phys: ref.phys, tuning: extra });
}

function replay(sim: KartRapierSim, hist: number[][], from: number, to: number): void {
  for (let t = from; t < to; t++) sim.step(hist[t]);
}

test("8 karts, trimesh track: two instances stay bit-identical over 5000 steps", () => {
  const A = build();
  const B = build();
  const bots = new ChaosBots(8, track, ref.phys.topSpeed, 7);
  assert.equal(A.hash(), B.hash(), "identical at tick 0");
  const hashes: number[] = [];
  const events = { drifts: 0, boosts: 0, maxStage: 0 };
  let wasDrift = 0, wasBoost = 0;
  const hist = recordRun(A, bots, 5000, (t) => {
    if (t % 50 === 0) hashes.push(A.hash());
    for (let i = 0; i < 8; i++) {
      const d = A.mech[i * 9], b = A.mech[i * 9 + 5] > 0 ? 1 : 0;
      if (d && !((wasDrift >> i) & 1)) events.drifts++;
      if (b && !((wasBoost >> i) & 1)) events.boosts++;
      wasDrift = d ? wasDrift | (1 << i) : wasDrift & ~(1 << i);
      wasBoost = b ? wasBoost | (1 << i) : wasBoost & ~(1 << i);
      events.maxStage = Math.max(events.maxStage, A.mech[i * 9 + 3]);
    }
  });
  let k = 0;
  for (let t = 0; t < 5000; t++) {
    B.step(hist[t]);
    if ((t + 1) % 50 === 0) assert.equal(B.hash(), hashes[k++], `diverged at tick ${t + 1}`);
  }
  assert.equal(k, 100);
  assert.deepEqual(B.takeSnapshot(), A.takeSnapshot(), "final state identical byte for byte");
  // the run must have been eventful, otherwise the test proves nothing
  console.log(`  final hash ${A.hash().toString(16)}, drifts started ${events.drifts}, boosts ${events.boosts}, max drift stage ${events.maxStage}`);
  assert.ok(events.drifts > 5 && events.boosts > 0, "the scripted run contains drifts and boosts");
  A.free(); B.free();
});

test("snapshot at 1000, resim to 1600, restore + resim: identical (same instance, fresh instance)", () => {
  const A = build();
  const bots = new ChaosBots(8, track, ref.phys.topSpeed, 11);
  const hist = recordRun(A, bots, 1000);
  const snap = A.takeSnapshot();
  const h1000 = A.hash();
  // continue recording the next 600 ticks from the same state
  const hist2 = recordRun(A, bots, 600);
  const h1600 = A.hash();
  const bytes1600 = A.takeSnapshot();
  for (let rep = 0; rep < 3; rep++) {
    A.restoreSnapshot(snap);
    assert.equal(A.tick, 1000);
    assert.equal(A.hash(), h1000, "restore reproduces the snapshot hash");
    replay(A, hist2, 0, 600);
    assert.equal(A.hash(), h1600, `rollback #${rep} diverged`);
  }
  assert.deepEqual(A.takeSnapshot(), bytes1600);
  const C = build();
  C.restoreSnapshot(snap);
  assert.equal(C.hash(), h1000);
  replay(C, hist2, 0, 600);
  assert.equal(C.hash(), h1600, "fresh instance restored from the bytes");
  // snapshot -> restore -> snapshot is byte-identical
  const s2 = C.takeSnapshot();
  C.restoreSnapshot(s2);
  assert.deepEqual(C.takeSnapshot(), s2);
  A.free(); C.free();
});

test("restore also rolls back the game-side drift/boost record (it is part of the snapshot)", () => {
  const A = build(2);
  const bots = new ChaosBots(2, track, ref.phys.topSpeed, 3);
  recordRun(A, bots, 300);
  const before = Array.from(A.mech);
  const snap = A.takeSnapshot();
  A.requestBoost(0, "mushroom");
  recordRun(A, bots, 20);
  assert.notDeepEqual(Array.from(A.mech), before);
  A.restoreSnapshot(snap);
  assert.deepEqual(Array.from(A.mech), before);
  A.free();
});

test("a different input at tick 1200 changes the hash (the check can fail)", () => {
  const A = build(), B = build();
  const bots = new ChaosBots(8, track, ref.phys.topSpeed, 5);
  const hist = recordRun(A, bots, 1300);
  replay(B, hist, 0, 1200);
  const alt = hist[1200].slice();
  alt[3] ^= 1 << 12; // nudge kart 3's steer code
  B.step(alt);
  A.free();
  const A2 = build();
  replay(A2, hist, 0, 1201);
  assert.notEqual(A2.hash(), B.hash());
  A2.free(); B.free();
});

test("flat-ground variant is deterministic too (cost baseline uses it)", () => {
  const A = build(8, { trackMode: "flat" }), B = build(8, { trackMode: "flat" });
  const bots = new ChaosBots(8, track, ref.phys.topSpeed, 9);
  const hist = recordRun(A, bots, 1500);
  replay(B, hist, 0, 1500);
  assert.equal(A.hash(), B.hash());
  A.free(); B.free();
});
