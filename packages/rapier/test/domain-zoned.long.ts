// Long zoned Rapier runs: the domain-zoned cases over thousands of frames, with repeated merge and split cycles,
// checkpoint disagreements, drops with takeover and rejoins. npm test does not discover this file; a programmatic card
// runs one case per command, chosen by DOMAIN_LONG_CASE. Nothing is timed: every case asserts zero hash mismatches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DROP_WAIT_MS, DEFAULT_LOST_AFTER_MS } from "@gamesaloon/rollback";
import { ZONE_DEFAULTS } from "@gamesaloon/rollback/zones";
import type { Assignment, DomainSpec, ZoneSessionConfig } from "@gamesaloon/rollback/zones";
import type { LinkOptions } from "@gamesaloon/rollback/netsim";
import type { RapierDomainSim } from "../src/domain-sim.ts";
import { FRAME_MS, MAX_ZONED_PEERS, zonedSetup } from "./domain-scenario.ts";
import type { DirInput, DomainScenarioOptions, ZonedOptions, ZonedRun } from "./domain-scenario.ts";
import { mulberry32 } from "./scenario.ts";

/** Short epochs give many boundaries per run; leadTicks stays above maxPrediction + maxDelay. */
const EPOCHS = { epochTicks: 30, leadTicks: 25, handoffGraceTicks: 10 };
const K = EPOCHS.epochTicks;
/** Quiet frames after the script, so the tail of every domain confirms. */
const SETTLE = 240;
/** Frames per movement phase: long enough to travel, wait out minimum residence and reach the next boundary. */
const PHASE = 16 * K;
const CYCLES = 4;
const LINK: LinkOptions = { rttMs: 40, jitterMs: 4 };
const JITTER: LinkOptions = { rttMs: 80, jitterMs: 20 };
/** Link classes drawn per unordered peer pair for the mixed runs. */
const LINK_CLASSES: readonly LinkOptions[] = [LINK, { rttMs: 70, jitterMs: 10 }, { rttMs: 110, jitterMs: 16 }];

/** Up to the scenario's peer cap, with mixed 1-2 seats per peer. */
const PEERS = MAX_ZONED_PEERS;
const MIXED = [2, 1, 2, 1, 2, 2];
/** A wider grid with one start slot per seat, the pit and the field on its last row. */
const WIDE: Partial<DomainScenarioOptions> = { gridCols: 12, gridRows: 9, pitCell: 100, fieldCell: 107 };

// ---- Session access and run helpers, as in domain-zoned.test.ts.

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

/** Steer from the state that steps the seat's ticks, not from a freshly planned domain still at spawn poses. */
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

function sortedEpochs(log: EpochLog): Assignment[] {
  return [...log].sort((x, y) => x[0] - y[0]).map(([, a]) => a);
}

interface BotRecord { peer: number; seat: number; tick: number }

/** Records every bot input of the watched seats; `wrap` instruments a session created later (a rejoin). */
function spyBots(run: ZonedRun, seats: readonly number[]): { bots: BotRecord[]; wrap: (p: number) => void } {
  const bots: BotRecord[] = [];
  const wrap = (p: number): void => {
    const cfg = internals(run, p).cfg, botInput = cfg.botInput!;
    cfg.botInput = (s, tick, out) => {
      if (seats.includes(s)) bots.push({ peer: p, seat: s, tick });
      botInput(s, tick, out);
    };
  };
  for (let p = 0; p < run.sessions.length; p++) wrap(p);
  return { bots, wrap };
}

/** Lowest cpu class whose capacity holds every seat, so no capacity split cuts a merged component. */
function cpuClassFor(seats: number): number {
  return ZONE_DEFAULTS.capacityByCpuClass.findIndex((c) => c >= seats);
}

function seatTotal(seats: readonly number[]): number {
  return seats.reduce((a, b) => a + b, 0);
}

/** One seeded link class per unordered pair, applied to both directions. */
function seededLinks(peers: number, seed: number): NonNullable<ZonedOptions["links"]> {
  const rnd = mulberry32(seed);
  const links: { from: number; to: number; options: LinkOptions }[] = [];
  for (let a = 0; a < peers; a++) {
    for (let b = a + 1; b < peers; b++) {
      const options = LINK_CLASSES[Math.floor(rnd() * LINK_CLASSES.length)];
      links.push({ from: a, to: b, options }, { from: b, to: a, options });
    }
  }
  return links;
}

/** Frames until the others have dropped a silent peer, plus one epoch. */
function rejoinDelay(run: ZonedRun): number {
  const cfg = internals(run, 0).cfg;
  return Math.ceil(((cfg.lostAfterMs ?? DEFAULT_LOST_AFTER_MS) + (cfg.dropWaitMs ?? DEFAULT_DROP_WAIT_MS)) / FRAME_MS) + K;
}

/** Every seat holds its start cell, so the control words, and with them the assignments, stay put. */
function pinned(opts: Omit<ZonedOptions, "movement">): ZonedRun {
  let start: number[] = [];
  const run = zonedSetup({ ...opts, movement: (seat) => start[seat] });
  steerFromRunning(run);
  start = startCells(run);
  return run;
}

function startCells(run: ZonedRun): number[] {
  return Array.from({ length: run.roster.seatCount }, (_, seat) => run.hooks[0].seatCell(seat));
}

// ---- Merge and split layouts.

/** Seats first..first+count-1 packed row-major into a block `width` cells wide from (row, col). */
interface Cluster { first: number; count: number; row: number; col: number; width: number }
/** No cluster means every seat at its start cell. */
type Layout = readonly Cluster[];
const APART: Layout = [];

/** Two triples and one block of six on the default 8x6 grid, clear of the pit, the field and the sweeper row. */
const PAIRS_6: Layout = [{ first: 0, count: 3, row: 2, col: 1, width: 2 }, { first: 3, count: 3, row: 2, col: 5, width: 2 }];
const ALL_6: Layout = [{ first: 0, count: 6, row: 2, col: 2, width: 3 }];
/** Two blocks of five and one block of ten on the WIDE grid. */
const PAIRS_10: Layout = [{ first: 0, count: 5, row: 2, col: 1, width: 3 }, { first: 5, count: 5, row: 5, col: 6, width: 3 }];
const ALL_10: Layout = [{ first: 0, count: 10, row: 3, col: 4, width: 4 }];

/** Apart, two clusters, apart, one cluster, per cycle; the schedule ends apart so every merge is followed by a split. */
function cycleSchedule(pairs: Layout, all: Layout, cycles: number): Layout[] {
  const out: Layout[] = [];
  for (let i = 0; i < cycles; i++) out.push(APART, pairs, APART, all);
  out.push(APART);
  return out;
}

function layoutCells(run: ZonedRun, layout: Layout, start: readonly number[]): number[] {
  const out = start.slice();
  const cols = run.tuning.gridCols;
  for (const c of layout) {
    for (let i = 0; i < c.count; i++) out[c.first + i] = (c.row + Math.floor(i / c.width)) * cols + c.col + i % c.width;
  }
  return out;
}

/** Each cluster is exactly the domain 1 + its first seat, and every other seat is alone in its domain. */
function realises(sd: Int32Array, layout: Layout): boolean {
  const first = new Int32Array(sd.length).fill(-1);
  for (const c of layout) for (let i = 0; i < c.count; i++) first[c.first + i] = c.first;
  for (let seat = 0; seat < sd.length; seat++) {
    if (first[seat] >= 0 ? sd[seat] !== 1 + first[seat] : sd.indexOf(sd[seat]) !== sd.lastIndexOf(sd[seat])) return false;
  }
  return true;
}

/** How often the epochs arrive at each state: [apart, two clusters, one cluster]; other epochs keep the last state. */
function arrivals(epochs: readonly Assignment[], pairs: Layout, all: Layout): number[] {
  const out = [0, 0, 0];
  let prev = -1;
  for (const a of epochs) {
    const sd = a.seatDomain;
    const state = realises(sd, all) ? 2 : realises(sd, pairs) ? 1 : realises(sd, APART) ? 0 : -1;
    if (state < 0) continue;
    if (state !== prev) out[state]++;
    prev = state;
  }
  return out;
}

/** Steering toward the phase's layout; `targets` is filled once the run exists, since start cells come from its hooks. */
function scheduled(targets: number[][]): (seat: number, frame: number) => number {
  return (seat, frame) => targets[Math.min(targets.length - 1, Math.floor(frame / PHASE))][seat];
}

// ---- Cases.

interface CycleOptions { seats: readonly number[]; seed: number; pairs: Layout; all: Layout; link?: LinkOptions; mixedLinks?: boolean; scenario?: Partial<DomainScenarioOptions> }

function mergeSplit(o: CycleOptions): void {
  const schedule = cycleSchedule(o.pairs, o.all, CYCLES);
  const targets: number[][] = [];
  const run = zonedSetup({
    peers: o.seats.length, seats: o.seats, seed: o.seed, link: o.link ?? LINK, scenario: o.scenario, tuning: EPOCHS,
    links: o.mixedLinks ? seededLinks(o.seats.length, o.seed) : undefined,
    classes: { cpuClass: cpuClassFor(seatTotal(o.seats)) },
    movement: scheduled(targets),
  });
  steerFromRunning(run);
  const start = startCells(run);
  for (const l of schedule) targets.push(layoutCells(run, l, start));
  const log: EpochLog[] = run.sessions.map(() => new Map());
  const scripted = play(run, schedule.length * PHASE, () => watchEpochs(run, log));
  const epochs = sortedEpochs(log[0]);
  assert.ok(realises(epochs[0].seatDomain, APART), "the seats start in separate domains");
  for (let p = 1; p < log.length; p++) {
    for (const [e, a] of log[p]) {
      const b = log[0].get(e);
      if (b) assert.deepEqual([...a.seatDomain], [...b.seatDomain], `peer ${p} epoch ${e} seat domains`);
    }
  }
  const [apart, pairs, all] = arrivals(epochs, o.pairs, o.all);
  assert.ok(pairs >= CYCLES, `two-cluster merges ${pairs} of ${CYCLES}`);
  assert.ok(all >= CYCLES, `one-cluster merges ${all} of ${CYCLES}`);
  assert.ok(apart - 1 >= 2 * CYCLES, `splits ${apart - 1} of ${2 * CYCLES}`);
  for (const a of epochs) {
    if (!realises(a.seatDomain, o.all)) continue;
    const end = a.epoch * K + K - 1;
    assert.ok(run.confirmed.filter((c) => c.get(1)?.has(end)).length >= 2, `merged domain compared at ${end}`);
  }
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples() > 0, "replicas compared hashes");
  assertConfirmedPast(run, scripted, "merge and split");
}

interface Episode { frame: number; spec: DomainSpec; victim: number; ct: number; desyncs: number }
interface Correction { episode: number; peer: number; from: number; smooth: boolean; tick: number }

/**
 * Checkpoint disagreements: at each planned frame, an impulse on one seat body in the last replica of that seat's
 * domain, which is not the producer. `check` asserts each episode rolled every replica back to an agreed keyframe and
 * that mismatches lie only inside the episodes, then drops the victims' episode samples, which the producer's
 * snapshot replaced. It returns the tick after which every episode is over.
 */
function checkpoints(run: ZonedRun, plan: readonly { frame: number; seat: number }[]) {
  const episodes: Episode[] = [];
  const corrections: Correction[] = [];
  for (let p = 0; p < run.sessions.length; p++) {
    const s = internals(run, p), correct = s.correct.bind(s);
    s.correct = (d, from, bytes, smooth) => {
      const i = episodes.length - 1;
      if (i >= 0 && d.spec.id === episodes[i].spec.id) corrections.push({ episode: i, peer: p, from, smooth, tick: run.sessions[p].stats.tick });
      correct(d, from, bytes, smooth);
    };
  }
  const hook = (frame: number): void => {
    const planned = plan.find((x) => x.frame === frame);
    if (!planned) return;
    const a = run.sessions[0].assignment;
    const spec = a.domains.find((d) => d.id === a.seatDomain[planned.seat])!;
    assert.equal(run.tuning.costClass[spec.kind], "checkpoint", "scenario: the seat domain has the class under test");
    const victim = spec.replicas[spec.replicas.length - 1];
    assert.notEqual(victim, spec.replicas[0], "scenario: the victim is not the producer");
    const s = run.sessions[victim];
    const e: Episode = { frame, spec, victim, ct: s.domain(spec.id)!.sim.tick, desyncs: s.stats.desyncs };
    episodes.push(e);
    assert.ok(s.debugCorrupt(spec.id, (sim) => {
      const w = (sim as RapierDomainSim<DirInput>).world;
      w.sim.body(w.bodyOf(run.hooks[victim].seatEntity(planned.seat))).applyImpulse({ x: 1, y: 0, z: 0 }, true);
    }), `corruption at frame ${frame} ran`);
  };
  const check = (): number => {
    assert.equal(episodes.length, plan.length, "every planned corruption ran");
    const kf = run.tuning.keyframeEvery * K;
    const done: number[] = [];
    episodes.forEach((e, i) => {
      const next = episodes[i + 1];
      if (next && next.victim === e.victim) assert.ok(next.desyncs > e.desyncs, `episode ${i}: the victim entered an episode`);
      else assert.ok(run.sessions[e.victim].stats.desyncs > e.desyncs, `episode ${i}: the victim entered an episode`);
      const mine = corrections.filter((c) => c.episode === i);
      for (const p of e.spec.replicas) {
        const c = mine.find((x) => x.peer === p);
        assert.ok(c && !c.smooth && c.from % kf === 0 && c.from <= e.ct, `episode ${i}: replica ${p} rolls back to the last agreed keyframe`);
      }
      done.push(Math.max(...mine.map((c) => c.tick)));
    });
    for (const m of run.mismatches()) {
      const inside = episodes.some((e, i) => m.domain === e.spec.id && m.peers.includes(e.victim) && m.tick > e.ct && m.tick < done[i]);
      assert.ok(inside, `disagreement in domain ${m.domain} at ${m.tick} lies inside an episode`);
    }
    episodes.forEach((e, i) => {
      const ticks = run.confirmed[e.victim].get(e.spec.id);
      if (ticks) for (const tick of [...ticks.keys()]) if (tick > e.ct && tick < done[i]) ticks.delete(tick);
    });
    return Math.max(...done);
  };
  return { hook, check };
}

/** Repeated corruptions of different seat domains, one per gap, over a pinned run of six peers with mixed seats. */
function checkpointLong(): void {
  const seed = 21, gap = 20 * K, first = 150;
  const run = pinned({ peers: PEERS, seats: MIXED, seed, link: LINK, links: seededLinks(PEERS, seed), scenario: WIDE, tuning: EPOCHS });
  const seats = [1, 3, 6, 8, 9, 0, 5];
  const cp = checkpoints(run, seats.map((seat, i) => ({ frame: first + i * gap, seat })));
  const scripted = play(run, first + seats.length * gap, cp.hook);
  const done = cp.check();
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples(done) > 0, "replicas compared hashes after the last episode");
  assertConfirmedPast(run, scripted, "checkpoint");
}

/** Two peers drop one after the other; a live bot host drives each lost seat and the remaining replicas agree. */
function dropTakeover(): void {
  const seed = 22;
  const run = pinned({ peers: PEERS, seats: MIXED, seed, link: LINK, links: seededLinks(PEERS, seed), scenario: WIDE, tuning: EPOCHS });
  const drops = [{ peer: 2, frame: 120 }, { peer: 3, frame: 120 + 40 * K }];
  const frames = 120 + 90 * K;
  const gone = drops.map((d) => d.peer);
  const { bots } = spyBots(run, drops.flatMap((d) => run.roster.peers[d.peer].seats));
  const reported: { peer: number; lost: number; tick: number }[] = [];
  for (let p = 0; p < run.sessions.length; p++) run.sessions[p].onPeerLost = (lost, tick) => { reported.push({ peer: p, lost, tick }); };
  const scripted = play(run, frames, (frame) => {
    for (const d of drops) if (frame === d.frame) run.drop(d.peer);
  });
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples() > 0, "replicas compared hashes");
  for (let p = 0; p < run.sessions.length; p++) {
    if (gone.includes(p)) continue;
    for (const lost of gone) assert.ok(reported.some((r) => r.peer === p && r.lost === lost), `peer ${p} reported peer ${lost} through onPeerLost`);
    assert.deepEqual([...run.sessions[p].stats.lostPeers].sort((a, b) => a - b), gone, `peer ${p} lists the lost peers`);
  }
  for (const d of drops) {
    const from = Math.min(...reported.filter((r) => r.lost === d.peer).map((r) => r.tick));
    for (const seat of run.roster.peers[d.peer].seats) {
      const mine = bots.filter((b) => b.seat === seat);
      assert.ok(mine.length > 0 && mine.every((b) => b.peer !== d.peer && b.tick >= from), `seat ${seat}: a live peer drives it from the agreed drop tick`);
      let host = -1, replicas = 0;
      for (let p = 0; p < run.sessions.length; p++) {
        if (gone.includes(p)) continue;
        const sim = run.seatSim(p, seat);
        if (!sim) continue;
        replicas++;
        if (host < 0) host = sim.host[seat];
        assert.ok(!gone.includes(host), `seat ${seat}: a live peer hosts it`);
        assert.equal(sim.host[seat], host, `seat ${seat}: peer ${p} sees peer ${host} hosting it`);
        assert.equal(sim.bot[seat], 1, `seat ${seat}: peer ${p} marks it as bot driven`);
      }
      assert.ok(replicas >= 2, `seat ${seat}: its domain keeps two replicas`);
      const driven = new Set(mine.map((b) => b.tick));
      for (let t = from; t < scripted; t++) assert.ok(driven.has(t), `seat ${seat}: a bot drives it at tick ${t}`);
      const last = Math.max(...driven);
      assert.ok(last >= scripted && mine.some((b) => b.peer === host && b.tick === last), `seat ${seat}: peer ${host} drives it to the end`);
    }
  }
  assertConfirmedPast(run, scripted, "drop");
}

interface Round { peer: number; drop: number; rejoin: number; R: number; observed: boolean; adopted: number }

function round(peer: number, drop: number, rejoin: number): Round {
  return { peer, drop, rejoin, R: Infinity, observed: false, adopted: Infinity };
}

/** Drops and rejoins the round's peer, and records the switch boundary each side settles on. */
function roundHook(run: ZonedRun, r: Round, rejoined?: (peer: number) => void): (frame: number) => void {
  return (frame) => {
    if (frame === r.drop) run.drop(r.peer);
    if (frame === r.rejoin) {
      assert.ok(run.sessions[0].stats.lostPeers.includes(r.peer), `the others dropped peer ${r.peer}`);
      run.rejoin(r.peer);
      rejoined?.(r.peer);
    }
    if (frame <= r.rejoin) return;
    const at = internals(run, 0).rejoinAt[r.peer];
    if (r.R === Infinity && at !== Infinity) r.R = at;
    const s = internals(run, r.peer);
    if (s.awaitingSnapshot) r.observed = true;
    else if (r.observed && r.adopted === Infinity) r.adopted = s.rejoinAt[r.peer];
  };
}

/** The returning peer observed, both sides switched at one boundary, and the owner drives its seats again. */
function checkRound(run: ZonedRun, r: Round): void {
  assert.ok(r.observed, `peer ${r.peer} resynced as an observer`);
  assert.ok(r.R !== Infinity && r.R % K === 0, `peer ${r.peer}: the switch is an epoch boundary (${r.R})`);
  assert.equal(r.adopted, r.R, `peer ${r.peer}: both sides switch at the same boundary`);
  const a = run.sessions[0].assignment;
  for (const seat of run.roster.peers[r.peer].seats) {
    for (let p = 0; p < run.sessions.length; p++) {
      if (run.alive[p]) assert.equal(run.sessions[p].assignment.seatHost[seat], r.peer, `peer ${p} sees the owner driving seat ${seat}`);
    }
    const d = run.sessions[r.peer].domain(a.seatDomain[seat]);
    assert.ok(d && d.start >= r.R, `seat ${seat}: the returning peer's domain starts at or after the switch`);
  }
}

/** Two drop and rejoin rounds of two-seat peers; bots drive their seats only until each switch. */
function rejoinLong(): void {
  const seed = 23;
  const run = pinned({ peers: PEERS, seats: MIXED, seed, link: LINK, links: seededLinks(PEERS, seed), scenario: WIDE, tuning: EPOCHS });
  const delay = rejoinDelay(run), first = 120;
  const r1 = round(2, first, first + delay);
  const r2 = round(5, r1.rejoin + 16 * K, r1.rejoin + 16 * K + delay);
  const frames = r2.rejoin + 16 * K;
  const { bots, wrap } = spyBots(run, [r1, r2].flatMap((r) => run.roster.peers[r.peer].seats));
  const hooks = [roundHook(run, r1, wrap), roundHook(run, r2, wrap)];
  const scripted = play(run, frames, (frame) => { for (const h of hooks) h(frame); });
  for (const r of [r1, r2]) {
    checkRound(run, r);
    const mine = bots.filter((b) => run.roster.peers[r.peer].seats.includes(b.seat));
    assert.ok(mine.length > 0 && mine.every((b) => b.tick < r.R), `peer ${r.peer}: bots drive its seats until the switch only`);
  }
  const a = run.sessions[0].assignment;
  for (let p = 0; p < run.sessions.length; p++) {
    assert.equal(run.sessions[p].assignment.epoch, a.epoch, `peer ${p} epoch`);
    assert.deepEqual(run.sessions[p].assignment.domains, a.domains, `peer ${p} domains`);
    assert.deepEqual(run.sessions[p].stats.lostPeers, [], `peer ${p}: nobody stays lost`);
  }
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples(r2.R) > 0, "replicas compared hashes after the last switch");
  assertConfirmedPast(run, scripted, "rejoin");
}

/**
 * Everything in one run of six peers with mixed seats over mixed links: a checkpoint disagreement while apart,
 * merge and split cycles, a drop with takeover in an apart phase, the rejoin, then more cycles.
 */
function combined(): void {
  const seed = 24;
  const schedule = [...cycleSchedule(PAIRS_10, ALL_10, 2), APART, PAIRS_10, APART, ALL_10, APART];
  const dropPhase = 8;
  assert.equal(schedule[dropPhase], APART, "scenario: the drop happens while apart");
  const targets: number[][] = [];
  const run = zonedSetup({
    peers: PEERS, seats: MIXED, seed, link: LINK, links: seededLinks(PEERS, seed), scenario: WIDE, tuning: EPOCHS,
    classes: { cpuClass: cpuClassFor(seatTotal(MIXED)) },
    movement: scheduled(targets),
  });
  steerFromRunning(run);
  const start = startCells(run);
  for (const l of schedule) targets.push(layoutCells(run, l, start));
  const cp = checkpoints(run, [{ frame: 8 * K, seat: 3 }]);
  // The dropped peer is chosen at the drop: never peer 0, whose log is the reference, nor the corrupted replica.
  let r: Round | undefined;
  let roundFrame: ((frame: number) => void) | undefined;
  const dropFrame = dropPhase * PHASE + 2 * K;
  const reported: { peer: number; lost: number }[] = [];
  for (let p = 0; p < run.sessions.length; p++) run.sessions[p].onPeerLost = (lost) => { reported.push({ peer: p, lost }); };
  const log: EpochLog[] = run.sessions.map(() => new Map());
  const scripted = play(run, schedule.length * PHASE, (frame) => {
    cp.hook(frame);
    if (frame === dropFrame) {
      const victim = run.sessions[0].assignment.domains.find((d) => d.seats.includes(3))!.replicas.at(-1);
      const peer = [4, 5, 2].find((p) => p !== victim)!;
      r = round(peer, dropFrame, dropFrame + rejoinDelay(run));
      roundFrame = roundHook(run, r);
    }
    roundFrame?.(frame);
    watchEpochs(run, log);
  });
  assert.ok(r, "the drop ran");
  const done = cp.check();
  for (let p = 0; p < run.sessions.length; p++) {
    if (p !== r.peer) assert.ok(reported.some((x) => x.peer === p && x.lost === r!.peer), `peer ${p} reported peer ${r.peer} through onPeerLost`);
    assert.deepEqual(run.sessions[p].stats.lostPeers, [], `peer ${p}: nobody stays lost`);
  }
  checkRound(run, r);
  const [apart, pairs, all] = arrivals(sortedEpochs(log[0]), PAIRS_10, ALL_10);
  assert.ok(pairs >= 2 && all >= 2, `merges: ${pairs} into two clusters, ${all} into one`);
  assert.ok(apart - 1 >= 4, `splits ${apart - 1}`);
  assert.deepEqual(run.mismatches(), []);
  assert.ok(run.sharedSamples(Math.max(done, r.R)) > 0, "replicas compared hashes after the episode and the switch");
  assertConfirmedPast(run, scripted, "combined");
}

const CASES: Record<string, () => void> = {
  "merge-split": () => mergeSplit({ seats: [1, 1, 1, 1, 1, 1], seed: 11, pairs: PAIRS_6, all: ALL_6, link: JITTER }),
  "merge-split-mixed": () => mergeSplit({ seats: MIXED, seed: 12, pairs: PAIRS_10, all: ALL_10, mixedLinks: true, scenario: WIDE }),
  "checkpoint": checkpointLong,
  "drop": dropTakeover,
  "rejoin": rejoinLong,
  "combined": combined,
};

const name = process.env.DOMAIN_LONG_CASE ?? "";
const body = CASES[name];
if (!body) throw new Error(`[domain-zoned.long] DOMAIN_LONG_CASE must be one of: ${Object.keys(CASES).join(", ")}`);
test(`long zoned: ${name}`, body);
