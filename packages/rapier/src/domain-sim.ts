import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { DomainFactory, DomainId, DomainSim, DomainSpec, SeatId, ShadowView, SleepEvent, SnapReader, SnapWriter } from "@gamesaloon/rollback/zones";
import { RapierDomainWorld } from "./domain-world.ts";
import type { DomainEntityBuilder, DomainJointBuilder, EntityId } from "./domain-world.ts";
import { kinematicByTick, mergeEntityStreams, rebuildDomain, ShadowProxies } from "./domain-rebuild.ts";
import type { KinematicPart, ShadowProxyBuilder } from "./domain-rebuild.ts";
import type { RapierModule } from "./init.ts";
import type { RapierWorldSimOptions } from "./world-sim.ts";

/** Game recipes must be deterministic and keep only ids across a restore, never Rapier body objects. */
export interface RapierDomainHooks<TInput> {
  buildStatic(world: RapierDomainWorld, spec: DomainSpec): void;
  /** Register the seat body as its lowest owned entity, with owner = seat and an id stable across domain specs. */
  spawnSeat(world: RapierDomainWorld, seat: SeatId, spec: DomainSpec): void;
  /** The body is resolved afresh for this call; input is borrowed from the session. */
  applyInput(world: RapierDomainWorld, seat: SeatId, body: RAPIER.RigidBody, input: TInput): void;
  /** Write the game's event payload for the global ledger, including its entry count. */
  events(world: RapierDomainWorld, w: SnapWriter, spec: DomainSpec): void;
  readonly buildEntity: DomainEntityBuilder;
  readonly buildJoint: DomainJointBuilder;
  cellOf(x: number, z: number): number;
  /** Resolve the static level's stable body ids once per domain, not once per step. */
  kinematicParts(world: RapierDomainWorld, spec: DomainSpec): readonly KinematicPart[];
  readonly buildProxy?: ShadowProxyBuilder;
  beginResim?(world: RapierDomainWorld): void;
  endResim?(world: RapierDomainWorld): void;
}

const NO_OWNER = 0xffff;
const POSE_FIELDS = 7; // xyz + xyzw, all f64
const VELOCITY_FIELDS = 6; // linear xyz + angular xyz, all f64

/** Physics seat/field domain. The game's global ledger consumes the events payload in its own DomainSim. */
export class RapierDomainSim<TInput> implements DomainSim<TInput> {
  readonly spec: DomainSpec;
  readonly world: RapierDomainWorld;
  readonly hooks: RapierDomainHooks<TInput>;
  /** Indexed by seat id; host metadata does not affect input application or the physics hash. */
  readonly host: Int16Array;
  readonly bot: Uint8Array;
  resimulating = false;
  readonly #seats: EntityId[] = [];
  readonly #shadows: ShadowProxies;
  readonly #parts: readonly KinematicPart[];
  readonly #export = new ExportBuffer();
  #id = 0;
  #bodyType = 0;
  #asleep = false;

  constructor(spec: DomainSpec, world: RapierDomainWorld, hooks: RapierDomainHooks<TInput>) {
    this.spec = spec;
    this.world = world;
    this.hooks = hooks;
    let seats = 0;
    for (const seat of spec.seats) seats = Math.max(seats, seat + 1);
    this.host = new Int16Array(seats).fill(-1);
    this.bot = new Uint8Array(seats);
    this.#shadows = new ShadowProxies(world.sim.R, world, hooks.buildProxy);
    this.#parts = hooks.kinematicParts(world, spec);
    this.#indexSeats();
    kinematicByTick(world, this.tick, this.#parts);
  }

  get tick(): number {
    return this.world.tick;
  }

  set tick(tick: number) {
    this.world.sim.tick = tick;
  }

  step(inputs: readonly TInput[], shadows: ShadowView): void {
    for (let i = 0; i < this.spec.seats.length; i++) {
      const body = this.world.sim.body(this.world.bodyOf(this.#seats[i]));
      this.hooks.applyInput(this.world, this.spec.seats[i], body, inputs[i]);
    }
    // ShadowProxies skips zero-length readers: no payload has arrived on that link yet.
    this.#shadows.step(shadows);
    kinematicByTick(this.world, this.tick + 1, this.#parts);
    this.world.step(); // Rapier first, then sleep tracking.
  }

  /** RDW1 envelope followed by u16 count and (seat u16, peer i16, bot u8). Used for checkpoints and handoffs. */
  snapshot(w: SnapWriter): void {
    this.world.snapshot(w);
    w.u16(this.spec.seats.length);
    for (const seat of this.spec.seats) {
      w.u16(seat);
      w.i16(this.host[seat]);
      w.u8(this.bot[seat]);
    }
  }

  restore(r: SnapReader): void {
    // DomainWorld delegates World replacement/freeing exclusively to restoreSnapshot.
    this.world.restore(r);
    this.host.fill(-1);
    this.bot.fill(0);
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const seat = r.u16();
      this.seatHost(seat, r.i16(), r.u8() !== 0);
    }
    this.#indexSeats();
  }

  hash(): number {
    return this.world.hash();
  }

  exportEntities(w: SnapWriter): void {
    this.world.exportEntities(w);
  }

  /** ShadowProxies payload: u16 count, then id u32 and translation xyz / rotation xyzw f64. */
  shadowOut(w: SnapWriter, _to: DomainId): void {
    this.#writePoses(w, false);
  }

  events(w: SnapWriter): void {
    this.hooks.events(this.world, w, this.spec);
  }

  /** The session schedules the stride and promotes this u16 count into the FAR header. */
  far(w: SnapWriter, _stride: number): void {
    this.#writePoses(w, true);
  }

  seatHost(seat: SeatId, peer: number, bot: boolean): void {
    this.host[seat] = peer;
    this.bot[seat] = bot ? 1 : 0;
  }

  sleepEvents(out: SleepEvent[]): void {
    this.world.sleepEvents(out);
  }

  sleepPose(id: EntityId, w: SnapWriter): boolean {
    return this.world.sleepPose(id, w);
  }

  beginResim(): void {
    this.resimulating = true;
    this.hooks.beginResim?.(this.world);
  }

  endResim(): void {
    try {
      this.hooks.endResim?.(this.world);
    } finally {
      this.resimulating = false;
    }
  }

  #indexSeats(): void {
    this.#export.reset();
    this.world.exportEntities(this.#export as unknown as SnapWriter);
    const records = mergeEntityStreams([this.#export as unknown as SnapReader]).entities;
    this.#seats.length = this.spec.seats.length;
    for (let i = 0; i < this.spec.seats.length; i++) {
      const seat = this.spec.seats[i];
      // The lowest owned entity is the seat body; later owned entities may be attachments.
      const entity = records.find((e) => e.owner === seat);
      if (!entity) throw new Error(`[rapier-domain] missing body for seat ${seat}`);
      this.#seats[i] = entity.id;
    }
  }

  #writePoses(w: SnapWriter, awakeOnly: boolean): void {
    const r = this.#export;
    r.reset();
    this.world.exportEntities(r as unknown as SnapWriter);
    const n = r.u32();
    let count = 0;
    for (let i = 0; i < n; i++) {
      this.#readEntityHeader();
      if (this.#includePose(awakeOnly)) count++;
      r.skip((POSE_FIELDS + VELOCITY_FIELDS) * 8);
    }
    if (count > 0xffff) throw new Error("[rapier-domain] pose entry count exceeds its u16 field");
    w.u16(count);
    r.rewind();
    r.u32();
    for (let i = 0; i < n; i++) {
      this.#readEntityHeader();
      if (this.#includePose(awakeOnly)) {
        w.u32(this.#id);
        for (let f = 0; f < POSE_FIELDS; f++) w.f64(r.f64());
      } else {
        r.skip(POSE_FIELDS * 8);
      }
      r.skip(VELOCITY_FIELDS * 8);
    }
  }

  #includePose(awakeOnly: boolean): boolean {
    return this.#bodyType !== this.world.sim.R.RigidBodyType.Fixed && (!awakeOnly || !this.#asleep);
  }

  /** Read the documented export header, leaving the cursor at its snapshot-form pose. */
  #readEntityHeader(): void {
    const r = this.#export;
    this.#id = r.u32();
    r.u16(); // kind
    r.skip(r.u16()); // recipe params
    r.u16(); // owner
    this.#bodyType = r.u8();
    this.#asleep = r.u8() !== 0;
    r.i32(); // sleepTick
  }
}

export class RapierDomainFactory<TInput> implements DomainFactory<TInput> {
  readonly #R: RapierModule;
  readonly #hooks: RapierDomainHooks<TInput>;
  readonly #options: RapierWorldSimOptions | undefined;

  constructor(R: RapierModule, hooks: RapierDomainHooks<TInput>, options?: RapierWorldSimOptions) {
    this.#R = R;
    this.#hooks = hooks;
    this.#options = options;
  }

  create(spec: DomainSpec, tick: number): RapierDomainSim<TInput> {
    const hooks = this.#hooks;
    const world = new RapierDomainWorld(this.#R, hooks.buildEntity, hooks.buildJoint, this.#options);
    world.sim.tick = tick;
    hooks.buildStatic(world, spec);
    for (const seat of spec.seats) hooks.spawnSeat(world, seat, spec);
    return new RapierDomainSim(spec, world, hooks);
  }

  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): RapierDomainSim<TInput> {
    const hooks = this.#hooks;
    // rebuildDomain calls mergeEntityStreams once, before filtering and restoring ids/joints/sleep.
    const world = rebuildDomain({
      R: this.#R,
      spec,
      tick,
      sources,
      buildEntity: hooks.buildEntity,
      buildJoint: hooks.buildJoint,
      buildStatic: (world, spec) => hooks.buildStatic(world, spec),
      belongs: (e) => (e.owner !== NO_OWNER && spec.seats.includes(e.owner)) ||
        spec.cells.includes(hooks.cellOf(e.translation.x, e.translation.z)),
      simOptions: this.#options,
    });
    return new RapierDomainSim(spec, world, hooks);
  }

  reset(spec: DomainSpec, tick: number): RapierDomainSim<TInput> {
    return this.create(spec, tick);
  }

}

/** Reused export bytes; separate read/write cursors avoid creating readers or pose arrays on hot paths. */
class ExportBuffer {
  #bytes = new Uint8Array(0);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;
  #read = 0;

  get remaining(): number { return this.#length - this.#read; }
  reset(): void { this.#length = 0; this.#read = 0; }
  rewind(): void { this.#read = 0; }
  skip(n: number): void { this.#take(n, false); }

  u8(v?: number): number {
    const at = this.#take(1, v !== undefined);
    if (v === undefined) return this.#view.getUint8(at);
    this.#view.setUint8(at, v);
    return v;
  }

  u16(v?: number): number {
    const at = this.#take(2, v !== undefined);
    if (v === undefined) return this.#view.getUint16(at, true);
    this.#view.setUint16(at, v, true);
    return v;
  }

  u32(v?: number): number {
    const at = this.#take(4, v !== undefined);
    if (v === undefined) return this.#view.getUint32(at, true);
    this.#view.setUint32(at, v, true);
    return v;
  }

  i32(v?: number): number {
    const at = this.#take(4, v !== undefined);
    if (v === undefined) return this.#view.getInt32(at, true);
    this.#view.setInt32(at, v, true);
    return v;
  }

  f64(v?: number): number {
    const at = this.#take(8, v !== undefined);
    if (v === undefined) return this.#view.getFloat64(at, true);
    this.#view.setFloat64(at, v, true);
    return v;
  }

  #take(n: number, write: boolean): number {
    if (!write) {
      const at = this.#read;
      if (at + n > this.#length) throw new Error("[rapier-domain] export buffer overrun");
      this.#read += n;
      return at;
    }
    const at = this.#length;
    const need = at + n;
    if (need > this.#bytes.length) {
      const bytes = new Uint8Array(Math.max(need, this.#bytes.length * 2));
      bytes.set(this.#bytes);
      this.#bytes = bytes;
      this.#view = new DataView(bytes.buffer);
    }
    this.#length = need;
    return at;
  }
}
