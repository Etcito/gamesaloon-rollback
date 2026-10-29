// Small Rapier zone scenario and its NetSim driver. One process, one virtual frame clock, deterministic from a seed.
// The top fixture is the minimal two-cell world of the domain-sim unit tests; the zoned scenario follows it.
import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { fnv1a32, SnapReader, SnapWriter } from "@gamesaloon/rollback";
import { NetSim } from "@gamesaloon/rollback/netsim";
import type { LinkOptions } from "@gamesaloon/rollback/netsim";
import { CONTROL_NO_CELL, MAX_PEERS, packControl, ZONE_DEFAULTS, ZoneSession } from "@gamesaloon/rollback/zones";
import type {
  ControlFields, DomainFactory, DomainSim, InputCodec, Roster, SeatId, SleepEvent, ZoneSessionConfig, ZoneTuning,
} from "@gamesaloon/rollback/zones";
import type { DomainSpec, ShadowView } from "@gamesaloon/rollback/zones";
import { RapierDomainFactory } from "../src/domain-sim.ts";
import type { RapierDomainHooks, RapierDomainSim } from "../src/domain-sim.ts";
import type { RapierDomainWorld } from "../src/domain-world.ts";
import type { KinematicPart } from "../src/domain-rebuild.ts";
import { initRapier } from "../src/init.ts";
import type { RapierModule } from "../src/init.ts";
import { TICK_RATE } from "../src/world-sim.ts";
import type { BodyId } from "../src/world-sim.ts";
import { mulberry32 } from "./scenario.ts";

export const R = await initRapier();
export const EMPTY = new Uint8Array(0);
export const LEFT: DomainSpec = { id: 1, kind: "seat", cells: [0], seats: [0], replicas: [0, 1] };
export const RIGHT: DomainSpec = { id: 2, kind: "seat", cells: [1], seats: [1], replicas: [0, 1] };
export const MERGED: DomainSpec = { id: 1, kind: "seat", cells: [0, 1], seats: [0, 1], replicas: [0, 1] };

export const hooks: RapierDomainHooks<number> = {
  buildStatic(world) {
    world.sim.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [R.ColliderDesc.cuboid(20, 0.5, 20)]);
    world.sim.createBody(R.RigidBodyDesc.kinematicPositionBased());
  },
  spawnSeat(world, seat) {
    world.adopt(seat + 1, 0, new Uint8Array([seat]), seat);
  },
  buildEntity(_kind, params) {
    return {
      body: R.RigidBodyDesc.dynamic().setTranslation(params[0] === 0 ? -2 : 2, 2, 0),
      colliders: [R.ColliderDesc.ball(0.5)],
    };
  },
  buildJoint(world, _kind, _params, a, b) {
    return world.createImpulseJoint(R.JointData.rope(4, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), a, b, true);
  },
  applyInput(_world, _seat, body, input) {
    if (input !== 0) body.applyImpulse({ x: input, y: 0, z: 0 }, true);
  },
  events(world, w) {
    w.u16(1);
    w.i32(world.tick);
  },
  cellOf(x) { return x < 0 ? 0 : 1; },
  kinematicParts() {
    return [{
      body: 2,
      pose(tick, out) {
        out.translation.x = tick;
        out.translation.y = 10;
        out.translation.z = 0;
        out.rotation.x = 0;
        out.rotation.y = 0;
        out.rotation.z = 0;
        out.rotation.w = 1;
      },
    }];
  },
};

export const factory = new RapierDomainFactory(R, hooks);

export function shadow(from = RIGHT.id, bytes: Uint8Array = EMPTY): ShadowView {
  return { count: 1, fromDomain: () => from, reader: () => new SnapReader(bytes) };
}

export function snapshot(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.snapshot(w);
  return w.bytes().slice();
}

export function exported(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.exportEntities(w);
  return w.bytes().slice();
}

export function shadowBytes(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.shadowOut(w, LEFT.id);
  return w.bytes().slice();
}

// ---- Zoned scenario: a cell grid with a pit, one seesaw field and one sweeper bar.

/**
 * Every size of the zoned scenario. `gridCols` and `fieldCell` are the tuning overrides the driver applies over
 * ZONE_DEFAULTS; the hooks themselves read the grid columns and the field cell from the tuning.
 */
export const DOMAIN_SCENARIO = {
  gridCols: 8,
  fieldCell: 47,
  gridRows: 6,
  cellSize: 4,
  pitCell: 40,
  groundThickness: 0.5,
  wallHeight: 1,
  wallThickness: 0.5,
  /** A body below this height has fallen out of the level. */
  fallY: -2,
  /** Seats start this many cells apart, row-major, so they begin in separate domains. */
  seatSpacing: 3,
  seatRadius: 0.5,
  /** Impulse per tick and pressed direction. */
  impulse: 0.12,
  anchorHeight: 0.6,
  plankHalfX: 1.5,
  plankHalfY: 0.1,
  plankHalfZ: 0.4,
  boxCount: 3,
  boxHalf: 0.3,
  boxDropHeight: 1.5,
  boxSpacing: 1,
  sweeperRow: 1,
  sweeperHalfX: 0.2,
  sweeperHalfY: 0.4,
  sweeperHalfZ: 1.6,
  /** Ticks for one sweep across the grid and back. */
  sweeperPeriod: 480,
  /** Seconds of velocity the steering subtracts, so seats brake near their target cell. */
  steerBrake: 0.5,
  /** Ticks during which a bot or pattern input keeps the same direction. */
  patternHold: 8,
} as const;

export type DomainScenarioOptions = { [K in keyof typeof DOMAIN_SCENARIO]: number };

/** u8 direction mask. */
export const DIR_UP = 1;
export const DIR_DOWN = 2;
export const DIR_LEFT = 4;
export const DIR_RIGHT = 8;
const DIR_MASK = 0xff;

export interface DirInput {
  mask: number;
}

export const dirCodec: InputCodec<DirInput> = {
  create: () => ({ mask: 0 }),
  encode: (input) => input.mask & DIR_MASK,
  decode: (code, out) => {
    out.mask = code & DIR_MASK;
    return out;
  },
  neutral: 0,
};

/** Entity recipe kinds; params carry what the recipe needs to place the body. */
export const KIND_SEAT = 0;
export const KIND_ANCHOR = 1;
export const KIND_PLANK = 2;
export const KIND_BOX = 3;
const JOINT_REVOLUTE = 0;
const NO_PARAMS = new Uint8Array(0);

export class DomainScenarioHooks implements RapierDomainHooks<DirInput> {
  readonly R: RapierModule;
  readonly o: DomainScenarioOptions;
  readonly cols: number;
  readonly rows: number;
  /** -1 when the tuning lists no field cell. */
  readonly fieldCell: number;
  readonly seatCount: number;
  readonly buildEntity: (kind: number, params: Uint8Array) => { body: RAPIER.RigidBodyDesc; colliders: RAPIER.ColliderDesc[] };
  readonly buildJoint: (world: RAPIER.World, kind: number, params: Uint8Array, a: RAPIER.RigidBody, b: RAPIER.RigidBody) => RAPIER.ImpulseJoint;
  readonly buildProxy: (id: number) => { body: RAPIER.RigidBodyDesc; colliders: RAPIER.ColliderDesc[] };
  /** The sweeper body of each world; restore keeps body ids, rebuild calls buildStatic again. */
  readonly #sweeper = new WeakMap<RapierDomainWorld, BodyId>();
  readonly #cell = { x: 0, z: 0 };

  constructor(R: RapierModule, tuning: ZoneTuning, seatCount: number, opts: Partial<DomainScenarioOptions> = {}) {
    this.R = R;
    this.o = { ...DOMAIN_SCENARIO, ...opts };
    this.cols = tuning.gridCols;
    this.rows = this.o.gridRows;
    this.fieldCell = tuning.fieldCells.length > 0 ? tuning.fieldCells[0] : -1;
    this.seatCount = seatCount;
    this.buildEntity = (kind, params) => this.#entity(kind, params);
    this.buildJoint = (world, _kind, _params, a, b) => {
      const origin = { x: 0, y: 0, z: 0 };
      return world.createImpulseJoint(R.JointData.revolute(origin, origin, { x: 0, y: 0, z: 1 }), a, b, true);
    };
    this.buildProxy = (id) => {
      const o = this.o;
      const shape = id <= seatCount ? R.ColliderDesc.ball(o.seatRadius)
        : id === this.plankId ? R.ColliderDesc.cuboid(o.plankHalfX, o.plankHalfY, o.plankHalfZ)
        : R.ColliderDesc.cuboid(o.boxHalf, o.boxHalf, o.boxHalf);
      return { body: R.RigidBodyDesc.kinematicPositionBased(), colliders: [shape] };
    };
  }

  /** Field entity ids follow every seat id, so they never collide with a seat body. */
  get anchorId(): number { return this.seatCount + 1; }
  get plankId(): number { return this.seatCount + 2; }
  boxId(i: number): number { return this.seatCount + 3 + i; }
  seatEntity(seat: SeatId): number { return seat + 1; }

  /** Start cell of a seat: a row-major lattice `seatSpacing` apart, shifted one column per extra layer. */
  seatCell(seat: SeatId): number {
    const s = this.o.seatSpacing;
    const perRow = Math.ceil(this.cols / s);
    const slots = perRow * Math.ceil(this.rows / s);
    const i = seat % slots;
    const col = Math.min(this.cols - 1, (i % perRow) * s + Math.floor(seat / slots));
    return Math.floor(i / perRow) * s * this.cols + col;
  }

  cellCenter(cell: number, out: { x: number; z: number }): { x: number; z: number } {
    out.x = (cell % this.cols + 0.5) * this.o.cellSize;
    out.z = (Math.floor(cell / this.cols) + 0.5) * this.o.cellSize;
    return out;
  }

  /** Positions outside the grid clamp to its border cells, so every body has a cell. */
  cellOf(x: number, z: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.o.cellSize)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(z / this.o.cellSize)));
    return row * this.cols + col;
  }

  holdsField(spec: DomainSpec): boolean {
    return this.fieldCell >= 0 && spec.kind !== "global" && spec.cells.includes(this.fieldCell);
  }

  /** Field entities in ascending id; called once when a domain covering the field is created from its spec. */
  spawnField(world: RapierDomainWorld): void {
    world.adopt(this.anchorId, KIND_ANCHOR, NO_PARAMS);
    world.adopt(this.plankId, KIND_PLANK, NO_PARAMS);
    for (let i = 0; i < this.o.boxCount; i++) world.adopt(this.boxId(i), KIND_BOX, new Uint8Array([i]));
    world.join(this.anchorId, this.plankId, JOINT_REVOLUTE, NO_PARAMS);
  }

  /** The whole static level in every domain world: the sweeper first, the ground around the pit, then the walls. */
  buildStatic(world: RapierDomainWorld): void {
    const R = this.R, o = this.o, sim = world.sim;
    const sweeper = R.ColliderDesc.cuboid(o.sweeperHalfX, o.sweeperHalfY, o.sweeperHalfZ);
    this.#sweeper.set(world, sim.createBody(R.RigidBodyDesc.kinematicPositionBased(), [sweeper]));
    const w = this.cols * o.cellSize, d = this.rows * o.cellSize, cs = o.cellSize;
    const slab = (x0: number, x1: number, z0: number, z1: number, y: number, hy: number): void => {
      if (x1 <= x0 || z1 <= z0) return;
      const desc = R.RigidBodyDesc.fixed().setTranslation((x0 + x1) / 2, y, (z0 + z1) / 2);
      sim.createBody(desc, [R.ColliderDesc.cuboid((x1 - x0) / 2, hy, (z1 - z0) / 2)]);
    };
    const gy = -o.groundThickness / 2, gh = o.groundThickness / 2;
    const pr = Math.floor(o.pitCell / this.cols), pc = o.pitCell % this.cols;
    slab(0, w, 0, pr * cs, gy, gh);
    slab(0, w, (pr + 1) * cs, d, gy, gh);
    slab(0, pc * cs, pr * cs, (pr + 1) * cs, gy, gh);
    slab((pc + 1) * cs, w, pr * cs, (pr + 1) * cs, gy, gh);
    const t = o.wallThickness, wy = o.wallHeight / 2, wh = o.wallHeight / 2;
    slab(-t, 0, -t, d + t, wy, wh);
    slab(w, w + t, -t, d + t, wy, wh);
    slab(0, w, -t, 0, wy, wh);
    slab(0, w, d, d + t, wy, wh);
  }

  spawnSeat(world: RapierDomainWorld, seat: SeatId): void {
    world.adopt(this.seatEntity(seat), KIND_SEAT, new Uint8Array([seat & 0xff, seat >> 8]), seat);
  }

  /** A fallen seat respawns at its start cell on its next input, so each fall is reported once. */
  applyInput(_world: RapierDomainWorld, seat: SeatId, body: RAPIER.RigidBody, input: DirInput): void {
    const o = this.o;
    if (body.translation().y < o.fallY) {
      const c = this.cellCenter(this.seatCell(seat), this.#cell);
      body.setTranslation({ x: c.x, y: o.seatRadius, z: c.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    const m = input.mask;
    const x = ((m & DIR_RIGHT) ? 1 : 0) - ((m & DIR_LEFT) ? 1 : 0);
    const z = ((m & DIR_DOWN) ? 1 : 0) - ((m & DIR_UP) ? 1 : 0);
    if (x !== 0 || z !== 0) body.applyImpulse({ x: x * o.impulse, y: 0, z: z * o.impulse }, true);
  }

  /** Seat bodies below the level, read from the state before the tick: u16 n, then (id u32, tick i32). */
  events(world: RapierDomainWorld, w: SnapWriter, spec: DomainSpec): void {
    let n = 0;
    for (const seat of spec.seats) if (this.#fallen(world, seat)) n++;
    w.u16(n);
    for (const seat of spec.seats) {
      if (!this.#fallen(world, seat)) continue;
      w.u32(this.seatEntity(seat));
      w.i32(world.tick);
    }
  }

  kinematicParts(world: RapierDomainWorld): readonly KinematicPart[] {
    const body = this.#sweeper.get(world);
    if (body === undefined) throw new Error("[domain-scenario] buildStatic did not run on this world");
    const o = this.o;
    const span = this.cols * o.cellSize - 2 * o.sweeperHalfX;
    const z = (o.sweeperRow + 0.5) * o.cellSize;
    const half = o.sweeperPeriod / 2;
    return [{
      body,
      // A triangle wave of the tick: arithmetic only, so every peer computes the same pose.
      pose(tick, out) {
        const phase = ((tick % o.sweeperPeriod) + o.sweeperPeriod) % o.sweeperPeriod;
        const u = phase < half ? phase / half : (o.sweeperPeriod - phase) / half;
        out.translation.x = o.sweeperHalfX + u * span;
        out.translation.y = o.sweeperHalfY;
        out.translation.z = z;
        out.rotation.x = 0;
        out.rotation.y = 0;
        out.rotation.z = 0;
        out.rotation.w = 1;
      },
    }];
  }

  #fallen(world: RapierDomainWorld, seat: SeatId): boolean {
    return world.sim.body(world.bodyOf(this.seatEntity(seat))).translation().y < this.o.fallY;
  }

  #entity(kind: number, params: Uint8Array): { body: RAPIER.RigidBodyDesc; colliders: RAPIER.ColliderDesc[] } {
    const R = this.R, o = this.o;
    if (kind === KIND_SEAT) {
      const c = this.cellCenter(this.seatCell(params[0] | (params[1] << 8)), this.#cell);
      return {
        body: R.RigidBodyDesc.dynamic().setTranslation(c.x, o.seatRadius, c.z),
        colliders: [R.ColliderDesc.ball(o.seatRadius)],
      };
    }
    const f = this.cellCenter(Math.max(0, this.fieldCell), this.#cell);
    if (kind === KIND_ANCHOR) return { body: R.RigidBodyDesc.fixed().setTranslation(f.x, o.anchorHeight, f.z), colliders: [] };
    if (kind === KIND_PLANK) {
      return {
        body: R.RigidBodyDesc.dynamic().setTranslation(f.x, o.anchorHeight, f.z),
        colliders: [R.ColliderDesc.cuboid(o.plankHalfX, o.plankHalfY, o.plankHalfZ)],
      };
    }
    if (kind !== KIND_BOX) throw new Error(`[domain-scenario] unknown entity kind ${kind}`);
    const x = f.x + (params[0] - (o.boxCount - 1) / 2) * o.boxSpacing;
    return {
      body: R.RigidBodyDesc.dynamic().setTranslation(x, o.boxDropHeight, f.z),
      colliders: [R.ColliderDesc.cuboid(o.boxHalf, o.boxHalf, o.boxHalf)],
    };
  }
}

/** The global domain: a ledger of the fall events every other domain sends over its implicit link. */
export class FallLedger implements DomainSim<DirInput> {
  readonly spec: DomainSpec;
  tick: number;
  falls = 0;
  digest = 0;
  readonly #w = new SnapWriter();

  constructor(spec: DomainSpec, tick: number) {
    this.spec = spec;
    this.tick = tick;
  }

  step(_inputs: readonly DirInput[], shadows: ShadowView): void {
    for (let i = 0; i < shadows.count; i++) {
      const r = shadows.reader(i);
      if (r.remaining === 0) continue; // No payload on this link yet.
      const n = r.u16();
      for (let k = 0; k < n; k++) {
        const id = r.u32();
        const tick = r.i32();
        this.falls++;
        this.digest = mix(mix(this.digest, id), tick);
      }
    }
    this.tick++;
  }

  snapshot(w: SnapWriter): void {
    w.i32(this.tick);
    this.exportEntities(w);
  }

  restore(r: SnapReader): void {
    this.tick = r.i32();
    this.#read(r);
  }

  hash(): number {
    const w = this.#w;
    w.reset();
    this.exportEntities(w);
    return fnv1a32(w.bytes());
  }

  exportEntities(w: SnapWriter): void {
    w.u32(this.falls);
    w.u32(this.digest);
  }

  shadowOut(): void {}
  events(w: SnapWriter): void { w.u16(0); }
  far(w: SnapWriter): void { w.u16(0); }
  seatHost(): void {}
  sleepEvents(out: SleepEvent[]): void { out.length = 0; }
  sleepPose(): boolean { return false; }

  /** A rebuilt ledger keeps the counts of its first source. */
  static rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): FallLedger {
    const ledger = new FallLedger(spec, tick);
    for (const r of sources) {
      if (r.remaining === 0) continue;
      ledger.#read(r);
      break;
    }
    return ledger;
  }

  #read(r: SnapReader): void {
    this.falls = r.u32();
    this.digest = r.u32();
  }
}

function mix(h: number, v: number): number {
  h = Math.imul(h ^ v, 0x01000193);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Seat and field domains are Rapier worlds; the global domain is the fall ledger. */
export class ZonedRapierFactory implements DomainFactory<DirInput> {
  readonly hooks: DomainScenarioHooks;
  readonly rapier: RapierDomainFactory<DirInput>;

  constructor(hooks: DomainScenarioHooks) {
    this.hooks = hooks;
    this.rapier = new RapierDomainFactory(hooks.R, hooks);
  }

  create(spec: DomainSpec, tick: number): DomainSim<DirInput> {
    if (spec.kind === "global") return new FallLedger(spec, tick);
    const sim = this.rapier.create(spec, tick);
    // Field entities exist only where a domain is created from its spec; rebuilds carry them over by id.
    if (this.hooks.holdsField(spec)) this.hooks.spawnField(sim.world);
    return sim;
  }

  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): DomainSim<DirInput> {
    if (spec.kind === "global") return FallLedger.rebuild(spec, tick, sources);
    return this.rapier.rebuild(spec, tick, sources);
  }

  reset(spec: DomainSpec, tick: number): DomainSim<DirInput> {
    return this.create(spec, tick);
  }
}

// ---- Driver: one NetSim, one ZoneSession per peer, the same virtual frame clock as the core zone harness.

export const FRAME_MS = 1000 / TICK_RATE;
export const MIN_ZONED_PEERS = 2;
export const MAX_ZONED_PEERS = 6;

type TuningOverrides = Partial<Omit<ZoneTuning, "costClass">> & { costClass?: Partial<ZoneTuning["costClass"]> };
type SessionOptions = Partial<Omit<ZoneSessionConfig<DirInput>,
  "localPeer" | "roster" | "tuning" | "factory" | "codec" | "controls" | "botInput" | "observer">>;

export interface ZonedOptions {
  /** MIN_ZONED_PEERS..MAX_ZONED_PEERS. */
  peers: number;
  /** Seats per peer, or one count per peer. Default 1. */
  seats?: number | readonly number[];
  seed?: number;
  link?: LinkOptions;
  /** Directed link classes, applied with NetSim.setLink. */
  links?: readonly { from: number; to: number; options: LinkOptions }[];
  /** Over ZONE_DEFAULTS and the scenario's gridCols / fieldCell. */
  tuning?: TuningOverrides;
  scenario?: Partial<DomainScenarioOptions>;
  /** Fixed for the run, shared by all seats. */
  classes?: Partial<Omit<ControlFields, "cell">>;
  session?: SessionOptions;
  /** Target cell for this seat and frame; undefined keeps the seeded input pattern. Used to force merge and split. */
  movement?: (seat: SeatId, frame: number) => number | undefined;
  /** Takeover bot input; default the seeded pattern, silent while the run is quiet. */
  botInput?: (seat: SeatId, tick: number, out: DirInput) => void;
}

export interface DomainHashMismatch {
  domain: number;
  tick: number;
  peers: [number, number];
  hashes: [number, number];
}

export function zonedSetup(opts: ZonedOptions): ZonedRun {
  return new ZonedRun(opts);
}

export class ZonedRun {
  readonly opts: ZonedOptions;
  readonly seed: number;
  readonly net: NetSim;
  readonly roster: Roster;
  readonly tuning: ZoneTuning;
  readonly hooks: DomainScenarioHooks[] = [];
  readonly factories: ZonedRapierFactory[] = [];
  readonly sessions: ZoneSession<DirInput>[] = [];
  readonly alive: boolean[];
  /** Per peer, domain, then confirmed tick. Kept across domain handoffs, drops and rejoins. */
  readonly confirmed: Map<number, Map<number, number>>[] = [];
  /** Epoch-zero control words, from the seat start cells. */
  readonly controls: Uint32Array;
  /** Frames run so far. */
  frames = 0;
  /** Zero inputs and no movement, so the tail confirms. */
  quiet = false;

  constructor(opts: ZonedOptions) {
    const n = opts.peers;
    if (!Number.isInteger(n) || n < MIN_ZONED_PEERS || n > Math.min(MAX_ZONED_PEERS, MAX_PEERS)) throw new Error("[domain-scenario] invalid peer count");
    if (Array.isArray(opts.seats) && opts.seats.length !== n) throw new Error("[domain-scenario] one seat count required per peer");
    this.opts = opts;
    this.seed = opts.seed ?? 1;
    const peers: Roster["peers"] = [];
    let seatCount = 0;
    for (let p = 0; p < n; p++) {
      const count = typeof opts.seats === "number" ? opts.seats : (opts.seats?.[p] ?? 1);
      if (!Number.isInteger(count) || count < 0) throw new Error("[domain-scenario] invalid seat count");
      const seats: number[] = [];
      for (let j = 0; j < count; j++) seats.push(seatCount++);
      peers.push({ peer: p, seats });
    }
    const level = { ...DOMAIN_SCENARIO, ...opts.scenario };
    this.tuning = {
      ...ZONE_DEFAULTS, gridCols: level.gridCols, fieldCells: [level.fieldCell], ...opts.tuning,
      costClass: { ...ZONE_DEFAULTS.costClass, ...opts.tuning?.costClass },
    };
    this.net = new NetSim(n, { seed: this.seed, rttMs: 0, jitterMs: 0, loss: 0, reorder: 0, ...opts.link });
    for (const link of opts.links ?? []) this.net.setLink(link.from, link.to, link.options);
    this.roster = { seatCount, peers, live: new Array(n).fill(true) };
    this.alive = new Array(n).fill(true);
    for (let p = 0; p < n; p++) {
      const hooks = new DomainScenarioHooks(R, this.tuning, seatCount, opts.scenario);
      this.hooks.push(hooks);
      this.factories.push(new ZonedRapierFactory(hooks));
      this.confirmed.push(new Map());
    }
    this.controls = new Uint32Array(seatCount);
    for (let seat = 0; seat < seatCount; seat++) this.controls[seat] = this.control(this.hooks[0].seatCell(seat));
    for (let p = 0; p < n; p++) this.sessions.push(this.#session(p, false));
  }

  control(cell: number): number {
    return packControl({ cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 1, ...this.opts.classes, cell });
  }

  /** Seeded direction mask, held for `patternHold` ticks; opposite bits cancel in applyInput. */
  pattern(seat: SeatId, tick: number): number {
    const hold = this.hooks[0].o.patternHold;
    const key = Math.imul(this.seed ^ 0x9e3779b9, seat + 1) ^ Math.imul(Math.floor(tick / hold) + 1, 0x85ebca6b);
    return Math.floor(mulberry32(key)() * (DIR_MASK + 1)) & (DIR_UP | DIR_DOWN | DIR_LEFT | DIR_RIGHT);
  }

  /** The Rapier domain a peer simulates for a seat, when it holds one. */
  seatSim(peer: number, seat: SeatId): RapierDomainSim<DirInput> | undefined {
    const session = this.sessions[peer];
    const sim = session.domain(session.assignment.seatDomain[seat])?.sim;
    return sim && "world" in sim ? sim as RapierDomainSim<DirInput> : undefined;
  }

  /** The cell of a seat body in that peer's predicted state, or CONTROL_NO_CELL. */
  seatCellOf(peer: number, seat: SeatId): number {
    const sim = this.seatSim(peer, seat);
    if (!sim) return CONTROL_NO_CELL;
    const t = sim.world.sim.body(sim.world.bodyOf(this.hooks[peer].seatEntity(seat))).translation();
    return this.hooks[peer].cellOf(t.x, t.z);
  }

  /** Advances the virtual clock by one frame, then frames every live session and records its confirmed hashes. */
  frame(): void {
    const frame = this.frames;
    this.net.advance(FRAME_MS);
    for (let p = 0; p < this.sessions.length; p++) {
      if (!this.alive[p]) continue;
      const session = this.sessions[p];
      const seats = this.roster.peers[p].seats;
      session.frame(FRAME_MS / 1000, (inputs, controls) => {
        for (let j = 0; j < seats.length; j++) {
          const seat = seats[j];
          const sim = this.seatSim(p, seat);
          let mask = this.quiet ? 0 : this.pattern(seat, sim?.tick ?? session.stats.tick);
          const target = this.quiet ? undefined : this.opts.movement?.(seat, frame);
          if (sim && target !== undefined) mask = this.#steer(p, sim, seat, target);
          inputs[j].mask = mask;
          controls[j] = this.control(this.seatCellOf(p, seat));
        }
      });
      this.#record(p);
    }
    this.frames++;
  }

  run(frames: number): void {
    for (let i = 0; i < frames; i++) this.frame();
  }

  /** The peer's process is gone: its session stops and its links go silent. */
  drop(peer: number): void {
    this.#checkPeer(peer, true);
    this.alive[peer] = false;
    this.sessions[peer].dispose();
    this.#partition();
  }

  /** A fresh process for the peer: an observer session that resyncs through DOMAIN_SNAPSHOT. */
  rejoin(peer: number): void {
    this.#checkPeer(peer, false);
    this.alive[peer] = true;
    this.#partition();
    this.sessions[peer] = this.#session(peer, true);
  }

  /** Disagreeing replica pairs over shared (domain, tick) samples; absent replicas are not disagreements. */
  mismatches(): DomainHashMismatch[] {
    const out: DomainHashMismatch[] = [];
    const first = new Map<number, Map<number, { peer: number; hash: number }>>();
    for (let peer = 0; peer < this.confirmed.length; peer++) {
      for (const [domain, ticks] of this.confirmed[peer]) {
        let samples = first.get(domain);
        if (!samples) first.set(domain, samples = new Map());
        for (const [tick, hash] of ticks) {
          const other = samples.get(tick);
          if (!other) samples.set(tick, { peer, hash });
          else if (hash !== other.hash) out.push({ domain, tick, peers: [other.peer, peer], hashes: [other.hash, hash] });
        }
      }
    }
    return out.sort((a, b) => a.domain - b.domain || a.tick - b.tick || a.peers[1] - b.peers[1]);
  }

  /** Shared samples between replica pairs, so an empty comparison cannot pass. */
  sharedSamples(from = 0): number {
    let shared = 0;
    for (let a = 0; a < this.confirmed.length; a++) {
      for (const [domain, ticks] of this.confirmed[a]) {
        for (let b = a + 1; b < this.confirmed.length; b++) {
          const other = this.confirmed[b].get(domain);
          if (other) for (const tick of ticks.keys()) if (tick >= from && other.has(tick)) shared++;
        }
      }
    }
    return shared;
  }

  #session(peer: number, observer: boolean): ZoneSession<DirInput> {
    const botInput = this.opts.botInput ?? ((seat: SeatId, tick: number, out: DirInput) => {
      out.mask = this.quiet ? 0 : this.pattern(seat, tick);
    });
    return new ZoneSession<DirInput>({
      ...this.opts.session,
      localPeer: peer, roster: this.roster, tuning: this.tuning, factory: this.factories[peer], codec: dirCodec,
      controls: this.controls, botInput, observer,
    }, this.net.transport(peer));
  }

  #steer(peer: number, sim: RapierDomainSim<DirInput>, seat: SeatId, target: number): number {
    const hooks = this.hooks[peer];
    if (!Number.isInteger(target) || target < 0 || target >= hooks.cols * hooks.rows || target >= CONTROL_NO_CELL) {
      throw new Error("[domain-scenario] movement target must be a grid cell");
    }
    const body = sim.world.sim.body(sim.world.bodyOf(hooks.seatEntity(seat)));
    const t = body.translation(), v = body.linvel();
    const c = hooks.cellCenter(target, { x: 0, z: 0 });
    const brake = hooks.o.steerBrake;
    const x = c.x - t.x - v.x * brake;
    const z = c.z - t.z - v.z * brake;
    return (x > 0 ? DIR_RIGHT : x < 0 ? DIR_LEFT : 0) | (z > 0 ? DIR_DOWN : z < 0 ? DIR_UP : 0);
  }

  #record(peer: number): void {
    const session = this.sessions[peer];
    const domains = this.confirmed[peer];
    for (const spec of session.assignment.domains) {
      if (session.domain(spec.id) && !domains.has(spec.id)) domains.set(spec.id, new Map());
    }
    // Scan retained ids too: an old state's tail can confirm during handoff grace.
    const end = session.stats.tick;
    for (const [domain, ticks] of domains) {
      const frontier = session.stats.confirmedTick[domain] ?? end;
      for (let tick = Math.max(0, Math.min(frontier, end) - this.tuning.snapshotRing); tick <= end; tick++) {
        const hash = session.confirmedHash(domain, tick);
        if (hash !== undefined && !ticks.has(tick)) ticks.set(tick, hash);
      }
    }
  }

  #checkPeer(peer: number, alive: boolean): void {
    if (!Number.isInteger(peer) || peer < 0 || peer >= this.alive.length) throw new Error("[domain-scenario] invalid peer");
    if (this.alive[peer] !== alive) throw new Error(`[domain-scenario] peer ${peer} is ${alive ? "already dropped" : "live"}`);
  }

  // Dropped peers are each isolated; rejoining one never reconnects another dropped peer.
  #partition(): void {
    this.net.partition([this.alive.flatMap((live, p) => live ? [p] : [])]);
  }
}
