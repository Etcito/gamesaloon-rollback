/**
 * Procedural mechanisms: the S13 switches, levers, logic nodes, links and
 * kinematic animations of a procedural object.
 *
 * The state is explicit and small (one record per signal, logic node, link and
 * animation in declaration order). It is serialised in a fixed little-endian
 * layout, so a rollback restores the Rapier world and the mechanism state
 * together. Nothing here reads a wall clock or a random source: every decision
 * is driven by world.tick, and angles only use Math on values (authored inputs
 * and ticks) that are identical on every peer.
 */

import type RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { RapierModule } from "./init.ts";
import type {
  ProceduralAnimation,
  ProceduralDynamics,
  ProceduralJoint,
  ProceduralLever,
  ProceduralLink,
  ProceduralLogic,
  ProceduralMotor,
  ProceduralSwitch,
} from "./procedural-dynamics.ts";
import type { BodyId, RapierWorldSim } from "./world-sim.ts";

export type ProceduralAnimationPlayState = "stopped" | "playing" | "reversed" | "paused";

export interface ProceduralAnimationStatus {
  state: ProceduralAnimationPlayState;
  time: number;
  startTick: number;
}

const MAGIC = 0x4d454348; // "HCEM"
const VERSION = 1;
const HEADER_BYTES = 28;
const SWITCH_BYTES = 1;
const LEVER_BYTES = 1;
const LOGIC_BYTES = 17;
const LINK_BYTES = 2;
const ANIMATION_BYTES = 13;

const STOPPED = 0;
const PLAYING = 1;
const REVERSED = 2;
const PAUSED = 3;

const PLAY_NAMES: readonly ProceduralAnimationPlayState[] = [
  "stopped",
  "playing",
  "reversed",
  "paused",
];
const ACTION_CODES = { play: PLAYING, reverse: REVERSED, pause: PAUSED, stop: STOPPED } as const;

const DEG_TO_RAD = Math.PI / 180;
const DOOR_STIFFNESS = 100;
const DOOR_DAMPING = 10;
const DOOR_MAX_FORCE = 1000;

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface SwitchState {
  on: boolean;
}

interface LeverState {
  on: boolean;
}

interface LogicState {
  on: boolean;
  prev: boolean;
  toggle: boolean;
  counter: number;
  timerStart: number;
  timerArmed: boolean;
  delayStart: number;
  delayTarget: boolean;
}

interface LinkState {
  applied: boolean;
  on: boolean;
}

interface AnimationState {
  state: number;
  time: number;
  startTick: number;
}

interface RestPose {
  t: [number, number, number];
  r: [number, number, number, number];
}

function vector(v: readonly [number, number, number]): Vector3 {
  return { x: v[0], y: v[1], z: v[2] };
}

function rotation(q: readonly [number, number, number, number]): Quaternion {
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}

function inverse(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rotate(q: Quaternion, v: Vector3): Vector3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

function transform(t: Vector3, q: Quaternion, v: Vector3): Vector3 {
  const p = rotate(q, v);
  return { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z };
}

/** MAMA quatFromEulerDeg: XYZ degrees, the same formula on every peer. */
function eulerDegToQuat(e: readonly [number, number, number]): Quaternion {
  const c1 = Math.cos((e[0] * DEG_TO_RAD) / 2);
  const s1 = Math.sin((e[0] * DEG_TO_RAD) / 2);
  const c2 = Math.cos((e[1] * DEG_TO_RAD) / 2);
  const s2 = Math.sin((e[1] * DEG_TO_RAD) / 2);
  const c3 = Math.cos((e[2] * DEG_TO_RAD) / 2);
  const s3 = Math.sin((e[2] * DEG_TO_RAD) / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

function mod(a: number, b: number): number {
  const r = a - Math.floor(a / b) * b;
  return r === 0 ? 0 : r;
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** Signed twist of a relative rotation about a world axis, in radians. */
function twistAngle(qa: Quaternion, qb: Quaternion, frame: Quaternion, localAxis: Vector3): number {
  let rel = multiply(qb, inverse(qa));
  let v = { x: rel.x, y: rel.y, z: rel.z };
  let w = rel.w;
  if (w < 0) {
    v = { x: -v.x, y: -v.y, z: -v.z };
    w = -w;
  }
  const world = rotate(frame, localAxis);
  const projected = v.x * world.x + v.y * world.y + v.z * world.z;
  let angle = 2 * Math.atan2(projected, w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

interface SampledKey {
  t: [number, number, number];
  rDeg: [number, number, number];
}

function sampleKeys(anim: ProceduralAnimation, time: number): SampledKey | null {
  const keys = anim.keys;
  if (keys.length === 0) return null;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (time <= first.atS) return { t: [...first.t], rDeg: [...first.rDeg] };
  if (time >= last.atS) return { t: [...last.t], rDeg: [...last.rDeg] };
  let index = 0;
  while (index + 1 < keys.length && keys[index + 1].atS <= time) index++;
  const a = keys[index];
  const b = keys[index + 1];
  const span = b.atS - a.atS;
  let u = span > 0 ? (time - a.atS) / span : 1;
  if (anim.easing === "smooth") u = smoothstep(u);
  return {
    t: [
      a.t[0] + (b.t[0] - a.t[0]) * u,
      a.t[1] + (b.t[1] - a.t[1]) * u,
      a.t[2] + (b.t[2] - a.t[2]) * u,
    ],
    rDeg: [
      a.rDeg[0] + (b.rDeg[0] - a.rDeg[0]) * u,
      a.rDeg[1] + (b.rDeg[1] - a.rDeg[1]) * u,
      a.rDeg[2] + (b.rDeg[2] - a.rDeg[2]) * u,
    ],
  };
}

/**
 * Deterministic mechanism stepper for one procedural object.
 *
 * Create it once, right after its ProceduralDynamicsSet, with that set's body
 * and joint tables. Call beforeStep() before every world step, and take /
 * restore its snapshot together with the RapierWorldSim snapshot.
 */
export class ProceduralMechanismSet {
  #world: RapierWorldSim;
  #rapier: RapierModule;
  #bodies: Map<string, BodyId>;
  #joints: Map<string, number>;
  #switches: ProceduralSwitch[];
  #levers: ProceduralLever[];
  #logic: ProceduralLogic[];
  #links: ProceduralLink[];
  #animations: ProceduralAnimation[];
  #jointDefs: Map<string, ProceduralJoint>;
  #restPose: Map<string, RestPose> = new Map();
  #restAngle = new Map<string, number>();
  #restTravel = new Map<string, number>();
  #restLength = new Map<string, number>();
  #switchStates: SwitchState[] = [];
  #leverStates: LeverState[] = [];
  #logicStates: LogicState[] = [];
  #linkStates: LinkState[] = [];
  #animationStates: AnimationState[] = [];

  constructor(
    world: RapierWorldSim,
    rapier: RapierModule,
    dynamics: ProceduralDynamics,
    bodies: ReadonlyMap<string, BodyId>,
    joints: ReadonlyMap<string, number>,
  ) {
    this.#world = world;
    this.#rapier = rapier;
    this.#bodies = new Map(bodies);
    this.#joints = new Map(joints);
    this.#jointDefs = new Map(dynamics.joints.map((joint) => [joint.id, joint]));
    const mechanisms = dynamics.mechanisms ?? {};
    this.#switches = [...(mechanisms.switches ?? [])];
    this.#levers = [...(mechanisms.levers ?? [])];
    this.#logic = [...(mechanisms.logic ?? [])];
    this.#links = [...(mechanisms.links ?? [])];
    this.#animations = [...(mechanisms.animations ?? [])];
    this.#switchStates = this.#switches.map(() => ({ on: false }));
    this.#leverStates = this.#levers.map(() => ({ on: false }));
    this.#logicStates = this.#logic.map(() => ({
      on: false,
      prev: false,
      toggle: false,
      counter: 0,
      timerStart: 0,
      timerArmed: false,
      delayStart: 0,
      delayTarget: false,
    }));
    this.#linkStates = this.#links.map(() => ({ applied: false, on: false }));
    this.#animationStates = this.#animations.map((animation) => ({
      state: animation.autostart ? PLAYING : STOPPED,
      time: 0,
      startTick: world.tick,
    }));

    for (const body of dynamics.bodies) {
      const id = this.#bodies.get(body.id);
      if (id === undefined || !world.hasBody(id)) continue;
      const rb = world.body(id);
      const t = rb.translation();
      const r = rb.rotation();
      this.#restPose.set(body.id, { t: [t.x, t.y, t.z], r: [r.x, r.y, r.z, r.w] });
    }
    for (const joint of dynamics.joints) {
      this.#captureJointRest(joint);
    }
  }

  #captureJointRest(joint: ProceduralJoint): void {
    const aId = this.#bodies.get(joint.a);
    const bId = this.#bodies.get(joint.b);
    if (aId === undefined || bId === undefined) return;
    if (!this.#world.hasBody(aId) || !this.#world.hasBody(bId)) return;
    const a = this.#world.body(aId);
    const b = this.#world.body(bId);
    const qa = a.rotation();
    const qb = b.rotation();
    if (joint.kind === "hinge") {
      this.#restAngle.set(
        joint.id,
        twistAngle(qa, qb, qa, vector(joint.axis)),
      );
    }
    if (joint.kind === "slider") {
      const pa = transform(a.translation(), qa, vector(joint.anchorA));
      const pb = transform(b.translation(), qb, vector(joint.anchorB));
      const axis = rotate(qa, vector(joint.axis));
      this.#restTravel.set(
        joint.id,
        (pb.x - pa.x) * axis.x + (pb.y - pa.y) * axis.y + (pb.z - pa.z) * axis.z,
      );
    }
    if (joint.kind === "spring") {
      const pa = transform(a.translation(), qa, vector(joint.anchorA));
      const pb = transform(b.translation(), qb, vector(joint.anchorB));
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      this.#restLength.set(joint.id, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }

  /** Evaluate the mechanisms in the fixed order: switches, levers, logic, links, animations. */
  beforeStep(): void {
    const tick = this.#world.tick;
    this.#stepSwitches();
    this.#stepLevers();
    this.#stepLogic(tick);
    this.#stepLinks();
    this.#stepAnimations(tick);
  }

  #signal(id: string): boolean {
    for (let i = 0; i < this.#switches.length; i++) {
      if (this.#switches[i].id === id) return this.#switchStates[i].on;
    }
    for (let i = 0; i < this.#levers.length; i++) {
      if (this.#levers[i].id === id) return this.#leverStates[i].on;
    }
    for (let i = 0; i < this.#logic.length; i++) {
      if (this.#logic[i].id === id) return this.#logicStates[i].on;
    }
    return false;
  }

  #hysteresis(current: boolean, value: number, on: number, off: number): boolean {
    if (current) return value > off;
    return value >= on;
  }

  #stepSwitches(): void {
    for (let i = 0; i < this.#switches.length; i++) {
      const entry = this.#switches[i];
      const state = this.#switchStates[i];
      let value = 0;
      if (entry.mode === "weight") {
        value = this.#plateWeight(entry.plate);
      } else {
        const joint = entry.joint ? this.#jointDefs.get(entry.joint) : undefined;
        value = joint ? Math.abs(this.#jointTravel(joint)) : 0;
      }
      const on = entry.mode === "weight"
        ? (entry.onKg ?? Number.POSITIVE_INFINITY)
        : (entry.onM ?? Number.POSITIVE_INFINITY);
      const off = entry.mode === "weight"
        ? (entry.offKg ?? entry.onKg ?? 0)
        : (entry.offM ?? entry.onM ?? 0);
      state.on = this.#hysteresis(state.on, value, on, off);
    }
  }

  #plateWeight(bodyId: string): number {
    const id = this.#bodies.get(bodyId);
    if (id === undefined || !this.#world.hasBody(id)) return 0;
    const plate = this.#world.body(id);
    const masses = new Map<number, number>();
    for (let i = 0; i < plate.numColliders(); i++) {
      this.#world.world.contactPairsWith(plate.collider(i), (other) => {
        const parent = other.parent();
        if (parent && parent.isDynamic()) masses.set(parent.handle, parent.mass());
      });
    }
    const handles = [...masses.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const handle of handles) total += masses.get(handle) ?? 0;
    return total;
  }

  #jointTravel(joint: ProceduralJoint): number {
    const aId = this.#bodies.get(joint.a);
    const bId = this.#bodies.get(joint.b);
    if (aId === undefined || bId === undefined) return 0;
    if (!this.#world.hasBody(aId) || !this.#world.hasBody(bId)) return 0;
    const a = this.#world.body(aId);
    const b = this.#world.body(bId);
    const pa = transform(a.translation(), a.rotation(), vector(joint.anchorA));
    const pb = transform(b.translation(), b.rotation(), vector(joint.anchorB));
    const axis = rotate(a.rotation(), vector(joint.axis));
    const travel = (pb.x - pa.x) * axis.x + (pb.y - pa.y) * axis.y + (pb.z - pa.z) * axis.z;
    return travel - (this.#restTravel.get(joint.id) ?? 0);
  }

  #jointAngle(joint: ProceduralJoint): number {
    const aId = this.#bodies.get(joint.a);
    const bId = this.#bodies.get(joint.b);
    if (aId === undefined || bId === undefined) return 0;
    if (!this.#world.hasBody(aId) || !this.#world.hasBody(bId)) return 0;
    const a = this.#world.body(aId);
    const b = this.#world.body(bId);
    const angle = twistAngle(a.rotation(), b.rotation(), a.rotation(), vector(joint.axis));
    return angle - (this.#restAngle.get(joint.id) ?? 0);
  }

  #stepLevers(): void {
    for (let i = 0; i < this.#levers.length; i++) {
      const entry = this.#levers[i];
      const joint = this.#jointDefs.get(entry.joint);
      const degrees = joint && joint.kind === "hinge" ? this.#jointAngle(joint) / DEG_TO_RAD : 0;
      this.#leverStates[i].on = this.#hysteresis(
        this.#leverStates[i].on,
        degrees,
        entry.onDeg ?? Number.POSITIVE_INFINITY,
        entry.offDeg ?? 0,
      );
    }
  }

  #stepLogic(tick: number): void {
    const rate = this.#world.tickRate;
    for (let i = 0; i < this.#logic.length; i++) {
      const entry = this.#logic[i];
      const state = this.#logicStates[i];
      const inputs = entry.inputs.map((id) => this.#signal(id));
      const any = inputs.some(Boolean);
      const all = inputs.length > 0 && inputs.every(Boolean);
      const rising = any && !state.prev;
      switch (entry.op) {
        case "and":
          state.on = all;
          break;
        case "or":
          state.on = any;
          break;
        case "not":
          state.on = !any;
          break;
        case "toggle":
          if (rising) state.toggle = !state.toggle;
          state.on = state.toggle;
          break;
        case "timer": {
          if (rising) {
            state.timerArmed = true;
            state.timerStart = tick;
          }
          const ticks = Math.max(1, Math.round((entry.seconds ?? 0) * rate));
          state.on = state.timerArmed && tick - state.timerStart < ticks;
          if (!state.on) state.timerArmed = false;
          break;
        }
        case "delay": {
          if (any !== state.prev) {
            state.delayTarget = any;
            state.delayStart = tick;
          }
          const ticks = Math.max(0, Math.round((entry.seconds ?? 0) * rate));
          if (tick - state.delayStart >= ticks) state.on = state.delayTarget;
          break;
        }
        case "counter": {
          if (rising) {
            state.counter += 1;
            const threshold = Math.max(1, entry.count ?? 1);
            if (state.counter >= threshold) {
              state.counter = 0;
              state.on = true;
            } else {
              state.on = false;
            }
          } else {
            state.on = false;
          }
          break;
        }
      }
      state.prev = any;
    }
  }

  #stepLinks(): void {
    for (let i = 0; i < this.#links.length; i++) {
      const link = this.#links[i];
      const on = this.#signal(link.from);
      const state = this.#linkStates[i];
      if (state.applied && state.on === on) continue;
      state.applied = true;
      state.on = on;
      this.#applyLink(link, on);
    }
  }

  #applyLink(link: ProceduralLink, on: boolean): void {
    const target = link.to;
    if (target.kind === "animation") {
      const index = this.#animations.findIndex((animation) => animation.id === target.animation);
      if (index < 0) return;
      const action = on ? target.on : target.off;
      this.#applyAnimationAction(index, ACTION_CODES[action]);
      return;
    }
    const joint = this.#jointDefs.get(target.joint);
    if (!joint) return;
    if (target.kind === "motor") {
      const unit = this.#unitJoint(joint.id);
      if (!unit) return;
      this.#applyMotor(unit, joint, on ? target.on : target.off);
      return;
    }
    if (target.kind === "door") {
      if (joint.kind !== "hinge") return;
      const unit = this.#unitJoint(joint.id);
      if (!unit) return;
      const motor = joint.motor;
      unit.configureMotorModel(this.#rapier.MotorModel.ForceBased);
      unit.configureMotorPosition(
        (on ? target.openDeg : target.closedDeg) * DEG_TO_RAD,
        motor?.stiffness ?? DOOR_STIFFNESS,
        motor?.damping ?? DOOR_DAMPING,
      );
      unit.setMotorMaxForce(motor?.maxForce ?? DOOR_MAX_FORCE);
      return;
    }
    if (target.kind === "spring") {
      this.#replaceSpring(joint, on ? target.stiffnessOn : target.stiffnessOff);
    }
  }

  #unitJoint(id: string): RAPIER.UnitImpulseJoint | null {
    const handle = this.#joints.get(id);
    if (handle === undefined) return null;
    const joint = this.#world.world.impulseJoints.get(handle);
    if (!joint) return null;
    return joint as RAPIER.UnitImpulseJoint;
  }

  #applyMotor(unit: RAPIER.UnitImpulseJoint, joint: ProceduralJoint, motor: ProceduralMotor): void {
    if (!motor.enabled) {
      unit.configureMotorModel(this.#rapier.MotorModel.ForceBased);
      unit.configureMotorVelocity(0, 0);
      unit.setMotorMaxForce(0);
      return;
    }
    const scale = joint.kind === "hinge" ? DEG_TO_RAD : 1;
    unit.configureMotorModel(this.#rapier.MotorModel.ForceBased);
    if (motor.mode === "speed") {
      const speed = joint.kind === "hinge" ? motor.speedDegS : motor.speedMS;
      unit.configureMotorVelocity((speed ?? 0) * scale, motor.damping ?? 0);
    } else {
      const target = joint.kind === "hinge" ? motor.targetDeg : motor.targetM;
      unit.configureMotorPosition((target ?? 0) * scale, motor.stiffness ?? 0, motor.damping ?? 0);
    }
    unit.setMotorMaxForce(motor.maxForce);
  }

  #replaceSpring(joint: ProceduralJoint, stiffness: number): void {
    const aId = this.#bodies.get(joint.a);
    const bId = this.#bodies.get(joint.b);
    if (aId === undefined || bId === undefined) return;
    if (!this.#world.hasBody(aId) || !this.#world.hasBody(bId)) return;
    const handle = this.#joints.get(joint.id);
    if (handle !== undefined) {
      const old = this.#world.world.impulseJoints.get(handle);
      if (old) this.#world.world.removeImpulseJoint(old, true);
    }
    const a = this.#world.body(aId);
    const b = this.#world.body(bId);
    const data = this.#rapier.JointData.spring(
      this.#restLength.get(joint.id) ?? joint.lengthM ?? 0,
      stiffness,
      joint.damping ?? 0,
      vector(joint.anchorA),
      vector(joint.anchorB),
    );
    const created = this.#world.world.createImpulseJoint(data, a, b, true);
    this.#joints.set(joint.id, created.handle);
  }

  #applyAnimationAction(index: number, code: number): void {
    const state = this.#animationStates[index];
    const animation = this.#animations[index];
    const first = animation.keys.length > 0 ? animation.keys[0].atS : 0;
    const last = animation.keys.length > 0 ? animation.keys[animation.keys.length - 1].atS : 0;
    if (code === PLAYING) {
      if (state.state === STOPPED && state.time >= last) state.time = first;
      state.state = PLAYING;
      state.startTick = this.#world.tick;
      return;
    }
    if (code === REVERSED) {
      if (state.state === STOPPED && state.time <= first) state.time = last;
      state.state = REVERSED;
      state.startTick = this.#world.tick;
      return;
    }
    if (code === PAUSED) {
      state.state = PAUSED;
      return;
    }
    state.state = STOPPED;
    state.time = first;
    state.startTick = this.#world.tick;
    this.#poseAnimation(animation, first);
  }

  #stepAnimations(tick: number): void {
    const rate = this.#world.tickRate;
    for (let i = 0; i < this.#animations.length; i++) {
      const animation = this.#animations[i];
      const state = this.#animationStates[i];
      if (state.state !== PLAYING && state.state !== REVERSED) continue;
      const keys = animation.keys;
      if (keys.length === 0) continue;
      const first = keys[0].atS;
      const last = keys[keys.length - 1].atS;
      const span = last - first;
      const direction = state.state === PLAYING ? 1 : -1;
      const elapsed = (tick - state.startTick) / rate;
      state.startTick = tick;
      let time = state.time + direction * elapsed;
      if (animation.loop === "loop") {
        time = span > 0 ? first + mod(time - first, span) : first;
      } else if (animation.loop === "pingpong") {
        if (span > 0) {
          const cycle = span * 2;
          const phase = mod(time - first, cycle);
          time = first + (phase > span ? cycle - phase : phase);
        } else {
          time = first;
        }
      } else if (time <= first) {
        time = first;
        if (direction < 0) state.state = STOPPED;
      } else if (time >= last) {
        time = last;
        if (direction > 0) state.state = STOPPED;
      }
      state.time = time;
      this.#poseAnimation(animation, state.time);
    }
  }

  #poseAnimation(animation: ProceduralAnimation, time: number): void {
    const id = this.#bodies.get(animation.target);
    if (id === undefined || !this.#world.hasBody(id)) return;
    const rest = this.#restPose.get(animation.target);
    if (!rest) return;
    const body = this.#world.body(id);
    if (!body.isKinematic()) return;
    const sample = sampleKeys(animation, time);
    if (!sample) return;
    const local = eulerDegToQuat(sample.rDeg);
    const restRotation = rotation(rest.r);
    const q = multiply(restRotation, local);
    body.setNextKinematicTranslation({
      x: rest.t[0] + sample.t[0],
      y: rest.t[1] + sample.t[1],
      z: rest.t[2] + sample.t[2],
    });
    body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** The current value of a switch, lever or logic signal (false when unknown). */
  signal(id: string): boolean {
    return this.#signal(id);
  }

  /** The play state of an animation, or null when the id is unknown. */
  animationStatus(id: string): ProceduralAnimationStatus | null {
    const index = this.#animations.findIndex((animation) => animation.id === id);
    if (index < 0) return null;
    const state = this.#animationStates[index];
    return {
      state: PLAY_NAMES[state.state] ?? "stopped",
      time: state.time,
      startTick: state.startTick,
    };
  }

  /** Serialise the mechanism state in the fixed little-endian layout. */
  takeSnapshot(): Uint8Array {
    const size =
      HEADER_BYTES +
      this.#switchStates.length * SWITCH_BYTES +
      this.#leverStates.length * LEVER_BYTES +
      this.#logicStates.length * LOGIC_BYTES +
      this.#linkStates.length * LINK_BYTES +
      this.#animationStates.length * ANIMATION_BYTES;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, VERSION, true);
    view.setUint32(8, this.#switchStates.length, true);
    view.setUint32(12, this.#leverStates.length, true);
    view.setUint32(16, this.#logicStates.length, true);
    view.setUint32(20, this.#linkStates.length, true);
    view.setUint32(24, this.#animationStates.length, true);
    let offset = HEADER_BYTES;
    for (const state of this.#switchStates) {
      view.setUint8(offset, state.on ? 1 : 0);
      offset += SWITCH_BYTES;
    }
    for (const state of this.#leverStates) {
      view.setUint8(offset, state.on ? 1 : 0);
      offset += LEVER_BYTES;
    }
    for (const state of this.#logicStates) {
      view.setUint8(offset, state.on ? 1 : 0);
      view.setUint8(offset + 1, state.prev ? 1 : 0);
      view.setUint8(offset + 2, state.toggle ? 1 : 0);
      view.setUint8(offset + 3, state.delayTarget ? 1 : 0);
      view.setUint8(offset + 4, state.timerArmed ? 1 : 0);
      view.setUint32(offset + 5, state.counter >>> 0, true);
      view.setUint32(offset + 9, state.timerStart >>> 0, true);
      view.setUint32(offset + 13, state.delayStart >>> 0, true);
      offset += LOGIC_BYTES;
    }
    for (const state of this.#linkStates) {
      view.setUint8(offset, state.applied ? 1 : 0);
      view.setUint8(offset + 1, state.on ? 1 : 0);
      offset += LINK_BYTES;
    }
    for (const state of this.#animationStates) {
      view.setUint8(offset, state.state);
      view.setUint32(offset + 1, state.startTick >>> 0, true);
      view.setFloat64(offset + 5, state.time, true);
      offset += ANIMATION_BYTES;
    }
    return out;
  }

  /** Restore a snapshot produced by takeSnapshot() on the same mechanism layout. */
  restoreSnapshot(bytes: Uint8Array): void {
    if (bytes.byteLength < HEADER_BYTES) {
      throw new Error("not a procedural mechanism snapshot (too short)");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) {
      throw new Error("not a procedural mechanism snapshot (bad magic/version)");
    }
    const switches = view.getUint32(8, true);
    const levers = view.getUint32(12, true);
    const logic = view.getUint32(16, true);
    const links = view.getUint32(20, true);
    const animations = view.getUint32(24, true);
    if (
      switches !== this.#switchStates.length ||
      levers !== this.#leverStates.length ||
      logic !== this.#logicStates.length ||
      links !== this.#linkStates.length ||
      animations !== this.#animationStates.length
    ) {
      throw new Error("procedural mechanism snapshot does not match this object");
    }
    const expected =
      HEADER_BYTES +
      switches * SWITCH_BYTES +
      levers * LEVER_BYTES +
      logic * LOGIC_BYTES +
      links * LINK_BYTES +
      animations * ANIMATION_BYTES;
    if (bytes.byteLength !== expected) {
      throw new Error("procedural mechanism snapshot has the wrong length");
    }
    let offset = HEADER_BYTES;
    for (const state of this.#switchStates) {
      state.on = view.getUint8(offset) === 1;
      offset += SWITCH_BYTES;
    }
    for (const state of this.#leverStates) {
      state.on = view.getUint8(offset) === 1;
      offset += LEVER_BYTES;
    }
    for (const state of this.#logicStates) {
      state.on = view.getUint8(offset) === 1;
      state.prev = view.getUint8(offset + 1) === 1;
      state.toggle = view.getUint8(offset + 2) === 1;
      state.delayTarget = view.getUint8(offset + 3) === 1;
      state.timerArmed = view.getUint8(offset + 4) === 1;
      state.counter = view.getUint32(offset + 5, true);
      state.timerStart = view.getUint32(offset + 9, true);
      state.delayStart = view.getUint32(offset + 13, true);
      offset += LOGIC_BYTES;
    }
    for (const state of this.#linkStates) {
      state.applied = view.getUint8(offset) === 1;
      state.on = view.getUint8(offset + 1) === 1;
      offset += LINK_BYTES;
    }
    for (const state of this.#animationStates) {
      state.state = view.getUint8(offset);
      state.startTick = view.getUint32(offset + 1, true);
      state.time = view.getFloat64(offset + 5, true);
      offset += ANIMATION_BYTES;
    }
  }
}
