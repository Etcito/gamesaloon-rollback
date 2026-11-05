import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { RapierModule } from "./init.ts";
import { proceduralColliderDesc } from "./procedural-colliders.ts";
import type { ProceduralCollider, ProceduralColliderPlacement } from "./procedural-colliders.ts";
import { validateProceduralDynamics } from "./procedural-dynamics.ts";
import type { ProceduralDynamics, ProceduralJoint } from "./procedural-dynamics.ts";
import type { BodyId, RapierWorldSim } from "./world-sim.ts";

export interface ProceduralDynamicsOptions {
  placement?: ProceduralColliderPlacement;
  baseId?: number;
  collisionGroups?: number;
}

const IDENTITY_PLACEMENT: ProceduralColliderPlacement = { t: [0, 0, 0], r: [0, 0, 0, 1] };
const DEG_TO_RAD = Math.PI / 180;

function vector(v: [number, number, number]): RAPIER.Vector {
  return { x: v[0], y: v[1], z: v[2] };
}

function rotation(q: [number, number, number, number]): RAPIER.Rotation {
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}

function inverse(q: RAPIER.Rotation): RAPIER.Rotation {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
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

function transform(t: RAPIER.Vector, r: RAPIER.Rotation, v: RAPIER.Vector): RAPIER.Vector {
  const p = rotate(r, v);
  return { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z };
}

// Joint anchors and axes are already in the attached bodies' local frames.
function jointData(
  rapier: RapierModule,
  joint: ProceduralJoint,
  a: RAPIER.RigidBody,
  b: RAPIER.RigidBody,
): RAPIER.JointData {
  const anchorA = vector(joint.anchorA);
  const anchorB = vector(joint.anchorB);
  switch (joint.kind) {
    case "fixed":
      return rapier.JointData.fixed(
        anchorA, rapier.RotationOps.identity(), anchorB, rapier.RotationOps.identity(),
      );
    case "hinge":
      return rapier.JointData.revolute(anchorA, anchorB, vector(joint.axis));
    case "slider":
      return rapier.JointData.prismatic(anchorA, anchorB, vector(joint.axis));
    case "ball":
      return rapier.JointData.spherical(anchorA, anchorB);
    case "spring": {
      const pa = transform(a.translation(), a.rotation(), anchorA);
      const pb = transform(b.translation(), b.rotation(), anchorB);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      return rapier.JointData.spring(
        Math.sqrt(dx * dx + dy * dy + dz * dz),
        joint.stiffness ?? 0, joint.damping ?? 0, anchorA, anchorB,
      );
    }
    case "rope":
      return rapier.JointData.rope(joint.lengthM ?? 0, anchorA, anchorB);
  }
}

function configureJoint(rapier: RapierModule, joint: ProceduralJoint, created: RAPIER.ImpulseJoint): void {
  if (joint.kind !== "hinge" && joint.kind !== "slider") return;
  const unit = created as RAPIER.UnitImpulseJoint;
  const scale = joint.kind === "hinge" ? DEG_TO_RAD : 1;
  const limits = joint.kind === "hinge" ? joint.limitsDeg : joint.limitsM;
  if (limits) unit.setLimits(limits[0] * scale, limits[1] * scale);
  const motor = joint.motor;
  if (!motor?.enabled) return;
  unit.configureMotorModel(rapier.MotorModel.ForceBased);
  if (motor.mode === "speed") {
    const speed = joint.kind === "hinge" ? motor.speedDegS : motor.speedMS;
    unit.configureMotorVelocity((speed ?? 0) * scale, motor.damping ?? 0);
  } else {
    const target = joint.kind === "hinge" ? motor.targetDeg : motor.targetM;
    unit.configureMotorPosition((target ?? 0) * scale, motor.stiffness ?? 0, motor.damping ?? 0);
  }
  unit.setMotorMaxForce(motor.maxForce);
}

/** Creates bodies, colliders and joints in a stable order without retaining live Rapier objects. */
export class ProceduralDynamicsSet {
  readonly bodies = new Map<string, BodyId>();
  readonly joints = new Map<string, number>();
  readonly entityIds: number[] = [];
  #world: RapierWorldSim;
  #disposed = false;

  constructor(
    world: RapierWorldSim,
    rapier: RapierModule,
    dynamics: ProceduralDynamics,
    colliders: ProceduralCollider[],
    options: ProceduralDynamicsOptions = {},
  ) {
    const validated = validateProceduralDynamics(dynamics, colliders.length);
    if (!validated.ok) throw new Error(`${validated.error.path}: ${validated.error.message}`);
    this.#world = world;
    const placement = options.placement ?? IDENTITY_PLACEMENT;
    const placementT = vector(placement.t);
    const placementR = rotation(placement.r);
    const baseId = options.baseId ?? 0;
    const ordered = [
      ...validated.dynamics.bodies.filter((body) => body.id !== "static"),
      ...validated.dynamics.bodies.filter((body) => body.id === "static"),
    ];
    // Prepare all collider descriptors before creating anything.
    const prepared = ordered.map((body) => {
      const t = vector(body.t);
      const r = rotation(body.r);
      const invR = inverse(r);
      const descs = body.colliders.map((index) => {
        const c = colliders[index];
        const localT = rotate(invR, { x: c.t[0] - t.x, y: c.t[1] - t.y, z: c.t[2] - t.z });
        const desc = proceduralColliderDesc(rapier, c)
          .setTranslation(localT.x, localT.y, localT.z)
          .setRotation(multiply(invR, rotation(c.r)))
          .setDensity(body.density)
          .setFriction(body.friction)
          .setRestitution(body.restitution);
        if (options.collisionGroups !== undefined) desc.setCollisionGroups(options.collisionGroups);
        return desc;
      });
      const desc = body.type === "fixed" ? rapier.RigidBodyDesc.fixed()
        : body.type === "kinematic" ? rapier.RigidBodyDesc.kinematicPositionBased()
        : rapier.RigidBodyDesc.dynamic();
      const p = transform(placementT, placementR, t);
      desc.setTranslation(p.x, p.y, p.z)
        .setRotation(multiply(placementR, r))
        .setLinearDamping(body.linearDamping)
        .setAngularDamping(body.angularDamping)
        .setGravityScale(body.gravityScale)
        .setCcdEnabled(body.ccd);
      return { body, desc, descs };
    });
    try {
      for (const { body, desc, descs } of prepared) {
        const id = world.createBody(desc, descs);
        this.bodies.set(body.id, id);
        const key = body.id === "static" ? 0 : Number.parseInt(body.id.slice(2), 16);
        this.entityIds.push((baseId + key) >>> 0);
      }
      for (const joint of validated.dynamics.joints) {
        const a = world.body(this.bodies.get(joint.a)!);
        const b = world.body(this.bodies.get(joint.b)!);
        const created = world.world.createImpulseJoint(jointData(rapier, joint, a, b), a, b, true);
        this.joints.set(joint.id, created.handle);
        configureJoint(rapier, joint, created);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Rapier removes attached colliders and joints with each body. Resolve ids again after restores.
    for (const id of this.bodies.values()) {
      if (this.#world.hasBody(id)) this.#world.removeBody(id);
    }
  }
}
