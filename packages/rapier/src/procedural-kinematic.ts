import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { RapierModule } from "./init.ts";
import { proceduralColliderDesc } from "./procedural-colliders.ts";
import type {
  ProceduralCollider,
  ProceduralColliderPlacement,
  ProceduralColliderShape,
} from "./procedural-colliders.ts";
import type { BodyId, RapierWorldSim } from "./world-sim.ts";

export interface LocalCollider {
  shape: ProceduralColliderShape;
  t: [number, number, number];
  r: [number, number, number, number];
  halfExtents?: [number, number, number];
  borderRadius?: number;
  radius?: number;
  halfHeight?: number;
  points?: number[];
}

export interface ProceduralColliderFrame {
  key: number;
  t: [number, number, number];
  r: [number, number, number, number];
  colliders: LocalCollider[];
}

export interface ProceduralKinematicsOptions {
  baseId?: number;
  placement?: ProceduralColliderPlacement;
}

const IDENTITY_PLACEMENT: ProceduralColliderPlacement = { t: [0, 0, 0], r: [0, 0, 0, 1] };

interface FrameBody {
  body: BodyId;
  colliders: LocalCollider[];
}

function multiply(a: RAPIER.Rotation, b: RAPIER.Rotation): RAPIER.Rotation {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rotate(q: RAPIER.Rotation, v: RAPIER.Vector): RAPIER.Vector {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

function colliderDesc(rapier: RapierModule, key: number, collider: LocalCollider): RAPIER.ColliderDesc {
  const record: ProceduralCollider = { instance: 0, key, ...collider };
  return proceduralColliderDesc(rapier, record);
}

export class ProceduralKinematics {
  readonly #world: RapierWorldSim;
  readonly #rapier: RapierModule;
  readonly #placement: ProceduralColliderPlacement;
  readonly #baseId: number;
  readonly #bodies = new Map<number, FrameBody>();
  // Keep removed associations: an older snapshot can bring those bodies back.
  readonly #history = new Map<BodyId, { key: number; entry: FrameBody }>();
  #liveWorld: RAPIER.World;
  #disposed = false;

  constructor(
    world: RapierWorldSim,
    rapier: RapierModule,
    options: ProceduralKinematicsOptions = {},
  ) {
    this.#world = world;
    this.#liveWorld = world.world;
    this.#rapier = rapier;
    this.#placement = options.placement ?? IDENTITY_PLACEMENT;
    this.#baseId = options.baseId ?? 0;
  }

  get baseId(): number {
    return this.#baseId;
  }

  #syncRestoredBodies(): void {
    if (this.#liveWorld === this.#world.world) return;
    this.#liveWorld = this.#world.world;
    this.#bodies.clear();
    for (const id of this.#world.ids()) {
      const saved = this.#history.get(id);
      if (saved !== undefined) this.#bodies.set(saved.key, saved.entry);
    }
  }

  #pose(frame: ProceduralColliderFrame): { t: RAPIER.Vector; r: RAPIER.Rotation } {
    const placement = this.#placement;
    const r = multiply(
      { x: placement.r[0], y: placement.r[1], z: placement.r[2], w: placement.r[3] },
      { x: frame.r[0], y: frame.r[1], z: frame.r[2], w: frame.r[3] },
    );
    const local = rotate(
      { x: placement.r[0], y: placement.r[1], z: placement.r[2], w: placement.r[3] },
      { x: frame.t[0], y: frame.t[1], z: frame.t[2] },
    );
    return {
      t: { x: placement.t[0] + local.x, y: placement.t[1] + local.y, z: placement.t[2] + local.z },
      r,
    };
  }

  apply(frames: readonly ProceduralColliderFrame[]): void {
    if (this.#disposed) throw new Error("procedural kinematics is disposed");
    this.#syncRestoredBodies();
    const byKey = new Map<number, ProceduralColliderFrame>();
    for (const frame of frames) byKey.set(frame.key, frame);
    const keys = [...byKey.keys()].sort((a, b) => a - b);

    const stale = [...this.#bodies.keys()].filter((key) => !byKey.has(key)).sort((a, b) => a - b);
    for (const key of stale) {
      const entry = this.#bodies.get(key)!;
      if (this.#world.hasBody(entry.body)) this.#world.removeBody(entry.body);
      this.#bodies.delete(key);
    }

    for (const key of keys) {
      const frame = byKey.get(key)!;
      const pose = this.#pose(frame);
      let entry = this.#bodies.get(key);
      if (entry !== undefined && !this.#world.hasBody(entry.body)) {
        this.#bodies.delete(key);
        entry = undefined;
      }
      if (entry === undefined) {
        const colliders = frame.colliders ?? [];
        const descs = colliders.map((collider) => colliderDesc(this.#rapier, key, collider));
        const bodyDesc = this.#rapier.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(pose.t.x, pose.t.y, pose.t.z)
          .setRotation(pose.r);
        const body = this.#world.createBody(bodyDesc, descs);
        const bodyRef = this.#world.body(body);
        bodyRef.setNextKinematicTranslation(pose.t);
        bodyRef.setNextKinematicRotation(pose.r);
        const created = { body, colliders };
        this.#bodies.set(key, created);
        this.#history.set(body, { key, entry: created });
        continue;
      }
      const body = this.#world.body(entry.body);
      body.setNextKinematicTranslation(pose.t);
      body.setNextKinematicRotation(pose.r);
    }
  }

  bodyOf(key: number): BodyId | undefined {
    this.#syncRestoredBodies();
    const entry = this.#bodies.get(key);
    if (entry === undefined) return undefined;
    return this.#world.hasBody(entry.body) ? entry.body : undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#syncRestoredBodies();
    this.#disposed = true;
    const keys = [...this.#bodies.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const entry = this.#bodies.get(key)!;
      if (this.#world.hasBody(entry.body)) this.#world.removeBody(entry.body);
    }
    this.#bodies.clear();
    this.#history.clear();
  }
}
