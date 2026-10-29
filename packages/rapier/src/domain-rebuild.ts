import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { DomainSpec, ShadowView, SnapReader, SnapWriter } from "@gamesaloon/rollback/zones";
import { RapierDomainWorld } from "./domain-world.ts";
import type { DomainEntityBuilder, DomainJointBuilder, EntityId, JointId } from "./domain-world.ts";
import type { RapierModule } from "./init.ts";
import type { BodyId, RapierWorldSimOptions } from "./world-sim.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** One entity record of RapierDomainWorld.exportEntities, merged across the domains a rebuild consumes. */
export interface EntityExport {
  readonly id: EntityId;
  readonly kind: number;
  readonly params: Uint8Array;
  readonly owner: number;
  readonly bodyType: number;
  readonly asleep: boolean;
  readonly sleepTick: number;
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly linvel: Vec3;
  readonly angvel: Vec3;
}

export interface JointExport {
  readonly id: JointId;
  readonly a: EntityId;
  readonly b: EntityId;
  readonly kind: number;
  readonly params: Uint8Array;
}

/** The canonical merge: entities and joints in ascending id, one record per id. */
export interface MergedExport {
  readonly entities: EntityExport[];
  readonly joints: JointExport[];
}

function readBytes(r: SnapReader): Uint8Array {
  const n = r.u16();
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r.u8();
  return out;
}

function keepFirst<T extends { id: number }>(list: T[]): T[] {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    if (n > 0 && list[n - 1].id === list[i].id) continue;
    list[n++] = list[i];
  }
  list.length = n;
  return list;
}

/**
 * Reads every source's exportEntities into one canonical list. Ascending id order; on a duplicate id the first
 * occurrence in source order wins. Array.sort is stable, so equal ids stay in source order until keepFirst.
 */
export function mergeEntityStreams(sources: readonly SnapReader[]): MergedExport {
  const entities: EntityExport[] = [];
  const joints: JointExport[] = [];
  for (const r of sources) {
    const nEntities = r.u32();
    for (let i = 0; i < nEntities; i++) {
      const id = r.u32();
      const kind = r.u16();
      const params = readBytes(r);
      const owner = r.u16();
      const bodyType = r.u8();
      const asleep = r.u8() !== 0;
      const sleepTick = r.i32();
      const translation = { x: r.f64(), y: r.f64(), z: r.f64() };
      const rotation = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() };
      const linvel = { x: r.f64(), y: r.f64(), z: r.f64() };
      const angvel = { x: r.f64(), y: r.f64(), z: r.f64() };
      entities.push({ id, kind, params, owner, bodyType, asleep, sleepTick, translation, rotation, linvel, angvel });
    }
    const nJoints = r.u32();
    for (let i = 0; i < nJoints; i++) {
      const id = r.u32();
      const a = r.u32();
      const b = r.u32();
      const kind = r.u16();
      const params = readBytes(r);
      joints.push({ id, a, b, kind, params });
    }
  }
  entities.sort((a, b) => a.id - b.id);
  joints.sort((a, b) => a.id - b.id);
  return { entities: keepFirst(entities), joints: keepFirst(joints) };
}

export interface RebuildOptions {
  readonly R: RapierModule;
  readonly spec: DomainSpec;
  readonly tick: number;
  /** The exportEntities readers of every source domain. */
  readonly sources: readonly SnapReader[];
  readonly buildEntity: DomainEntityBuilder;
  readonly buildJoint: DomainJointBuilder;
  /** Adds the static level first; its bodies are not part of the export and get no entity ids. */
  readonly buildStatic?: (world: RapierDomainWorld, spec: DomainSpec) => void;
  /** Keeps an entity: seat membership, or cellOf(translation) in spec.cells. Supplied by the factory. */
  readonly belongs: (record: EntityExport) => boolean;
  readonly simOptions?: RapierWorldSimOptions;
}

/**
 * A fresh domain from the merge of its sources: the static level, then entities and joints under their old ids.
 * Ids that an entity or joint had in a source are never handed out again, even when the record is filtered out or
 * its joint is cut because one end lives in another domain.
 */
export function rebuildDomain(opts: RebuildOptions): RapierDomainWorld {
  const merged = mergeEntityStreams(opts.sources);
  const world = new RapierDomainWorld(opts.R, opts.buildEntity, opts.buildJoint, opts.simOptions);
  if (opts.buildStatic) opts.buildStatic(world, opts.spec);

  const kept = new Set<EntityId>();
  const sleep: SleepRestore[] = [];
  let maxEntity = 0;
  for (const e of merged.entities) {
    if (e.id > maxEntity) maxEntity = e.id;
    if (!opts.belongs(e)) continue;
    kept.add(e.id);
    world.adopt(e.id, e.kind, e.params, e.owner);
    const rb = world.sim.body(world.bodyOf(e.id));
    rb.setTranslation(e.translation, false);
    rb.setRotation(e.rotation, false);
    rb.setLinvel(e.linvel, false);
    rb.setAngvel(e.angvel, false);
    if (e.asleep) sleep.push({ id: e.id, tick: e.sleepTick });
  }

  let maxJoint = 0;
  for (const j of merged.joints) {
    if (j.id > maxJoint) maxJoint = j.id;
    if (!kept.has(j.a) || !kept.has(j.b)) continue;
    world.adoptJoint(j.id, j.a, j.b, j.kind, j.params);
  }

  // The recipe already fixes the body type; the export's bodyType is informational.
  world.sim.tick = opts.tick;
  applyRestoredState(world, maxEntity + 1, maxJoint + 1, sleep);
  return world;
}

interface SleepRestore {
  readonly id: EntityId;
  readonly tick: number;
}

/** RapierDomainWorld has no counter/sleep setters, so rebuild patches the envelope it just wrote and restores it. */
function applyRestoredState(world: RapierDomainWorld, nextEntity: number, nextJoint: number, sleep: readonly SleepRestore[]): void {
  const w = new Buf();
  world.snapshot(w as unknown as SnapWriter);
  const patched = patchEnvelope(w.bytes(), nextEntity, nextJoint, sleep);
  world.restore(new Buf(patched) as unknown as SnapReader);
  // A fresh World builds its contact graph on the first step, which can wake a restored sleeper once; the set is exact.
  for (const s of sleep) world.sim.body(world.bodyOf(s.id)).sleep();
}

// Mirrors domain-world's envelope header: magic, version, next entity id, next joint id.
const ENVELOPE_MAGIC = 0x31574452; // "RDW1"
const ENVELOPE_VERSION = 1;
const COUNTERS_AT = 8;
const NEXT_JOINT_AT = 12;

/** Replaces the envelope's id counters and sleep set, keeping every table and the RPR1 blob intact. */
function patchEnvelope(src: Uint8Array, nextEntity: number, nextJoint: number, sleep: readonly SleepRestore[]): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let o = 0;
  if (dv.getUint32(o, true) !== ENVELOPE_MAGIC) throw new Error("[rapier-domain] rebuild got a non-domain snapshot");
  o += 4;
  if (dv.getUint32(o, true) !== ENVELOPE_VERSION) throw new Error("[rapier-domain] rebuild got an unknown snapshot version");
  o += 4;
  const nextEntityAt = COUNTERS_AT;
  // Never lower a counter the fresh world already advanced (for example through a static-level spawn).
  const entityCounter = Math.max(dv.getUint32(nextEntityAt, true), nextEntity);
  const jointCounter = Math.max(dv.getUint32(NEXT_JOINT_AT, true), nextJoint);
  o = NEXT_JOINT_AT + 4;
  const nEntities = dv.getUint32(o, true);
  o += 4;
  for (let i = 0; i < nEntities; i++) {
    o += 10; // id, body, kind
    const params = dv.getUint16(o, true);
    o += 2 + params + 2; // length + bytes + owner
  }
  const nJoints = dv.getUint32(o, true);
  o += 4;
  for (let i = 0; i < nJoints; i++) {
    o += 14; // id, a, b, kind
    const params = dv.getUint16(o, true);
    o += 2 + params + 8; // length + bytes + handle
  }
  const nProxies = dv.getUint32(o, true);
  o += 4 + nProxies * 10; // source, id, body
  const sleepAt = o;
  const nSleep = dv.getUint32(o, true);
  o += 4 + nSleep * 8;
  const tail = src.subarray(o);

  const out = new Uint8Array(sleepAt + 4 + sleep.length * 8 + tail.length);
  out.set(src.subarray(0, sleepAt), 0);
  const odv = new DataView(out.buffer);
  odv.setUint32(nextEntityAt, entityCounter, true);
  odv.setUint32(NEXT_JOINT_AT, jointCounter, true);
  odv.setUint32(sleepAt, sleep.length, true);
  let q = sleepAt + 4;
  for (const s of sleep) {
    odv.setUint32(q, s.id, true);
    odv.setInt32(q + 4, s.tick, true);
    q += 8;
  }
  out.set(tail, q);
  return out;
}

/**
 * A reused growable buffer with SnapWriter's write methods and SnapReader's read methods. Called as a writer it
 * receives values; called as a reader it returns them. Cast at the call site because core's classes are nominal
 * and the runtime never imports core.
 */
class Buf {
  #buf: Uint8Array;
  #view: DataView;
  #pos = 0;

  constructor(bytes?: Uint8Array) {
    this.#buf = bytes ?? new Uint8Array(256);
    this.#view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
  }

  reset(): void {
    this.#pos = 0;
  }

  bytes(): Uint8Array {
    return this.#buf.subarray(0, this.#pos);
  }

  u8(v?: number): number {
    if (v === undefined) return this.#view.getUint8(this.#take(1));
    this.#ensure(1);
    this.#view.setUint8(this.#pos, v);
    this.#pos += 1;
    return v;
  }

  u16(v?: number): number {
    if (v === undefined) return this.#view.getUint16(this.#take(2), true);
    this.#ensure(2);
    this.#view.setUint16(this.#pos, v, true);
    this.#pos += 2;
    return v;
  }

  u32(v?: number): number {
    if (v === undefined) return this.#view.getUint32(this.#take(4), true);
    this.#ensure(4);
    this.#view.setUint32(this.#pos, v >>> 0, true);
    this.#pos += 4;
    return v;
  }

  i32(v?: number): number {
    if (v === undefined) return this.#view.getInt32(this.#take(4), true);
    this.#ensure(4);
    this.#view.setInt32(this.#pos, v | 0, true);
    this.#pos += 4;
    return v;
  }

  f64(v?: number): number {
    if (v === undefined) return this.#view.getFloat64(this.#take(8), true);
    this.#ensure(8);
    this.#view.setFloat64(this.#pos, v, true);
    this.#pos += 8;
    return v;
  }

  #take(n: number): number {
    const p = this.#pos;
    if (p + n > this.#buf.length) throw new Error("[rapier-domain] rebuild buffer overrun");
    this.#pos = p + n;
    return p;
  }

  #ensure(n: number): void {
    if (this.#pos + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#pos));
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }
}

/** Creates the kinematic body a first-seen shadow entity needs. A builder must return a kinematic desc. */
export type ShadowProxyBuilder = (id: EntityId) => { body: RAPIER.RigidBodyDesc; colliders: RAPIER.ColliderDesc[] };

const NO_COLLIDERS: RAPIER.ColliderDesc[] = [];

interface LinkProxies {
  /** Every id ever proxied for this source, so a restore can still be reconciled. */
  readonly all: number[];
  readonly known: Set<number>;
  /** Reused membership set of the payload being read. */
  readonly seen: Set<number>;
}

/**
 * Drives one kinematic proxy body per (source domain, source entity id). The inbound payload is what
 * RapierDomainSim.shadowOut writes for the link:
 *   u16 count, then per entity: id u32, translation xyz f64, rotation xyzw f64.
 * The pose is snapshot-form. An absent id is removed only when a payload actually arrived: a zero-length reader
 * means "no SHADOW yet", so that link is skipped without reading. Scratch vectors and sets are reused.
 */
export class ShadowProxies {
  readonly #R: RapierModule;
  readonly #world: RapierDomainWorld;
  readonly #build: ShadowProxyBuilder | undefined;
  readonly #links = new Map<number, LinkProxies>();
  readonly #t = { x: 0, y: 0, z: 0 };
  readonly #q = { x: 0, y: 0, z: 0, w: 1 };

  constructor(R: RapierModule, world: RapierDomainWorld, build?: ShadowProxyBuilder) {
    this.#R = R;
    this.#world = world;
    this.#build = build;
  }

  step(shadows: ShadowView): void {
    for (let i = 0; i < shadows.count; i++) {
      const from = shadows.fromDomain(i);
      const r = shadows.reader(i);
      if (r.remaining === 0) continue;
      let link = this.#links.get(from);
      if (!link) {
        link = { all: [], known: new Set(), seen: new Set() };
        this.#links.set(from, link);
      }
      link.seen.clear();
      const n = r.u16();
      for (let k = 0; k < n; k++) {
        const id = r.u32();
        const t = this.#t;
        t.x = r.f64();
        t.y = r.f64();
        t.z = r.f64();
        const q = this.#q;
        q.x = r.f64();
        q.y = r.f64();
        q.z = r.f64();
        q.w = r.f64();
        link.seen.add(id);
        let body = this.#world.proxyBody(from, id);
        if (body === undefined) {
          body = this.#create(id);
          this.#world.setProxy(from, id, body);
        }
        const rb = this.#world.sim.body(body);
        rb.setNextKinematicTranslation(t);
        rb.setNextKinematicRotation(q);
        if (!link.known.has(id)) {
          link.known.add(id);
          link.all.push(id);
        }
      }
      // A restore may bring back proxies removed after that snapshot, so reconcile every id ever seen.
      for (let k = link.all.length - 1; k >= 0; k--) {
        const id = link.all[k];
        if (link.seen.has(id)) continue;
        if (this.#world.proxyBody(from, id) === undefined) continue;
        this.#world.removeProxy(from, id);
      }
    }
  }

  #create(id: EntityId): BodyId {
    const recipe = this.#build ? this.#build(id) : { body: this.#R.RigidBodyDesc.kinematicPositionBased(), colliders: NO_COLLIDERS };
    recipe.body.setTranslation(this.#t.x, this.#t.y, this.#t.z).setRotation(this.#q);
    return this.#world.sim.createBody(recipe.body, recipe.colliders);
  }
}

/** A pose written in place, so stepping a kinematic part allocates nothing. */
export interface KinematicPose {
  readonly translation: Vec3;
  readonly rotation: Quat;
}

/** A non-interactive moving part: its body comes from the static level, its pose is a pure function of the tick. */
export interface KinematicPart {
  readonly body: BodyId;
  pose(tick: number, out: KinematicPose): void;
}

const KINEMATIC_POSE: KinematicPose = { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };

/**
 * Places each non-interactive part at its pure pose for `tick`. These bodies are kinematic, have no entity ids,
 * and are never exported, synced or hashed; only the world's RPR1 bytes carry their transform.
 */
export function kinematicByTick(world: RapierDomainWorld, tick: number, parts: readonly KinematicPart[]): void {
  for (const part of parts) {
    part.pose(tick, KINEMATIC_POSE);
    const rb = world.sim.body(part.body);
    rb.setTranslation(KINEMATIC_POSE.translation, false);
    rb.setRotation(KINEMATIC_POSE.rotation, false);
    rb.setNextKinematicTranslation(KINEMATIC_POSE.translation);
    rb.setNextKinematicRotation(KINEMATIC_POSE.rotation);
  }
}

/** Thin delegate so callers of this module's factory surface do not reach into the world. */
export function exportEntities(world: RapierDomainWorld, w: SnapWriter): void {
  world.exportEntities(w);
}
