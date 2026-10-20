import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { fnv1a32 } from "./hash.ts";
import type { RapierModule } from "./init.ts";

/** Default simulation rate. The sim never reads a wall clock: one step() = one tick. */
export const TICK_RATE = 60;
/** Default fixed timestep handed to Rapier. 1/60 as a double; identical on every platform. */
export const FIXED_DT = 1 / TICK_RATE;

/** Stable body id. Allocated by the sim, never reused, survives snapshot/restore. */
export type BodyId = number;

export interface RapierWorldSimOptions {
  gravity?: { x: number; y: number; z: number };
  /**
   * Ticks per second. Defaults to TICK_RATE (60). Used to derive dt when dt is not given.
   * Must be the same on every peer, like the rest of the configuration.
   */
  tickRate?: number;
  /** Fixed timestep in seconds. Defaults to 1 / tickRate (FIXED_DT for the default rate). */
  dt?: number;
}

const MAGIC = 0x52505231; // "RPR1"
const VERSION = 1;
const HEADER_BYTES = 24; // magic, version, tick, nextId, count, rapierLen
const ENTRY_BYTES = 12; // id u32 + handle f64

/**
 * Rollback-friendly wrapper around a Rapier World.
 *
 * Owns the World, a registry of bodies with stable ids (Rapier handles are only
 * stable within one World lineage; ids are what game code should keep), and the
 * snapshot format: [header][registry][rapier bytes]. hash() = fnv1a32 over exactly
 * those bytes.
 *
 * Wrapping in a core Simulation<TInput> (sketch):
 *   step(inputs)   { applyInputs(sim, inputs); sim.step(); }   // applyInputs: setLinvel/addForce by id, in id order
 *   snapshot(w)    { w.bytes(sim.takeSnapshot()); }
 *   restore(r)     { sim.restoreSnapshot(r.bytes()); }
 *   hash()         { return sim.hash(); }
 *   get tick()     { return sim.tick; }
 *
 * IMPORTANT: restoreSnapshot() replaces the underlying World and frees the old one.
 * Never cache RigidBody / Collider objects across a restore; keep BodyIds and call body(id).
 */
export class RapierWorldSim {
  readonly R: RapierModule;
  readonly tickRate: number;
  readonly dt: number;
  #world: RAPIER.World;
  /** id -> handle, in insertion order (Map preserves it). */
  #handles = new Map<BodyId, number>();
  #nextId = 1;
  /** Ticks since creation, restored with snapshots. */
  tick = 0;

  constructor(R: RapierModule, opts: RapierWorldSimOptions = {}) {
    this.R = R;
    if (opts.tickRate !== undefined && !(Number.isFinite(opts.tickRate) && opts.tickRate > 0)) {
      throw new Error(`invalid tickRate ${opts.tickRate}`);
    }
    this.tickRate = opts.tickRate ?? TICK_RATE;
    this.dt = opts.dt ?? (opts.tickRate === undefined ? FIXED_DT : 1 / this.tickRate);
    const g = opts.gravity ?? { x: 0, y: -9.81, z: 0 };
    this.#world = new R.World(g);
    this.#world.timestep = this.dt;
  }

  get world(): RAPIER.World {
    return this.#world;
  }

  get bodyCount(): number {
    return this.#handles.size;
  }

  /** Create a body (+ colliders). Order of calls is part of the deterministic state. */
  createBody(desc: RAPIER.RigidBodyDesc, colliders: RAPIER.ColliderDesc[] = []): BodyId {
    const rb = this.#world.createRigidBody(desc);
    for (const c of colliders) this.#world.createCollider(c, rb);
    const id = this.#nextId++;
    this.#handles.set(id, rb.handle);
    return id;
  }

  /** Remove a body and its colliders/joints. The id is not reused. */
  removeBody(id: BodyId): void {
    const rb = this.body(id);
    this.#world.removeRigidBody(rb);
    this.#handles.delete(id);
  }

  hasBody(id: BodyId): boolean {
    return this.#handles.has(id);
  }

  /** Live body for an id. Valid until the next restoreSnapshot(). */
  body(id: BodyId): RAPIER.RigidBody {
    const h = this.#handles.get(id);
    if (h === undefined) throw new Error(`unknown body id ${id}`);
    const rb = this.#world.getRigidBody(h);
    if (!rb) throw new Error(`body id ${id} has a stale handle`);
    return rb;
  }

  /** Ids in deterministic (insertion) order. Always iterate this, never a JS Set/object of your own. */
  ids(): BodyId[] {
    return [...this.#handles.keys()];
  }

  /** Advance exactly one fixed tick. Pass an event queue only if you drain it the same way on every peer. */
  step(eventQueue?: RAPIER.EventQueue): void {
    this.#world.step(eventQueue);
    this.tick++;
  }

  /** Serialise world + registry + tick. Same state => same bytes. */
  takeSnapshot(): Uint8Array {
    const rapier = this.#world.takeSnapshot();
    const n = this.#handles.size;
    const out = new Uint8Array(HEADER_BYTES + n * ENTRY_BYTES + rapier.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, VERSION, true);
    dv.setUint32(8, this.tick, true);
    dv.setUint32(12, this.#nextId, true);
    dv.setUint32(16, n, true);
    dv.setUint32(20, rapier.length, true);
    let o = HEADER_BYTES;
    for (const [id, handle] of this.#handles) {
      dv.setUint32(o, id, true);
      dv.setFloat64(o + 4, handle, true);
      o += ENTRY_BYTES;
    }
    out.set(rapier, o);
    return out;
  }

  /** Replace the world with the snapshot state. Frees the previous World (WASM memory). */
  restoreSnapshot(bytes: Uint8Array): void {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) {
      throw new Error("not a RapierWorldSim snapshot (bad magic/version)");
    }
    const tick = dv.getUint32(8, true);
    const nextId = dv.getUint32(12, true);
    const n = dv.getUint32(16, true);
    const len = dv.getUint32(20, true);
    const handles = new Map<BodyId, number>();
    let o = HEADER_BYTES;
    for (let i = 0; i < n; i++) {
      handles.set(dv.getUint32(o, true), dv.getFloat64(o + 4, true));
      o += ENTRY_BYTES;
    }
    const world = this.R.World.restoreSnapshot(bytes.subarray(o, o + len));
    world.timestep = this.dt;
    this.#world.free();
    this.#world = world;
    this.#handles = handles;
    this.#nextId = nextId;
    this.tick = tick;
  }

  /** fnv1a32 over the exact snapshot bytes. Costs one snapshot. */
  hash(): number {
    return fnv1a32(this.takeSnapshot());
  }

  /** Release WASM memory. The sim is unusable afterwards. */
  free(): void {
    this.#world.free();
  }
}
