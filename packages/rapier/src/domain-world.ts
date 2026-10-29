import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { SleepEvent, SnapReader, SnapWriter } from "@gamesaloon/rollback/zones";
import { fnv1a32 } from "./hash.ts";
import type { RapierModule } from "./init.ts";
import { RapierWorldSim } from "./world-sim.ts";
import type { BodyId, RapierWorldSimOptions } from "./world-sim.ts";

export type EntityId = number;
export type JointId = number;
/** The envelope written by snapshot(): magic, version, id counters, the tables, then the RPR1 blob. */
export type DomainWorldSnapshot = Uint8Array;

export type DomainEntityBuilder = (kind: number, params: Uint8Array) => { body: RAPIER.RigidBodyDesc; colliders: RAPIER.ColliderDesc[] };
export type DomainJointBuilder = (world: RAPIER.World, kind: number, params: Uint8Array, a: RAPIER.RigidBody, b: RAPIER.RigidBody) => RAPIER.ImpulseJoint;

const MAGIC = 0x31574452; // "RDW1" little-endian
const VERSION = 1;
const NO_OWNER = 0xffff;
const MAX_PARAMS = 0xffff;

/** The write methods of SnapWriter. The envelope, the export and the hashes accept either. */
interface ByteSink {
  u8(v: number): void;
  u16(v: number): void;
  u32(v: number): void;
  i32(v: number): void;
  f64(v: number): void;
}

/** A reused growable buffer with SnapWriter's layout. The runtime never imports core, so it cannot build a SnapWriter. */
class ByteBuf implements ByteSink {
  #buf = new Uint8Array(256);
  #view = new DataView(this.#buf.buffer);
  #pos = 0;

  reset(): void {
    this.#pos = 0;
  }

  bytes(): Uint8Array {
    return this.#buf.subarray(0, this.#pos);
  }

  u8(v: number): void {
    this.#ensure(1);
    this.#view.setUint8(this.#pos, v);
    this.#pos += 1;
  }

  u16(v: number): void {
    this.#ensure(2);
    this.#view.setUint16(this.#pos, v, true);
    this.#pos += 2;
  }

  u32(v: number): void {
    this.#ensure(4);
    this.#view.setUint32(this.#pos, v >>> 0, true);
    this.#pos += 4;
  }

  i32(v: number): void {
    this.#ensure(4);
    this.#view.setInt32(this.#pos, v | 0, true);
    this.#pos += 4;
  }

  f64(v: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#pos, v, true);
    this.#pos += 8;
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

interface Entity {
  readonly id: EntityId;
  readonly body: BodyId;
  readonly kind: number;
  readonly params: Uint8Array;
  readonly owner: number;
}

interface Joint {
  readonly id: JointId;
  readonly a: EntityId;
  readonly b: EntityId;
  readonly kind: number;
  readonly params: Uint8Array;
  handle: number;
}

interface Proxy {
  readonly source: number;
  readonly id: EntityId;
  readonly body: BodyId;
}

interface Transition {
  readonly id: EntityId;
  readonly asleep: boolean;
}

function copyParams(params: Uint8Array): Uint8Array {
  if (params.length > MAX_PARAMS) throw new Error(`[rapier-domain] params are ${params.length} bytes; the field is u16`);
  return params.slice();
}

function writeParams(w: ByteSink, params: Uint8Array): void {
  w.u16(params.length);
  for (let i = 0; i < params.length; i++) w.u8(params[i]);
}

function readParams(r: SnapReader): Uint8Array {
  const n = r.u16();
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r.u8();
  return out;
}

/** Snapshot-form pose: translation, then rotation, all f64. The same bytes in exports, SLEEP and the awake block. */
function writePose(rb: RAPIER.RigidBody, w: ByteSink): void {
  const t = rb.translation();
  const q = rb.rotation();
  w.f64(t.x);
  w.f64(t.y);
  w.f64(t.z);
  w.f64(q.x);
  w.f64(q.y);
  w.f64(q.z);
  w.f64(q.w);
}

function writeVelocity(rb: RAPIER.RigidBody, w: ByteSink): void {
  const v = rb.linvel();
  const a = rb.angvel();
  w.f64(v.x);
  w.f64(v.y);
  w.f64(v.z);
  w.f64(a.x);
  w.f64(a.y);
  w.f64(a.z);
}

// Ids are an ascending counter, so the Maps below iterate in ascending id order.
// Sleep is the exception: it is filled in transition order, so ordered walks go through #entities.
/**
 * A Rapier World owned by a domain: stable entity and joint ids, a proxy table, and a sleep set
 * whose transitions feed SLEEP/WAKE. It composes RapierWorldSim and never modifies it.
 */
export class RapierDomainWorld {
  readonly sim: RapierWorldSim;
  readonly #dynamic: number;
  readonly #buildEntity: DomainEntityBuilder;
  readonly #buildJoint: DomainJointBuilder;
  #entities = new Map<EntityId, Entity>();
  #joints = new Map<JointId, Joint>();
  #proxies = new Map<number, Proxy>();
  /** Entity id -> tick the dynamic body fell asleep. */
  #sleep = new Map<EntityId, number>();
  #nextEntityId = 1;
  #nextJointId = 1;
  #transitions: Transition[] = [];
  #transitionTick = 0;
  #poseBufs: ByteBuf[] = [];
  #scratch = new ByteBuf();
  #rapierBytes = new Uint8Array(0);

  constructor(R: RapierModule, buildEntity: DomainEntityBuilder, buildJoint: DomainJointBuilder, opts?: RapierWorldSimOptions) {
    this.sim = new RapierWorldSim(R, opts);
    this.#dynamic = R.RigidBodyType.Dynamic;
    this.#buildEntity = buildEntity;
    this.#buildJoint = buildJoint;
  }

  get tick(): number {
    return this.sim.tick;
  }

  spawn(kind: number, params: Uint8Array, owner = NO_OWNER): EntityId {
    return this.#addEntity(this.#nextEntityId, kind, params, owner);
  }

  /** Rebuild path: an entity under the id it had in an export. Ids never go back, so adopt in ascending order. */
  adopt(id: EntityId, kind: number, params: Uint8Array, owner = NO_OWNER): EntityId {
    if (id < this.#nextEntityId) throw new Error(`[rapier-domain] entity id ${id} is below next id ${this.#nextEntityId}; ids are never reused`);
    return this.#addEntity(id, kind, params, owner);
  }

  join(a: EntityId, b: EntityId, kind: number, params: Uint8Array): JointId {
    return this.#insertJoint(this.#nextJointId, a, b, kind, params);
  }

  /** Rebuild path: a joint under the id it had in an export. Adopt in ascending order, as for entities. */
  adoptJoint(id: JointId, a: EntityId, b: EntityId, kind: number, params: Uint8Array): JointId {
    if (id < this.#nextJointId) throw new Error(`[rapier-domain] joint id ${id} is below next id ${this.#nextJointId}; ids are never reused`);
    return this.#insertJoint(id, a, b, kind, params);
  }

  /** Creates the Rapier impulse joint of a table entry and records its handle. */
  recreateJoint(id: JointId): void {
    const j = this.#joints.get(id);
    if (!j) throw new Error(`[rapier-domain] unknown joint ${id}`);
    const joint = this.#buildJoint(this.sim.world, j.kind, j.params, this.sim.body(this.bodyOf(j.a)), this.sim.body(this.bodyOf(j.b)));
    j.handle = joint.handle;
  }

  bodyOf(id: EntityId): BodyId {
    const e = this.#entities.get(id);
    if (!e) throw new Error(`[rapier-domain] unknown entity ${id}`);
    return e.body;
  }

  setProxy(source: number, id: EntityId, body: BodyId): void {
    this.#proxies.set(proxyKey(source, id), { source, id, body });
  }

  proxyBody(source: number, id: EntityId): BodyId | undefined {
    return this.#proxies.get(proxyKey(source, id))?.body;
  }

  removeProxy(source: number, id: EntityId): void {
    const key = proxyKey(source, id);
    const p = this.#proxies.get(key);
    if (!p) return;
    this.sim.removeBody(p.body);
    this.#proxies.delete(key);
  }

  /** Advances one tick, then compares each dynamic body's sleep state with the sleep set. */
  step(eventQueue?: RAPIER.EventQueue): void {
    const tick = this.sim.tick;
    this.sim.step(eventQueue);
    this.#transitions.length = 0;
    this.#transitionTick = tick;
    for (const e of this.#entities.values()) {
      const rb = this.sim.body(e.body);
      if (rb.bodyType() !== this.#dynamic) continue;
      const asleep = rb.isSleeping();
      if (asleep === this.#sleep.has(e.id)) continue;
      if (asleep) this.#sleep.set(e.id, tick);
      else this.#sleep.delete(e.id);
      this.#transitions.push({ id: e.id, asleep });
    }
  }

  /** Fills `out` with the transitions of the last step, in ascending id. Pose buffers are reused. */
  sleepEvents(out: SleepEvent[]): void {
    out.length = 0;
    for (let i = 0; i < this.#transitions.length; i++) {
      const t = this.#transitions[i];
      const pose = this.#poseBuf(i);
      pose.reset();
      if (t.asleep) writePose(this.sim.body(this.bodyOf(t.id)), pose);
      out.push({ id: t.id, tick: this.#transitionTick, asleep: t.asleep, pose: pose.bytes() });
    }
    this.#transitions.length = 0;
  }

  /** The pose a SLEEP carries. False when this world does not hold the entity. */
  sleepPose(id: EntityId, w: SnapWriter): boolean {
    if (!this.#entities.has(id)) return false;
    writePose(this.sim.body(this.bodyOf(id)), w);
    return true;
  }

  #poseBuf(i: number): ByteBuf {
    while (this.#poseBufs.length <= i) this.#poseBufs.push(new ByteBuf());
    return this.#poseBufs[i];
  }

  #addEntity(id: EntityId, kind: number, params: Uint8Array, owner: number): EntityId {
    const recipe = this.#buildEntity(kind, params);
    const body = this.sim.createBody(recipe.body, recipe.colliders);
    this.#entities.set(id, { id, body, kind, params: copyParams(params), owner });
    this.#nextEntityId = id + 1;
    return id;
  }

  #insertJoint(id: JointId, a: EntityId, b: EntityId, kind: number, params: Uint8Array): JointId {
    if (!this.#entities.has(a) || !this.#entities.has(b)) throw new Error(`[rapier-domain] joint ${id} must join entities of this world`);
    this.#joints.set(id, { id, a, b, kind, params: copyParams(params), handle: -1 });
    this.#nextJointId = id + 1;
    this.recreateJoint(id);
    return id;
  }

  /** Envelope: magic, version, id counters, entity table, joint table with handles, proxies, sleep set, RPR1 bytes. */
  snapshot(w: SnapWriter): void {
    w.u32(MAGIC);
    w.u32(VERSION);
    w.u32(this.#nextEntityId);
    w.u32(this.#nextJointId);
    w.u32(this.#entities.size);
    for (const e of this.#entities.values()) {
      w.u32(e.id);
      w.u32(e.body);
      w.u16(e.kind);
      writeParams(w, e.params);
      w.u16(e.owner);
    }
    w.u32(this.#joints.size);
    for (const j of this.#joints.values()) {
      w.u32(j.id);
      w.u32(j.a);
      w.u32(j.b);
      w.u16(j.kind);
      writeParams(w, j.params);
      w.f64(j.handle);
    }
    w.u32(this.#proxies.size);
    for (const p of this.#proxies.values()) {
      w.u16(p.source);
      w.u32(p.id);
      w.u32(p.body);
    }
    w.u32(this.#sleep.size);
    for (const e of this.#entities.values()) {
      const tick = this.#sleep.get(e.id);
      if (tick === undefined) continue;
      w.u32(e.id);
      w.i32(tick);
    }
    const rapier = this.sim.takeSnapshot();
    w.u32(rapier.length);
    for (let i = 0; i < rapier.length; i++) w.u8(rapier[i]);
  }

  /** Replaces every table and the World. Joint handles stay valid: the RPR1 blob restores the same handles. */
  restore(r: SnapReader): void {
    if (r.u32() !== MAGIC || r.u32() !== VERSION) throw new Error("[rapier-domain] not a domain world snapshot (bad magic/version)");
    const nextEntityId = r.u32();
    const nextJointId = r.u32();
    const entities = new Map<EntityId, Entity>();
    const nEntities = r.u32();
    for (let i = 0; i < nEntities; i++) {
      const id = r.u32();
      const body = r.u32();
      const kind = r.u16();
      const params = readParams(r);
      const owner = r.u16();
      entities.set(id, { id, body, kind, params, owner });
    }
    const joints = new Map<JointId, Joint>();
    const nJoints = r.u32();
    for (let i = 0; i < nJoints; i++) {
      const id = r.u32();
      const a = r.u32();
      const b = r.u32();
      const kind = r.u16();
      const params = readParams(r);
      const handle = r.f64();
      joints.set(id, { id, a, b, kind, params, handle });
    }
    const proxies = new Map<number, Proxy>();
    const nProxies = r.u32();
    for (let i = 0; i < nProxies; i++) {
      const source = r.u16();
      const id = r.u32();
      const body = r.u32();
      proxies.set(proxyKey(source, id), { source, id, body });
    }
    const sleep = new Map<EntityId, number>();
    const nSleep = r.u32();
    for (let i = 0; i < nSleep; i++) {
      const id = r.u32();
      sleep.set(id, r.i32());
    }
    const rapierLen = r.u32();
    if (this.#rapierBytes.length < rapierLen) this.#rapierBytes = new Uint8Array(rapierLen);
    for (let i = 0; i < rapierLen; i++) this.#rapierBytes[i] = r.u8();
    this.sim.restoreSnapshot(this.#rapierBytes.subarray(0, rapierLen));
    this.#entities = entities;
    this.#joints = joints;
    this.#proxies = proxies;
    this.#sleep = sleep;
    this.#nextEntityId = nextEntityId;
    this.#nextJointId = nextJointId;
    this.#transitions.length = 0;
  }

  /** The awake block's hash seeds the digest of the sleep set, so one value covers both. */
  hash(): number {
    const s = this.#scratch;
    s.reset();
    for (const e of this.#entities.values()) {
      if (this.#sleep.has(e.id)) continue;
      const rb = this.sim.body(e.body);
      s.u32(e.id);
      writePose(rb, s);
      writeVelocity(rb, s);
    }
    const awake = fnv1a32(s.bytes());
    s.reset();
    for (const e of this.#entities.values()) {
      const tick = this.#sleep.get(e.id);
      if (tick === undefined) continue;
      s.u32(e.id);
      s.i32(tick);
    }
    const digest = fnv1a32(s.bytes());
    s.reset();
    s.u32(digest);
    return fnv1a32(s.bytes(), awake);
  }

  /**
   * Layout, parsed by domain-rebuild.ts:
   *   u32 entityCount, then per entity in ascending id:
   *     id u32, kind u16, params (u16 length + bytes), owner u16, bodyType u8, asleep u8, sleepTick i32 (0 when awake),
   *     translation xyz f64, rotation xyzw f64, linvel xyz f64, angvel xyz f64
   *   u32 jointCount, then per joint in ascending id: id u32, a u32, b u32, kind u16, params (u16 length + bytes)
   */
  exportEntities(w: SnapWriter): void {
    w.u32(this.#entities.size);
    for (const e of this.#entities.values()) {
      const rb = this.sim.body(e.body);
      const tick = this.#sleep.get(e.id);
      w.u32(e.id);
      w.u16(e.kind);
      writeParams(w, e.params);
      w.u16(e.owner);
      w.u8(rb.bodyType());
      w.u8(tick === undefined ? 0 : 1);
      w.i32(tick ?? 0);
      writePose(rb, w);
      writeVelocity(rb, w);
    }
    w.u32(this.#joints.size);
    for (const j of this.#joints.values()) {
      w.u32(j.id);
      w.u32(j.a);
      w.u32(j.b);
      w.u16(j.kind);
      writeParams(w, j.params);
    }
  }
}

function proxyKey(source: number, id: EntityId): number {
  return source * 2 ** 32 + id;
}
