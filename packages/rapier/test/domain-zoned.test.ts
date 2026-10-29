import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DROP_WAIT_MS, DEFAULT_LOST_AFTER_MS, SnapReader, SnapWriter } from "@gamesaloon/rollback";
import { ZONE_DEFAULTS } from "@gamesaloon/rollback/zones";
import type { Assignment, DomainSpec, SleepEvent, ZoneSessionConfig } from "@gamesaloon/rollback/zones";
import { mergeEntityStreams } from "../src/domain-rebuild.ts";
import type { RapierDomainSim } from "../src/domain-sim.ts";
import { EMPTY, LEFT, RIGHT, MERGED, factory, shadow, snapshot, exported, shadowBytes } from "./domain-scenario.ts";
import { FRAME_MS, zonedSetup } from "./domain-scenario.ts";
import type { DirInput, ZonedRun } from "./domain-scenario.ts";

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

// ---- Zoned runs: NetSim peers, one ZoneSession each, replicas compare per-domain confirmed hashes.

/** Short epochs keep each run brief; leadTicks stays above maxPrediction + maxDelay. */
const EPOCHS = { epochTicks: 30, leadTicks: 25, handoffGraceTicks: 10 };
/** Quiet frames after the script, so the tail of every domain confirms. */
const SETTLE = 120;

interface Internals {
  cfg: ZoneSessionConfig<DirInput>;
  correct: (d: { spec: DomainSpec }, from: number, bytes: Uint8Array, smooth: boolean) => void;
  rejoinAt: Float64Array;
  awaitingSnapshot: boolean;
  current: Assignment;
  prevAssign: Assignment | null;
  stateFor: (id: number, tick: number) => { sim: object } | undefined;
}
const internals = (run: ZonedRun, p: number): Internals => run.sessions[p] as unknown as Internals;

/**
 * Steer from the state that steps the seat's ticks. Once epoch E is planned, `assignment` is E's, and a seat domain
 * whose cells change is a fresh state at spawn poses until S; before S the seat still runs in its old domain.
 */
function steerFromRunning(run: ZonedRun): void {
  run.seatSim = (peer, seat) => {
    const s = internals(run, peer), t = run.sessions[peer].stats.tick;
    const a = s.prevAssign && t < s.current.epoch * run.tuning.epochTicks ? s.prevAssign : s.current;
    const d = s.stateFor(a.seatDomain[seat], t);
    return d && "world" in d.sim ? d.sim as RapierDomainSim<DirInput> : undefined;
  };
}

/** Scripted frames with a per-frame hook, then the quiet settle. Returns the lowest live session tick at the settle. */
function play(run: ZonedRun, frames: number, hook?: (frame: number) => void): number {
  let scripted = 0;
  for (let f = 0; f < frames + SETTLE; f++) {
    if (f === frames) {
      run.quiet = true;
      scripted = Math.min(...run.sessions.filter((_, p) => run.alive[p]).map((s) => s.stats.tick));
    }
    hook?.(f);
    run.frame();
  }
  return scripted;
}

/** No permanent stall: every live peer confirms each domain it replicates past the scripted frames. */
function assertConfirmedPast(run: ZonedRun, tick: number, label: string): void {
  for (let p = 0; p < run.sessions.length; p++) {
    if (!run.alive[p]) continue;
    const s = run.sessions[p];
    for (const spec of s.assignment.domains) {
      if (!s.domain(spec.id)) continue;
      const c = s.stats.confirmedTick[spec.id];
      assert.ok(c >= tick, `${label}: peer ${p} domain ${spec.id} confirmed ${c} < ${tick}`);
    }
  }
}

type EpochLog = Map<number, Assignment>;

function watchEpochs(run: ZonedRun, log: EpochLog[]): void {
  run.sessions.forEach((s, p) => {
    if (run.alive[p] && !log[p].has(s.assignment.epoch)) log[p].set(s.assignment.epoch, s.assignment);
  });
}

/** The first epoch at or after `from` whose seatDomain satisfies `ok`, or -1. */
function firstEpoch(log: EpochLog, from: number, ok: (sd: Int32Array) => boolean): number {
  for (const [e, a] of [...log].sort((x, y) => x[0] - y[0])) if (e >= from && ok(a.seatDomain)) return e;
  return -1;
}

/** Records every bot input of one seat with its driving peer and tick. */
function spyBots(run: ZonedRun, seat: number): { peer: number; tick: number }[] {
  const bots: { peer: number; tick: number }[] = [];
  for (let p = 0; p < run.sessions.length; p++) {
    const cfg = internals(run, p).cfg, botInput = cfg.botInput!;
    cfg.botInput = (s, tick, out) => {
      if (s === seat) bots.push({ peer: p, tick });
      botInput(s, tick, out);
    };
  }
  return bots;
}

test("zoned: two peers under jitter roll back and agree on every domain", () => {
  const run = zonedSetup({ peers: 2, seed: 3, link: { rttMs: 80, jitterMs: 20 }, tuning: EPOCHS });
  const frames = 360;
  const scripted = play(run, frames);
  const kinds = run.sessions[0].assignment.domains.map((d) => d.kind);
  assert.ok(kinds.includes("seat") && kinds.includes("field") && kinds.includes("global"), `domains ${kinds}`);
  assert.ok(run.sessions.every((s) => s.stats.rollbacks > 0), "jitter makes both peers roll back");
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples() > 0, "replicas compared hashes");
  assertConfirmedPast(run, scripted, "two peers");
});

test("zoned: four peers merge into one domain, split again, and agree through both boundaries", () => {
  const K = EPOCHS.epochTicks;
  const meet = 2 * K, part = 12 * K, frames = 22 * K;
  // A 2x2 block of cells away from the pit and the field; the start cells are rExit apart or more.
  const block = [18, 19, 27, 26];
  let start: number[] = [];
  const run = zonedSetup({
    peers: 4, seed: 4, tuning: EPOCHS,
    // The lowest cpu class whose capacity holds all four seats, so no capacity split cuts the merged component.
    classes: { cpuClass: ZONE_DEFAULTS.capacityByCpuClass.findIndex((c) => c >= block.length) },
    movement: (seat, frame) => frame >= meet && frame < part ? block[seat] : start[seat],
  });
  steerFromRunning(run);
  start = block.map((_, seat) => run.hooks[0].seatCell(seat));
  const log: EpochLog[] = run.sessions.map(() => new Map());
  const scripted = play(run, frames, () => watchEpochs(run, log));
  const all = (sd: Int32Array): boolean => sd[0] === sd[1] && sd[1] === sd[2] && sd[2] === sd[3];
  const apart = (sd: Int32Array): boolean => new Set(sd).size === sd.length;
  const sep = firstEpoch(log[0], 1, apart);
  assert.ok(sep >= 0, "the seats start in separate domains");
  const merged = firstEpoch(log[0], sep, all);
  assert.ok(merged > sep, "the seats merge at a boundary");
  const split = firstEpoch(log[0], merged, apart);
  assert.ok(split > merged, "the seats split at a later boundary");
  for (const l of log) {
    assert.deepEqual([...l.get(merged)!.seatDomain], [1, 1, 1, 1], "merged domain id is 1 + the lowest seat");
    assert.deepEqual(l.get(merged)!.domains.find((d) => d.id === 1)!.seats, [0, 1, 2, 3]);
    assert.deepEqual([...l.get(split)!.seatDomain], [1, 2, 3, 4], "each seat back in its own domain");
  }
  assert.deepEqual(run.mismatches(), []);
  for (const [domain, epoch] of [[1, merged], [2, split]]) {
    assert.ok(run.confirmed.filter((c) => c.get(domain)?.has(epoch * K + K - 1)).length >= 2, `domain ${domain} compared after epoch ${epoch}`);
  }
  assertConfirmedPast(run, scripted, "merge and split");
});

/** Every seat holds its start cell, so the control words, and with them the assignments, stay put. */
function pinned(opts: Omit<Parameters<typeof zonedSetup>[0], "movement">): ZonedRun {
  let start: number[] = [];
  const run = zonedSetup({ ...opts, movement: (seat) => start[seat] });
  steerFromRunning(run);
  start = Array.from({ length: run.roster.seatCount }, (_, seat) => run.hooks[0].seatCell(seat));
  return run;
}

const LINK = { rttMs: 40, jitterMs: 4 };

test("zoned: a checkpoint disagreement rolls every replica back to the agreed keyframe", () => {
  const run = pinned({ peers: 3, seed: 7, link: LINK, tuning: EPOCHS });
  const K = run.tuning.epochTicks, corruptFrame = 150, frames = 480;
  const a = run.sessions[0].assignment;
  const spec = a.domains.find((d) => d.id === a.seatDomain[1])!;
  assert.equal(run.tuning.costClass[spec.kind], "checkpoint", "scenario: the seat domain has the class under test");
  const victim = spec.replicas[spec.replicas.length - 1];
  assert.notEqual(victim, spec.replicas[0], "scenario: the victim is not the producer");
  const corrections: { peer: number; from: number; smooth: boolean; tick: number }[] = [];
  for (let p = 0; p < run.sessions.length; p++) {
    const s = internals(run, p), correct = s.correct.bind(s);
    s.correct = (d, from, bytes, smooth) => {
      if (d.spec.id === spec.id) corrections.push({ peer: p, from, smooth, tick: run.sessions[p].stats.tick });
      correct(d, from, bytes, smooth);
    };
  }
  let ct = -1;
  const scripted = play(run, frames, (frame) => {
    if (frame !== corruptFrame) return;
    const s = run.sessions[victim];
    ct = s.domain(spec.id)!.sim.tick;
    assert.ok(s.debugCorrupt(spec.id, (sim) => {
      const w = (sim as RapierDomainSim<DirInput>).world;
      w.sim.body(w.bodyOf(run.hooks[victim].seatEntity(1))).applyImpulse({ x: 1, y: 0, z: 0 }, true);
    }));
  });
  assert.ok(ct > 0, "corruption ran");
  assert.ok(run.sessions[victim].stats.desyncs > 0, "the victim entered an episode");
  const kf = run.tuning.keyframeEvery * K;
  for (const p of spec.replicas) {
    const c = corrections.find((x) => x.peer === p);
    assert.ok(c && !c.smooth && c.from % kf === 0 && c.from <= ct, `replica ${p} rolls back to the last agreed keyframe`);
  }
  const done = Math.max(...corrections.map((x) => x.tick));
  for (const m of run.mismatches()) {
    assert.equal(m.domain, spec.id, "disagreement stays in the corrupted domain");
    assert.ok(m.peers.includes(victim) && m.tick > ct && m.tick < done, `disagreement at ${m.tick} lies inside the episode (${ct}, ${done})`);
  }
  // The episode's samples of the victim were replaced by the producer's snapshot; everything else is compared.
  const ticks = run.confirmed[victim].get(spec.id)!;
  for (const tick of [...ticks.keys()]) if (tick > ct && tick < done) ticks.delete(tick);
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples(done) > 0, "replicas compared hashes after the episode");
  assertConfirmedPast(run, scripted, "checkpoint");
});

test("zoned: a dropped peer's seat is driven by its bot host and the remaining replicas agree", () => {
  const run = pinned({ peers: 3, seed: 8, link: LINK, tuning: EPOCHS });
  const gone = 2, seat = run.roster.peers[gone].seats[0], dropFrame = 120, frames = 600;
  const bots = spyBots(run, seat);
  const reported: { peer: number; lost: number; tick: number }[] = [];
  for (let p = 0; p < run.sessions.length; p++) run.sessions[p].onPeerLost = (lost, tick) => { reported.push({ peer: p, lost, tick }); };
  // The others stall on the silent peer until they drop it, so ticks trail frames.
  const scripted = play(run, frames, (frame) => {
    if (frame === dropFrame) run.drop(gone);
  });
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples() > 0, "replicas compared hashes");
  for (let p = 0; p < run.sessions.length; p++) {
    if (p === gone) continue;
    assert.ok(reported.some((r) => r.peer === p && r.lost === gone), `peer ${p} reported the drop through onPeerLost`);
    assert.deepEqual(run.sessions[p].stats.lostPeers, [gone], `peer ${p} lists the lost peer`);
  }
  const from = Math.min(...reported.map((r) => r.tick));
  assert.ok(bots.length > 0 && bots.every((b) => b.peer !== gone && b.tick >= from), "a live peer drives the lost seat from the agreed drop tick");
  // Bot hosts are per domain (the global domain elects its own); the seat domain's replicas record theirs in the sim.
  let host = -1, replicas = 0;
  for (let p = 0; p < run.sessions.length; p++) {
    if (p === gone) continue;
    const sim = run.seatSim(p, seat);
    if (!sim) continue;
    replicas++;
    if (host < 0) host = sim.host[seat];
    assert.notEqual(host, gone, "a live peer hosts the seat");
    assert.equal(sim.host[seat], host, `peer ${p} sees peer ${host} hosting the seat`);
    assert.equal(sim.bot[seat], 1, `peer ${p} marks the seat as bot driven`);
  }
  assert.ok(replicas >= 2, "the seat domain keeps two replicas");
  // The host is elected per epoch; some live peer drives every tick, and the current host the latest ones.
  const driven = new Set(bots.map((b) => b.tick));
  for (let t = from; t < scripted; t++) assert.ok(driven.has(t), `a bot drives the seat at tick ${t}`);
  const last = Math.max(...driven);
  assert.ok(last >= scripted && bots.some((b) => b.peer === host && b.tick === last), `peer ${host} drives the seat to the end`);
  assertConfirmedPast(run, scripted, "drop");
});

test("zoned: a rejoining peer observes, takes its seat back at an epoch boundary, and agrees", () => {
  const run = pinned({ peers: 3, seed: 9, link: LINK, tuning: EPOCHS });
  const K = run.tuning.epochTicks, gone = 2, seat = run.roster.peers[gone].seats[0], dropFrame = 120;
  const cfg = internals(run, 0).cfg;
  // Longer than lostAfterMs and dropWaitMs together, so the others drop the peer first.
  const rejoinFrame = dropFrame + Math.ceil(((cfg.lostAfterMs ?? DEFAULT_LOST_AFTER_MS) + (cfg.dropWaitMs ?? DEFAULT_DROP_WAIT_MS)) / FRAME_MS) + K;
  const frames = rejoinFrame + 12 * K;
  const bots = spyBots(run, seat);
  let R = Infinity, observed = false, adopted = Infinity;
  const scripted = play(run, frames, (frame) => {
    if (frame === dropFrame) run.drop(gone);
    if (frame === rejoinFrame) {
      assert.deepEqual(run.sessions[0].stats.lostPeers, [gone], "the others dropped the peer");
      run.rejoin(gone);
    }
    if (frame <= rejoinFrame) return;
    const at = internals(run, 0).rejoinAt[gone];
    if (R === Infinity && at !== Infinity) R = at;
    const s = internals(run, gone);
    if (s.awaitingSnapshot) observed = true;
    else if (observed && adopted === Infinity) adopted = s.rejoinAt[gone];
  });
  assert.ok(observed, "the returning peer resynced as an observer");
  assert.ok(R !== Infinity && R % K === 0, `the switch is an epoch boundary (${R})`);
  assert.equal(adopted, R, "both sides switch at the same boundary");
  const a = run.sessions[0].assignment;
  for (let p = 0; p < run.sessions.length; p++) {
    const b = run.sessions[p].assignment;
    assert.equal(b.epoch, a.epoch, `peer ${p} epoch`);
    assert.deepEqual(b.domains, a.domains, `peer ${p} domains`);
    assert.equal(b.seatHost[seat], gone, `peer ${p} sees the owner driving its seat`);
    assert.deepEqual(run.sessions[p].stats.lostPeers, [], `peer ${p}: nobody stays lost`);
  }
  const d = run.sessions[gone].domain(a.seatDomain[seat]);
  assert.ok(d && d.start >= R, "the returning peer's seat domain starts at or after the switch");
  assert.ok(bots.length > 0 && bots.every((b) => b.tick < R), "the bot drives the seat until the switch only");
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples(R) > 0, "replicas compared hashes after the switch");
  assertConfirmedPast(run, scripted, "rejoin");
});

test("zoned: six peers agree while a seat takes over the field domain and releases it", () => {
  const K = EPOCHS.epochTicks, enter = 2 * K, leave = 10 * K, frames = 14 * K, walker = 5;
  let start: number[] = [];
  let field = -1;
  const run = zonedSetup({
    peers: 6, seed: 6, link: LINK, tuning: EPOCHS,
    movement: (seat, frame) => seat === walker && frame >= enter && frame < leave ? field : start[seat],
  });
  steerFromRunning(run);
  field = run.tuning.fieldCells[0];
  start = Array.from({ length: run.roster.seatCount }, (_, seat) => run.hooks[0].seatCell(seat));
  const log: EpochLog[] = run.sessions.map(() => new Map());
  const scripted = play(run, frames, () => watchEpochs(run, log));
  const fieldId = 1 + run.roster.seatCount + field;
  const owns = (a: Assignment): number => a.domains.find((d) => d.cells.includes(field))?.id ?? -1;
  const epochs = [...log[0]].sort((x, y) => x[0] - y[0]).map(([, a]) => a);
  assert.equal(owns(epochs[0]), fieldId, "the field starts as its own field domain");
  const taken = epochs.findIndex((a) => owns(a) === a.seatDomain[walker]);
  assert.ok(taken > 0, "the walking seat's domain takes the field cell");
  const back = epochs.findIndex((a, i) => i > taken && owns(a) === fieldId);
  assert.ok(back > taken, "the field domain comes back once the seat leaves");
  assert.deepEqual(run.mismatches(), []);
  // The field entities survive both rebuilds, and the field replicas compared hashes after the release.
  const replicas = run.sessions.filter((s) => s.domain(fieldId) && s.stats.confirmedTick[fieldId] !== undefined);
  assert.ok(replicas.length >= 2, "the field domain has replicas again");
  for (const s of replicas) {
    const sim = s.domain(fieldId)!.sim as RapierDomainSim<DirInput>;
    assert.doesNotThrow(() => sim.world.bodyOf(run.hooks[0].plankId), "the plank is carried over by id");
  }
  const peers = run.confirmed.filter((c) => c.get(fieldId)?.has(epochs[back].epoch * K + K - 1)).length;
  assert.ok(peers >= 2, "field replicas compared hashes after the release");
  assertConfirmedPast(run, scripted, "six peers");
});
