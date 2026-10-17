// Arcade kart on Rapier (deterministic build).
//
// Architecture (one body per kart, no wheels):
//   * Rapier owns: gravity, ground contact on a trimesh road, wall contact, kart-kart contact, integration.
//   * The driving law (src/driving.ts) and the mechanics (src/mechanics.ts) run BEFORE world.step() and
//     express their result as a linear velocity (in the ground plane) and a yaw rate on the body.
//   * Everything the game keeps outside the Rapier world (drift, boost) is a Float64 record per kart that is
//     snapshotted and hashed together with the Rapier snapshot.
// Each kart has two colliders on the same body: a "ground ball" (radius = ride height, collides with the
// track only) and a "bump ball" (radius 1.1, collides with other bump balls only), like the reference's
// ray-probe + sphere-sphere model, so wheels are not needed.
import { RapierWorldSim, fnv1a32 } from "@gamesaloon/rollback-rapier";
import type { RapierModule } from "@gamesaloon/rollback-rapier";
import { datan2, dexp, dsincos } from "./detmath.ts";
import type { SinCos } from "./detmath.ts";
import {
  AIR_STEER, DRIFT_GRIP_RATE, GRAVITY, GRIP_RATE, MIN_TOP, SPIKE_STATS, derivePhys, driveSpeed, yawRate,
} from "./driving.ts";
import type { PhysParams } from "./driving.ts";
import { neutralInput, unpackInput } from "./inputCode.ts";
import { MECH_SLOTS, M_BOOST_TIME, M_DRIFT_ACTIVE, M_DRIFT_DIR, M_STAGE, requestBoost, stepBoost, stepDrift } from "./mechanics.ts";
import type { BoostKind } from "./mechanics.ts";
import type { Probe, SimDriver } from "./scenarios.ts";
import { DEFAULT_MESH, buildRoadMesh, buildWallMesh } from "./track.ts";
import type { GridSlot, MeshOptions, TrackData } from "./track.ts";

export interface Tuning {
  /** 'friction': Rapier friction/restitution on the wall collider. 'reference': contact normal from Rapier, response from the reference law. */
  wallModel: "friction" | "reference";
  wallFriction: number;
  wallRestitution: number;
  kartRestitution: number;
  ccd: boolean;
  /** 'trimesh' = real road + walls. 'flat' = a big cuboid (cost baseline: same karts, no mesh). */
  trackMode: "trimesh" | "flat";
  /** Rapier TriMeshFlags.FIX_INTERNAL_EDGES on the road (removes ghost bumps between triangles; adds topology data to the snapshot). */
  fixInternalEdges: boolean;
  /** Rapier solver iterations (default 4). */
  solverIterations?: number;
  mesh: MeshOptions;
}

export const DEFAULT_TUNING: Tuning = {
  wallModel: "friction", wallFriction: 0.3, wallRestitution: 0.3, kartRestitution: 0.4, ccd: true, fixInternalEdges: true, trackMode: "trimesh", mesh: DEFAULT_MESH,
};

// Collision groups (membership << 16 | filter)
const G_TRACK = 0x1, G_GROUND = 0x2, G_BUMP = 0x4, G_RAY = 0x8;
const groups = (m: number, f: number): number => ((m << 16) | f) >>> 0;

// Ground probe (same numbers as the reference)
const PROBE_LIFT = 1.5;
const PROBE_SLACK = 0.6;
const LAND_SLACK = 0.05;
const GROUND_MIN_DOT = 0.5;

// Reference wall response (used by wallModel 'reference')
const WALL_BOUNCE = 0.3;
const WALL_SPEED_KEEP = 0.85;
const WALL_HIT_SPEED = 0.5;

export interface KartSimOptions {
  track: TrackData;
  /** Start pose of each kart (see gridSlots in track.ts). */
  slots: GridSlot[];
  dt?: number;
  phys?: PhysParams;
  tuning?: Partial<Tuning>;
}

const SNAP_MAGIC = 0x4b525031; // "KRP1"

export class KartRapierSim implements SimDriver {
  readonly R: RapierModule;
  readonly sim: RapierWorldSim;
  readonly track: TrackData;
  readonly phys: PhysParams;
  readonly tuning: Tuning;
  readonly kartCount: number;
  readonly dt: number;
  readonly ids: number[] = [];
  trackId = 0;
  /** Drift/boost records, MECH_SLOTS per kart. Part of the snapshot. */
  mech: Float64Array;

  #inp = neutralInput();
  #sc: SinCos = { s: 0, c: 1 };
  #boost = new Float64Array(2);
  #vPre: Float64Array;
  #ray: InstanceType<RapierModule["Ray"]>;
  #rayGroups = groups(G_RAY, G_TRACK);
  #grounded: Uint8Array;

  constructor(R: RapierModule, opts: KartSimOptions) {
    this.R = R;
    this.track = opts.track;
    this.dt = opts.dt ?? 1 / 60;
    this.phys = opts.phys ?? derivePhys(SPIKE_STATS, 100);
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    this.tuning.mesh = { ...DEFAULT_MESH, ...opts.tuning?.mesh };
    this.kartCount = opts.slots.length;
    this.sim = new RapierWorldSim(R, { gravity: { x: 0, y: -GRAVITY, z: 0 }, dt: this.dt });
    if (this.tuning.solverIterations !== undefined) this.sim.world.numSolverIterations = this.tuning.solverIterations;
    this.mech = new Float64Array(this.kartCount * MECH_SLOTS);
    this.#vPre = new Float64Array(this.kartCount * 3);
    this.#grounded = new Uint8Array(this.kartCount);
    this.#ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.#buildTrack();
    for (const slot of opts.slots) this.ids.push(this.#spawn(slot));
  }

  #buildTrack(): void {
    const R = this.R;
    const t = this.tuning;
    const cols: InstanceType<RapierModule["ColliderDesc"]>[] = [];
    const roadGroups = groups(G_TRACK, G_GROUND | G_RAY);
    if (t.trackMode === "trimesh") {
      const road = buildRoadMesh(this.track, t.mesh);
      const wall = buildWallMesh(this.track, t.mesh);
      cols.push(R.ColliderDesc.trimesh(road.vertices, road.indices, t.fixInternalEdges ? R.TriMeshFlags.FIX_INTERNAL_EDGES : undefined).setCollisionGroups(roadGroups).setFriction(0).setRestitution(0)
        .setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitutionCombineRule(R.CoefficientCombineRule.Max));
      const wallFriction = t.wallModel === "friction" ? t.wallFriction : 0;
      const wallRest = t.wallModel === "friction" ? t.wallRestitution : 0;
      cols.push(R.ColliderDesc.trimesh(wall.vertices, wall.indices).setCollisionGroups(roadGroups).setFriction(wallFriction).setRestitution(wallRest)
        .setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitutionCombineRule(R.CoefficientCombineRule.Max));
    } else {
      cols.push(R.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0).setCollisionGroups(roadGroups).setFriction(0).setRestitution(0)
        .setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitutionCombineRule(R.CoefficientCombineRule.Max));
    }
    this.trackId = this.sim.createBody(R.RigidBodyDesc.fixed(), cols);
  }

  #spawn(g: GridSlot): number {
    const R = this.R;
    const yaw = datan2(g.tan[0], g.tan[2]);
    const sc = this.#sc;
    dsincos(yaw * 0.5, sc);
    const m = this.phys.mass;
    const inertia = 0.5 * m * this.phys.radius * this.phys.radius;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(g.pos[0] + g.up[0] * this.phys.rideHeight, g.pos[1] + g.up[1] * this.phys.rideHeight, g.pos[2] + g.up[2] * this.phys.rideHeight)
      .setRotation({ x: 0, y: sc.s, z: 0, w: sc.c })
      .enabledRotations(false, true, false)
      .setCanSleep(false)
      .setCcdEnabled(this.tuning.ccd)
      .setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: inertia, y: inertia, z: inertia }, { x: 0, y: 0, z: 0, w: 1 });
    const ground = R.ColliderDesc.ball(this.phys.rideHeight).setDensity(0).setCollisionGroups(groups(G_GROUND, G_TRACK)).setFriction(0).setRestitution(0)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitutionCombineRule(R.CoefficientCombineRule.Max);
    const bump = R.ColliderDesc.ball(this.phys.radius).setDensity(0).setCollisionGroups(groups(G_BUMP, G_BUMP)).setFriction(0).setRestitution(this.tuning.kartRestitution)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitutionCombineRule(R.CoefficientCombineRule.Max);
    return this.sim.createBody(desc, [ground, bump]);
  }

  get tick(): number { return this.sim.tick; }

  /** Request a boost from outside the physics (boost pad, item): game code decides WHEN, the record keeps the state. */
  requestBoost(kart: number, kind: BoostKind): void {
    requestBoost(this.mech, kart * MECH_SLOTS, kind);
  }

  /** One fixed tick: control law for every kart in id order, then world.step(), then the wall response. */
  step(codes: number[]): void {
    const { sim, phys, dt } = this;
    const world = sim.world;
    const inp = this.#inp;
    const sc = this.#sc;
    const n = this.kartCount;
    for (let i = 0; i < n; i++) {
      const body = sim.body(this.ids[i]);
      const o = i * MECH_SLOTS;
      unpackInput(codes[i], inp);
      const p = body.translation();
      const q = body.rotation();
      const v = body.linvel();
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);

      // ---- ground probe (single ray along -Y; the reference casts along its damped "up")
      const ray = this.#ray;
      ray.origin.x = p.x; ray.origin.y = p.y + PROBE_LIFT; ray.origin.z = p.z;
      const wasGrounded = this.#grounded[i] !== 0;
      const reach = PROBE_LIFT + phys.rideHeight + (wasGrounded ? PROBE_SLACK : LAND_SLACK) + Math.max(0, -v.y) * dt;
      const hit = world.castRayAndGetNormal(ray, reach, true, undefined, this.#rayGroups);
      let nx = 0, ny = 1, nz = 0;
      let grounded = false;
      if (hit !== null) {
        nx = hit.normal.x; ny = hit.normal.y; nz = hit.normal.z;
        grounded = ny > GROUND_MIN_DOT;
      }
      this.#grounded[i] = grounded ? 1 : 0;

      // ---- mechanics (drift, then boost), same order as the reference
      const speed0 = v.x * fx + v.z * fz;
      let vx = v.x, vy = v.y, vz = v.z;
      vy += stepDrift(this.mech, o, inp, speed0, grounded, dt);
      const boost = this.#boost;
      stepBoost(this.mech, o, phys.topSpeed, dt, boost);
      const top = Math.max(MIN_TOP, phys.topSpeed + boost[0]);
      const driftActive = this.mech[o + M_DRIFT_ACTIVE] !== 0;
      const driftDir = driftActive ? this.mech[o + M_DRIFT_DIR] : 0;

      if (grounded) {
        // plane basis: f projected on the road plane, r = f x n
        let ax = fx - nx * (fx * nx + 0 * ny + fz * nz), ay = 0 - ny * (fx * nx + fz * nz), az = fz - nz * (fx * nx + fz * nz);
        const al = 1 / Math.sqrt(ax * ax + ay * ay + az * az);
        ax *= al; ay *= al; az *= al;
        let rx = ay * nz - az * ny, ry = az * nx - ax * nz, rz = ax * ny - ay * nx;
        const w = yawRate(phys.steerRate, inp, vx * ax + vy * ay + vz * az, top, driftDir);
        dsincos(w * dt, sc);
        const c = sc.c, s = sc.s;
        const bx = ax * c + rx * s, by = ay * c + ry * s, bz = az * c + rz * s; // new forward
        const cx = rx * c - ax * s, cy = ry * c - ay * s, cz = rz * c - az * s; // new right
        rx = cx; ry = cy; rz = cz;
        const vf = driveSpeed(vx * bx + vy * by + vz * bz, top, phys.accel + boost[1], inp, dt);
        const grip = driftActive ? DRIFT_GRIP_RATE : GRIP_RATE;
        const vr = (vx * rx + vy * ry + vz * rz) * dexp(-grip * dt);
        const vn = Math.max(0, vx * nx + vy * ny + vz * nz);
        vx = bx * vf + rx * vr + nx * vn;
        vy = by * vf + ry * vr + ny * vn;
        vz = bz * vf + rz * vr + nz * vn;
        body.setAngvel({ x: 0, y: -w, z: 0 }, true);
      } else {
        const w = AIR_STEER * yawRate(phys.steerRate, inp, speed0, top, driftDir);
        body.setAngvel({ x: 0, y: -w, z: 0 }, true);
      }
      body.setLinvel({ x: vx, y: vy, z: vz }, true);
      this.#vPre[i * 3] = vx; this.#vPre[i * 3 + 1] = vy; this.#vPre[i * 3 + 2] = vz;
    }

    sim.step();

    if (this.tuning.wallModel === "reference" && this.tuning.trackMode === "trimesh") this.#wallResponse();
  }

  /** Contact normal from Rapier, response from the reference law (bounce 0.3 + 15 % speed loss on a hard hit). */
  #wallResponse(): void {
    const world = this.sim.world;
    const wallCol = this.sim.body(this.trackId).collider(1);
    for (let i = 0; i < this.kartCount; i++) {
      const body = this.sim.body(this.ids[i]);
      const col = body.collider(0);
      let nx = 0, nz = 0, found = false;
      world.contactPair(wallCol, col, (man, flipped) => {
        if (man.numContacts() === 0) return;
        const nrm = man.normal();
        const k = flipped ? -1 : 1; // normal points from the wall to the ball when !flipped
        // horizontal part only (a ball touching the lower edge of a wall reports a tilted normal), summed over manifolds
        const hl = Math.sqrt(nrm.x * nrm.x + nrm.z * nrm.z);
        if (hl < 1e-6) return;
        nx += (k * nrm.x) / hl; nz += (k * nrm.z) / hl;
        found = true;
      });
      if (!found) continue;
      const nl = Math.sqrt(nx * nx + nz * nz);
      if (!(nl > 1e-6)) continue;
      nx /= nl; nz /= nl;
      const pvx = this.#vPre[i * 3], pvz = this.#vPre[i * 3 + 2];
      const vOut = -(pvx * nx + pvz * nz);
      if (!(vOut > 0)) continue;
      const hard = vOut > WALL_HIT_SPEED;
      const v = body.linvel();
      // start from the pre-step velocity, remove/reflect the wall-normal part
      let vx = pvx + nx * vOut * (hard ? 1 + WALL_BOUNCE : 1);
      let vz = pvz + nz * vOut * (hard ? 1 + WALL_BOUNCE : 1);
      let vy = v.y;
      if (hard) { vx *= WALL_SPEED_KEEP; vz *= WALL_SPEED_KEEP; vy *= 1; }
      body.setLinvel({ x: vx, y: vy, z: vz }, true);
    }
  }

  probe(i: number, p: Probe): void {
    const body = this.sim.body(this.ids[i]);
    const t = body.translation(), q = body.rotation(), v = body.linvel();
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    p.x = t.x; p.y = t.y; p.z = t.z;
    p.fx = fx; p.fz = fz; p.yaw = datan2(fx, fz);
    p.speed = v.x * fx + v.z * fz;
    p.vx = v.x; p.vy = v.y; p.vz = v.z;
    const o = i * MECH_SLOTS;
    p.driftStage = this.mech[o + M_STAGE]; p.driftActive = this.mech[o + M_DRIFT_ACTIVE] !== 0; p.boostTime = this.mech[o + M_BOOST_TIME];
  }

  // ---- rollback surface: snapshot = [magic][kart count][mech doubles][grounded flags][Rapier snapshot]
  takeSnapshot(): Uint8Array {
    const rapier = this.sim.takeSnapshot();
    const n = this.kartCount;
    const mechBytes = n * MECH_SLOTS * 8;
    const out = new Uint8Array(8 + mechBytes + n + rapier.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SNAP_MAGIC, true);
    dv.setUint32(4, n, true);
    for (let k = 0; k < n * MECH_SLOTS; k++) dv.setFloat64(8 + k * 8, this.mech[k], true);
    out.set(this.#grounded, 8 + mechBytes);
    out.set(rapier, 8 + mechBytes + n);
    return out;
  }

  restoreSnapshot(bytes: Uint8Array): void {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== SNAP_MAGIC || dv.getUint32(4, true) !== this.kartCount) throw new Error("bad kart snapshot");
    const n = this.kartCount;
    for (let k = 0; k < n * MECH_SLOTS; k++) this.mech[k] = dv.getFloat64(8 + k * 8, true);
    const mechBytes = n * MECH_SLOTS * 8;
    this.#grounded.set(bytes.subarray(8 + mechBytes, 8 + mechBytes + n));
    this.sim.restoreSnapshot(bytes.subarray(8 + mechBytes + n));
  }

  hash(): number { return fnv1a32(this.takeSnapshot()); }

  free(): void { this.sim.free(); }
}
