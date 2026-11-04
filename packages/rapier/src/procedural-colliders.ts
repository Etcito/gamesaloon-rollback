import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { RapierModule } from "./init.ts";
import type { BodyId, RapierWorldSim } from "./world-sim.ts";

export type ProceduralColliderShape =
  | "cuboid"
  | "roundCuboid"
  | "ball"
  | "capsule"
  | "cylinder"
  | "cone"
  | "convexHull";

export interface ProceduralCollider {
  instance: number;
  key: number;
  shape: ProceduralColliderShape;
  t: [number, number, number];
  r: [number, number, number, number];
  halfExtents?: [number, number, number];
  borderRadius?: number;
  radius?: number;
  halfHeight?: number;
  points?: number[];
  fitted?: true;
}

export interface ProceduralColliderError {
  path: string;
  message: string;
}

export type ProceduralColliderValidation =
  | { ok: true; colliders: ProceduralCollider[] }
  | { ok: false; error: ProceduralColliderError };

type ErrorResult = { ok: false; error: ProceduralColliderError };

const SHAPES: readonly ProceduralColliderShape[] = [
  "cuboid",
  "roundCuboid",
  "ball",
  "capsule",
  "cylinder",
  "cone",
  "convexHull",
];

const QUAT_NORM_TOLERANCE = 1e-6;
const MAX_KEY = 4294967295;

function fail(path: string, message: string): ErrorResult {
  return { ok: false, error: { path, message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isShape(v: unknown): v is ProceduralColliderShape {
  return typeof v === "string" && (SHAPES as readonly string[]).includes(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function readVec3(v: unknown, path: string): { ok: true; value: [number, number, number] } | ErrorResult {
  if (!Array.isArray(v) || v.length !== 3) return fail(path, "must be three numbers");
  for (let i = 0; i < 3; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  return { ok: true, value: [v[0], v[1], v[2]] };
}

function readQuat(
  v: unknown,
  path: string,
): { ok: true; value: [number, number, number, number] } | ErrorResult {
  if (!Array.isArray(v) || v.length !== 4) return fail(path, "must be four numbers");
  for (let i = 0; i < 4; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  const q = [v[0], v[1], v[2], v[3]] as [number, number, number, number];
  if (Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) > QUAT_NORM_TOLERANCE) {
    return fail(path, "must be a rotation of length one");
  }
  return { ok: true, value: q };
}

function checkHalfExtents(v: unknown, path: string, allowZero: boolean): ErrorResult | null {
  if (!Array.isArray(v) || v.length !== 3) return fail(path, "must be three numbers");
  for (let i = 0; i < 3; i++) {
    const x = v[i];
    if (!isFiniteNumber(x)) return fail(`${path}/${i}`, "must be a finite number");
    if (allowZero ? x < 0 : x <= 0) {
      return fail(`${path}/${i}`, allowZero ? "must be zero or greater" : "must be greater than zero");
    }
  }
  return null;
}

function checkPositive(v: unknown, path: string): ErrorResult | null {
  if (!isFiniteNumber(v)) return fail(path, "must be a finite number");
  if (v <= 0) return fail(path, "must be greater than zero");
  return null;
}

function checkNonNegative(v: unknown, path: string): ErrorResult | null {
  if (!isFiniteNumber(v)) return fail(path, "must be a finite number");
  if (v < 0) return fail(path, "must be zero or greater");
  return null;
}

function checkPoints(v: unknown, path: string): ErrorResult | null {
  if (!Array.isArray(v)) return fail(path, "must be a list of corner coordinates");
  if (v.length % 3 !== 0) return fail(path, "must hold three coordinates per corner");
  const corners = v.length / 3;
  if (corners < 4 || corners > 64) return fail(path, "must have four to sixty-four corners");
  for (let i = 0; i < v.length; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  return null;
}

function checkSizes(c: Record<string, unknown>, base: string): ErrorResult | null {
  const shape = c.shape as ProceduralColliderShape;
  if (shape === "cuboid" || shape === "roundCuboid") {
    const extents = checkHalfExtents(c.halfExtents, `${base}/halfExtents`, shape === "roundCuboid");
    if (extents) return extents;
    if (shape === "roundCuboid") return checkPositive(c.borderRadius, `${base}/borderRadius`);
    return null;
  }
  if (shape === "ball") return checkPositive(c.radius, `${base}/radius`);
  if (shape === "capsule") {
    const radius = checkPositive(c.radius, `${base}/radius`);
    if (radius) return radius;
    return checkNonNegative(c.halfHeight, `${base}/halfHeight`);
  }
  if (shape === "cylinder" || shape === "cone") {
    const radius = checkPositive(c.radius, `${base}/radius`);
    if (radius) return radius;
    return checkPositive(c.halfHeight, `${base}/halfHeight`);
  }
  return checkPoints(c.points, `${base}/points`);
}

function validateOne(c: unknown, base: string): { ok: true; value: ProceduralCollider } | ErrorResult {
  if (!isRecord(c)) return fail(base, "must be an object");
  if (!Number.isInteger(c.instance) || (c.instance as number) < 0) {
    return fail(`${base}/instance`, "must be a non-negative integer");
  }
  if (!Number.isInteger(c.key) || (c.key as number) < 0 || (c.key as number) > MAX_KEY) {
    return fail(`${base}/key`, "must be an integer from zero to 4294967295");
  }
  if (!isShape(c.shape)) {
    return fail(`${base}/shape`, "must be cuboid, roundCuboid, ball, capsule, cylinder, cone or convexHull");
  }
  const t = readVec3(c.t, `${base}/t`);
  if (!t.ok) return t;
  const r = readQuat(c.r, `${base}/r`);
  if (!r.ok) return r;
  const sizes = checkSizes(c, base);
  if (sizes) return sizes;
  if (c.fitted !== undefined && c.fitted !== true) {
    return fail(`${base}/fitted`, "must be true when present");
  }
  return { ok: true, value: c as unknown as ProceduralCollider };
}

export function validateProceduralColliders(v: unknown): ProceduralColliderValidation {
  try {
    let list: unknown;
    if (Array.isArray(v)) list = v;
    else if (isRecord(v)) list = v.colliders;
    else return fail("", "must be a list of colliders or an object with a colliders list");
    if (!Array.isArray(list)) return fail("/colliders", "must be a list of colliders");
    const colliders: ProceduralCollider[] = [];
    for (let i = 0; i < list.length; i++) {
      const one = validateOne(list[i], `/colliders/${i}`);
      if (!one.ok) return one;
      colliders.push(one.value);
    }
    return { ok: true, colliders };
  } catch {
    return fail("", "must be a list of colliders or an object with a colliders list");
  }
}

export function proceduralColliderDesc(rapier: RapierModule, c: ProceduralCollider): RAPIER.ColliderDesc {
  const [hx, hy, hz] = c.halfExtents ?? [0, 0, 0];
  let desc: RAPIER.ColliderDesc;
  switch (c.shape) {
    case "cuboid":
      desc = rapier.ColliderDesc.cuboid(hx, hy, hz);
      break;
    case "roundCuboid":
      desc = rapier.ColliderDesc.roundCuboid(hx, hy, hz, c.borderRadius ?? 0);
      break;
    case "ball":
      desc = rapier.ColliderDesc.ball(c.radius ?? 0);
      break;
    case "capsule":
      desc = rapier.ColliderDesc.capsule(c.halfHeight ?? 0, c.radius ?? 0);
      break;
    case "cylinder":
      desc = rapier.ColliderDesc.cylinder(c.halfHeight ?? 0, c.radius ?? 0);
      break;
    case "cone":
      desc = rapier.ColliderDesc.cone(c.halfHeight ?? 0, c.radius ?? 0);
      break;
    case "convexHull": {
      const hull = rapier.ColliderDesc.convexHull(new Float32Array(c.points ?? []));
      if (!hull) {
        throw new Error(
          `collider instance ${c.instance} key ${c.key} has convex hull points that form no volume`,
        );
      }
      desc = hull;
      break;
    }
    default:
      throw new Error(`collider instance ${c.instance} key ${c.key} has an unknown shape`);
  }
  desc.setTranslation(c.t[0], c.t[1], c.t[2]);
  desc.setRotation({ x: c.r[0], y: c.r[1], z: c.r[2], w: c.r[3] });
  return desc;
}

export interface ProceduralColliderPlacement {
  t: [number, number, number];
  r: [number, number, number, number];
}

export interface ProceduralColliderOptions {
  placement?: ProceduralColliderPlacement;
  friction?: number;
  restitution?: number;
  collisionGroups?: number;
  baseId?: number;
}

const IDENTITY_PLACEMENT: ProceduralColliderPlacement = { t: [0, 0, 0], r: [0, 0, 0, 1] };

export class ProceduralColliderSet {
  readonly body: BodyId;
  readonly handles: number[];
  readonly entityIds: number[];
  #world: RapierWorldSim;
  #disposed = false;

  constructor(
    world: RapierWorldSim,
    rapier: RapierModule,
    colliders: ProceduralCollider[],
    options: ProceduralColliderOptions = {},
  ) {
    this.#world = world;
    const placement = options.placement ?? IDENTITY_PLACEMENT;
    const friction = options.friction ?? 0.5;
    const restitution = options.restitution ?? 0;
    const baseId = options.baseId ?? 0;
    const descs = colliders.map((c) => {
      const desc = proceduralColliderDesc(rapier, c);
      desc.setFriction(friction);
      desc.setRestitution(restitution);
      if (options.collisionGroups !== undefined) desc.setCollisionGroups(options.collisionGroups);
      return desc;
    });
    const bodyDesc = rapier.RigidBodyDesc.fixed()
      .setTranslation(placement.t[0], placement.t[1], placement.t[2])
      .setRotation({ x: placement.r[0], y: placement.r[1], z: placement.r[2], w: placement.r[3] });
    this.body = world.createBody(bodyDesc, descs);
    const rigidBody = world.body(this.body);
    this.handles = colliders.map((_, i) => rigidBody.collider(i).handle);
    this.entityIds = colliders.map((c) => (baseId + c.key) >>> 0);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#world.removeBody(this.body);
  }
}
