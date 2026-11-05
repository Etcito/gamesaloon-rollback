/**
 * Procedural dynamics: the S12 bodies and joints plus the S13 mechanisms of a
 * procedural object, as the rollback sim receives them.
 *
 * This is a dependency-free copy of the authored game shape (no MAMA and no
 * game-runtime import). Validation follows procedural-colliders.ts: strict
 * types, exact JSON-pointer paths and plain lowercase messages.
 */

export type ProceduralBodyType = "dynamic" | "kinematic" | "fixed";
export type ProceduralJointKind = "fixed" | "hinge" | "slider" | "ball" | "spring" | "rope";
export type ProceduralSurface = "normal" | "ice" | "mud" | "rubber";
export type ProceduralMotorMode = "speed" | "target";
export type ProceduralSwitchMode = "weight" | "travel";
export type ProceduralLogicOp = "and" | "or" | "not" | "toggle" | "timer" | "delay" | "counter";
export type ProceduralEasing = "linear" | "smooth";
export type ProceduralLoop = "loop" | "pingpong" | "once";

export interface ProceduralMotor {
  mode: ProceduralMotorMode;
  speedDegS?: number;
  speedMS?: number;
  targetDeg?: number;
  targetM?: number;
  stiffness: number;
  damping: number;
  maxForce: number;
  enabled: boolean;
}

export interface ProceduralBody {
  id: string;
  type: ProceduralBodyType;
  colliders: number[];
  parts: string[];
  t: [number, number, number];
  r: [number, number, number, number];
  density: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  surface: ProceduralSurface;
}

export interface ProceduralJoint {
  id: string;
  kind: ProceduralJointKind;
  a: string;
  b: string;
  anchorA: [number, number, number];
  anchorB: [number, number, number];
  axis: [number, number, number];
  limitsDeg?: [number, number] | null;
  limitsM?: [number, number] | null;
  stiffness?: number;
  damping?: number;
  lengthM?: number;
  motor?: ProceduralMotor | null;
}

export interface ProceduralSwitch {
  id: string;
  plate: string;
  mode: ProceduralSwitchMode;
  onKg?: number;
  offKg?: number;
  joint?: string;
  onM?: number;
  offM?: number;
}

export interface ProceduralLever {
  id: string;
  handle: string;
  joint: string;
  onDeg: number;
  offDeg: number;
  grabRangeM: number;
}

export interface ProceduralLogic {
  id: string;
  op: ProceduralLogicOp;
  inputs: string[];
  seconds?: number;
  count?: number;
}

export interface ProceduralAnimationKey {
  atS: number;
  t: [number, number, number];
  rDeg: [number, number, number];
}

export interface ProceduralAnimation {
  id: string;
  target: string;
  keys: ProceduralAnimationKey[];
  easing: ProceduralEasing;
  loop: ProceduralLoop;
  autostart: boolean;
}

export type ProceduralLinkTarget =
  | { kind: "motor"; joint: string; on: ProceduralMotor; off: ProceduralMotor }
  | { kind: "door"; joint: string; openDeg: number; closedDeg: number }
  | { kind: "spring"; joint: string; stiffnessOn: number; stiffnessOff: number }
  | { kind: "animation"; animation: string; on: "play" | "reverse"; off: "pause" | "reverse" | "stop" };

export interface ProceduralLink {
  id: string;
  from: string;
  to: ProceduralLinkTarget;
}

export interface ProceduralBudget {
  dynamicBodies: number;
  joints: number;
}

export interface ProceduralMechanisms {
  animations?: ProceduralAnimation[];
  switches?: ProceduralSwitch[];
  levers?: ProceduralLever[];
  logic?: ProceduralLogic[];
  links?: ProceduralLink[];
  budget?: ProceduralBudget;
}

export interface ProceduralDynamics {
  bodies: ProceduralBody[];
  joints: ProceduralJoint[];
  mechanisms?: ProceduralMechanisms;
}

export interface ProceduralDynamicsError {
  path: string;
  message: string;
}

export type ProceduralDynamicsValidation =
  | { ok: true; dynamics: ProceduralDynamics }
  | { ok: false; error: ProceduralDynamicsError };

type ErrorResult = { ok: false; error: ProceduralDynamicsError };
type Ok<T> = { ok: true; value: T };

const BODY_TYPES: readonly ProceduralBodyType[] = ["dynamic", "kinematic", "fixed"];
const JOINT_KINDS: readonly ProceduralJointKind[] = ["fixed", "hinge", "slider", "ball", "spring", "rope"];
const SURFACES: readonly ProceduralSurface[] = ["normal", "ice", "mud", "rubber"];
const MOTOR_MODES: readonly ProceduralMotorMode[] = ["speed", "target"];
const SWITCH_MODES: readonly ProceduralSwitchMode[] = ["weight", "travel"];
const LOGIC_OPS: readonly ProceduralLogicOp[] = [
  "and",
  "or",
  "not",
  "toggle",
  "timer",
  "delay",
  "counter",
];
const LINK_KINDS = ["motor", "door", "spring", "animation"] as const;
const EASINGS: readonly ProceduralEasing[] = ["linear", "smooth"];
const LOOPS: readonly ProceduralLoop[] = ["loop", "pingpong", "once"];

const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const UNIT_TOLERANCE = 1e-6;

function fail(path: string, message: string): ErrorResult {
  return { ok: false, error: { path, message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

function readVec3(v: unknown, path: string): Ok<[number, number, number]> | ErrorResult {
  if (!Array.isArray(v) || v.length !== 3) return fail(path, "must be three numbers");
  for (let i = 0; i < 3; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  return { ok: true, value: [v[0], v[1], v[2]] };
}

function readQuat(
  v: unknown,
  path: string,
): Ok<[number, number, number, number]> | ErrorResult {
  if (!Array.isArray(v) || v.length !== 4) return fail(path, "must be four numbers");
  for (let i = 0; i < 4; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  const q = [v[0], v[1], v[2], v[3]] as [number, number, number, number];
  if (Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) > UNIT_TOLERANCE) {
    return fail(path, "must be a rotation of length one");
  }
  return { ok: true, value: q };
}

function checkId(v: unknown, path: string, ids: Set<string>): ErrorResult | null {
  if (typeof v !== "string" || !ID_PATTERN.test(v)) {
    return fail(path, "must be one to thirty-two lowercase letters, digits or dashes");
  }
  if (ids.has(v)) return fail(path, "must be unique in this list");
  ids.add(v);
  return null;
}

function checkStringList(v: unknown, path: string): ErrorResult | null {
  if (!Array.isArray(v)) return fail(path, "must be a list of text entries");
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") return fail(`${path}/${i}`, "must be text");
  }
  return null;
}

function checkFinite(v: unknown, path: string): ErrorResult | null {
  if (!isFiniteNumber(v)) return fail(path, "must be a finite number");
  return null;
}

function checkNonNegative(v: unknown, path: string): ErrorResult | null {
  if (!isFiniteNumber(v)) return fail(path, "must be a finite number");
  if (v < 0) return fail(path, "must be zero or greater");
  return null;
}

function checkCount(v: unknown, path: string): ErrorResult | null {
  if (!Number.isInteger(v) || (v as number) < 0) {
    return fail(path, "must be a non-negative integer");
  }
  return null;
}

function checkUnitVector(v: unknown, path: string): ErrorResult | null {
  const vec = readVec3(v, path);
  if (!vec.ok) return vec;
  const [x, y, z] = vec.value;
  if (Math.abs(Math.hypot(x, y, z) - 1) > UNIT_TOLERANCE) {
    return fail(path, "must be a unit vector");
  }
  return null;
}

function checkLimits(v: unknown, path: string): ErrorResult | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 2) return fail(path, "must be two numbers");
  for (let i = 0; i < 2; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}/${i}`, "must be a finite number");
  }
  if (v[0] > v[1]) return fail(path, "must be an ordered pair");
  return null;
}

function checkMotor(v: unknown, path: string): ErrorResult | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) return fail(path, "must be an object");
  if (!isOneOf(v.mode, MOTOR_MODES)) return fail(`${path}/mode`, "must be speed or target");
  for (const key of ["speedDegS", "speedMS", "targetDeg", "targetM", "stiffness", "damping"] as const) {
    if (v[key] === undefined) continue;
    const bad = checkFinite(v[key], `${path}/${key}`);
    if (bad) return bad;
  }
  const maxForce = checkNonNegative(v.maxForce, `${path}/maxForce`);
  if (maxForce) return maxForce;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") {
    return fail(`${path}/enabled`, "must be true or false");
  }
  return null;
}

function checkBody(
  v: unknown,
  base: string,
  colliderCount: number,
  bodyIds: Set<string>,
  owners: Map<number, string>,
): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const id = checkId(v.id, `${base}/id`, bodyIds);
  if (id) return id;
  if (!isOneOf(v.type, BODY_TYPES)) {
    return fail(`${base}/type`, "must be dynamic, kinematic or fixed");
  }
  if (!Array.isArray(v.colliders)) {
    return fail(`${base}/colliders`, "must be a list of collider indices");
  }
  for (let i = 0; i < v.colliders.length; i++) {
    const index = v.colliders[i];
    const path = `${base}/colliders/${i}`;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= colliderCount) {
      return fail(path, "must be an integer from zero to the collider count");
    }
    if (owners.has(index as number)) return fail(path, "must belong to exactly one body");
    owners.set(index as number, String(v.id));
  }
  const parts = checkStringList(v.parts, `${base}/parts`);
  if (parts) return parts;
  const t = readVec3(v.t, `${base}/t`);
  if (!t.ok) return t;
  const r = readQuat(v.r, `${base}/r`);
  if (!r.ok) return r;
  const density = checkFinite(v.density, `${base}/density`);
  if (density) return density;
  if ((v.density as number) <= 0) return fail(`${base}/density`, "must be greater than zero");
  for (const key of ["friction", "restitution", "linearDamping", "angularDamping", "gravityScale"]) {
    const bad = checkFinite(v[key], `${base}/${key}`);
    if (bad) return bad;
  }
  if (typeof v.ccd !== "boolean") return fail(`${base}/ccd`, "must be true or false");
  if (!isOneOf(v.surface, SURFACES)) {
    return fail(`${base}/surface`, "must be normal, ice, mud or rubber");
  }
  return null;
}

function checkJoint(v: unknown, base: string, bodyIds: Set<string>, jointIds: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const id = checkId(v.id, `${base}/id`, jointIds);
  if (id) return id;
  if (!isOneOf(v.kind, JOINT_KINDS)) {
    return fail(`${base}/kind`, "must be fixed, hinge, slider, ball, spring or rope");
  }
  for (const end of ["a", "b"] as const) {
    if (typeof v[end] !== "string" || !bodyIds.has(v[end])) {
      return fail(`${base}/${end}`, "must be an existing body id");
    }
  }
  if (v.a === v.b) return fail(`${base}/b`, "must name two different bodies");
  const anchorA = readVec3(v.anchorA, `${base}/anchorA`);
  if (!anchorA.ok) return anchorA;
  const anchorB = readVec3(v.anchorB, `${base}/anchorB`);
  if (!anchorB.ok) return anchorB;
  const axis = checkUnitVector(v.axis, `${base}/axis`);
  if (axis) return axis;
  const limitsDeg = checkLimits(v.limitsDeg, `${base}/limitsDeg`);
  if (limitsDeg) return limitsDeg;
  const limitsM = checkLimits(v.limitsM, `${base}/limitsM`);
  if (limitsM) return limitsM;
  for (const key of ["stiffness", "damping", "lengthM"] as const) {
    if (v[key] === undefined) continue;
    const bad = checkFinite(v[key], `${base}/${key}`);
    if (bad) return bad;
  }
  return checkMotor(v.motor, `${base}/motor`);
}

function readList(m: Record<string, unknown>, key: string, path: string): Ok<unknown[]> | ErrorResult {
  const v = m[key];
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return fail(`${path}/${key}`, "must be a list");
  return { ok: true, value: v };
}

function entryId(v: unknown, path: string, ids: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(path, "must be an object");
  return checkId(v.id, `${path}/id`, ids);
}

function checkBodyRef(v: unknown, path: string, bodyIds: Set<string>): ErrorResult | null {
  if (typeof v !== "string" || !bodyIds.has(v)) return fail(path, "must be an existing body id");
  return null;
}

function checkJointRef(v: unknown, path: string, jointIds: Set<string>): ErrorResult | null {
  if (typeof v !== "string" || !jointIds.has(v)) return fail(path, "must be an existing joint id");
  return null;
}

function checkSignalRef(v: unknown, path: string, signals: Set<string>): ErrorResult | null {
  if (typeof v !== "string" || !signals.has(v)) return fail(path, "must be an existing signal id");
  return null;
}

function checkAnimation(v: unknown, base: string, bodyIds: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const target = checkBodyRef(v.target, `${base}/target`, bodyIds);
  if (target) return target;
  if (!Array.isArray(v.keys)) return fail(`${base}/keys`, "must be a list of keys");
  let last = -Infinity;
  for (let i = 0; i < v.keys.length; i++) {
    const key = v.keys[i];
    const path = `${base}/keys/${i}`;
    if (!isRecord(key)) return fail(path, "must be an object");
    const atS = checkNonNegative(key.atS, `${path}/atS`);
    if (atS) return atS;
    if ((key.atS as number) <= last) {
      return fail(`${path}/atS`, "must be ordered by time");
    }
    last = key.atS as number;
    const t = readVec3(key.t, `${path}/t`);
    if (!t.ok) return t;
    const rDeg = readVec3(key.rDeg, `${path}/rDeg`);
    if (!rDeg.ok) return rDeg;
  }
  if (!isOneOf(v.easing, EASINGS)) return fail(`${base}/easing`, "must be linear or smooth");
  if (!isOneOf(v.loop, LOOPS)) return fail(`${base}/loop`, "must be loop, pingpong or once");
  if (typeof v.autostart !== "boolean") return fail(`${base}/autostart`, "must be true or false");
  return null;
}

function checkSwitch(v: unknown, base: string, bodyIds: Set<string>, jointIds: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const plate = checkBodyRef(v.plate, `${base}/plate`, bodyIds);
  if (plate) return plate;
  if (!isOneOf(v.mode, SWITCH_MODES)) return fail(`${base}/mode`, "must be weight or travel");
  for (const key of ["onKg", "offKg", "onM", "offM"] as const) {
    if (v[key] === undefined) continue;
    const bad = checkFinite(v[key], `${base}/${key}`);
    if (bad) return bad;
  }
  if (v.joint !== undefined && v.joint !== null) {
    return checkJointRef(v.joint, `${base}/joint`, jointIds);
  }
  return null;
}

function checkLever(v: unknown, base: string, bodyIds: Set<string>, jointIds: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const handle = checkBodyRef(v.handle, `${base}/handle`, bodyIds);
  if (handle) return handle;
  const joint = checkJointRef(v.joint, `${base}/joint`, jointIds);
  if (joint) return joint;
  for (const key of ["onDeg", "offDeg", "grabRangeM"] as const) {
    if (v[key] === undefined) continue;
    const bad = checkFinite(v[key], `${base}/${key}`);
    if (bad) return bad;
  }
  return null;
}

function checkLogic(v: unknown, base: string, signals: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  if (!isOneOf(v.op, LOGIC_OPS)) return fail(`${base}/op`, "must be a known logic operation");
  if (!Array.isArray(v.inputs)) return fail(`${base}/inputs`, "must be a list of signal ids");
  for (let i = 0; i < v.inputs.length; i++) {
    const input = checkSignalRef(v.inputs[i], `${base}/inputs/${i}`, signals);
    if (input) return input;
  }
  if (v.seconds !== undefined) {
    const seconds = checkNonNegative(v.seconds, `${base}/seconds`);
    if (seconds) return seconds;
  }
  if (v.count !== undefined) {
    const count = checkCount(v.count, `${base}/count`);
    if (count) return count;
  }
  return null;
}

function checkLink(
  v: unknown,
  base: string,
  signals: Set<string>,
  jointIds: Set<string>,
  animationIds: Set<string>,
): ErrorResult | null {
  if (!isRecord(v)) return fail(base, "must be an object");
  const from = checkSignalRef(v.from, `${base}/from`, signals);
  if (from) return from;
  const to = v.to;
  const path = `${base}/to`;
  if (!isRecord(to)) return fail(path, "must be an object");
  if (!isOneOf(to.kind, LINK_KINDS)) {
    return fail(`${path}/kind`, "must be motor, door, spring or animation");
  }
  if (to.kind === "animation") {
    if (typeof to.animation !== "string" || !animationIds.has(to.animation)) {
      return fail(`${path}/animation`, "must be an existing animation id");
    }
    if (to.on !== "play" && to.on !== "reverse") {
      return fail(`${path}/on`, "must be play or reverse");
    }
    if (to.off !== "pause" && to.off !== "reverse" && to.off !== "stop") {
      return fail(`${path}/off`, "must be pause, reverse or stop");
    }
    return null;
  }
  const joint = checkJointRef(to.joint, `${path}/joint`, jointIds);
  if (joint) return joint;
  if (to.kind === "motor") {
    for (const side of ["on", "off"] as const) {
      const motor = checkMotor(to[side], `${path}/${side}`);
      if (motor) return motor;
    }
    return null;
  }
  if (to.kind === "door") {
    for (const key of ["openDeg", "closedDeg"] as const) {
      if (to[key] === undefined) continue;
      const bad = checkFinite(to[key], `${path}/${key}`);
      if (bad) return bad;
    }
    return null;
  }
  for (const key of ["stiffnessOn", "stiffnessOff"] as const) {
    if (to[key] === undefined) continue;
    const bad = checkNonNegative(to[key], `${path}/${key}`);
    if (bad) return bad;
  }
  return null;
}

function checkMechanisms(v: unknown, bodyIds: Set<string>, jointIds: Set<string>): ErrorResult | null {
  if (!isRecord(v)) return fail("/mechanisms", "must be an object");
  const animations = readList(v, "animations", "/mechanisms");
  if (!animations.ok) return animations;
  const switches = readList(v, "switches", "/mechanisms");
  if (!switches.ok) return switches;
  const levers = readList(v, "levers", "/mechanisms");
  if (!levers.ok) return levers;
  const logic = readList(v, "logic", "/mechanisms");
  if (!logic.ok) return logic;
  const links = readList(v, "links", "/mechanisms");
  if (!links.ok) return links;

  const animationIds = new Set<string>();
  const switchIds = new Set<string>();
  const leverIds = new Set<string>();
  const logicIds = new Set<string>();
  const linkIds = new Set<string>();
  const lists: [unknown[], string, Set<string>][] = [
    [animations.value, "/mechanisms/animations", animationIds],
    [switches.value, "/mechanisms/switches", switchIds],
    [levers.value, "/mechanisms/levers", leverIds],
    [logic.value, "/mechanisms/logic", logicIds],
    [links.value, "/mechanisms/links", linkIds],
  ];
  for (const [list, base, ids] of lists) {
    for (let i = 0; i < list.length; i++) {
      const bad = entryId(list[i], `${base}/${i}`, ids);
      if (bad) return bad;
    }
  }

  for (let i = 0; i < animations.value.length; i++) {
    const bad = checkAnimation(animations.value[i], `/mechanisms/animations/${i}`, bodyIds);
    if (bad) return bad;
  }
  for (let i = 0; i < switches.value.length; i++) {
    const bad = checkSwitch(switches.value[i], `/mechanisms/switches/${i}`, bodyIds, jointIds);
    if (bad) return bad;
  }
  for (let i = 0; i < levers.value.length; i++) {
    const bad = checkLever(levers.value[i], `/mechanisms/levers/${i}`, bodyIds, jointIds);
    if (bad) return bad;
  }
  const signals = new Set<string>([...switchIds, ...leverIds, ...logicIds]);
  for (let i = 0; i < logic.value.length; i++) {
    const bad = checkLogic(logic.value[i], `/mechanisms/logic/${i}`, signals);
    if (bad) return bad;
  }
  for (let i = 0; i < links.value.length; i++) {
    const bad = checkLink(
      links.value[i],
      `/mechanisms/links/${i}`,
      signals,
      jointIds,
      animationIds,
    );
    if (bad) return bad;
  }

  const budget = v.budget;
  if (budget !== undefined && budget !== null) {
    if (!isRecord(budget)) return fail("/mechanisms/budget", "must be an object");
    const dynamicBodies = checkCount(budget.dynamicBodies, "/mechanisms/budget/dynamicBodies");
    if (dynamicBodies) return dynamicBodies;
    return checkCount(budget.joints, "/mechanisms/budget/joints");
  }
  return null;
}

export function validateProceduralDynamics(
  v: unknown,
  colliderCount: number,
): ProceduralDynamicsValidation {
  try {
    if (!Number.isInteger(colliderCount) || colliderCount < 0) {
      return fail("", "collider count must be a non-negative integer");
    }
    if (!isRecord(v)) return fail("", "must be an object with bodies and joints");
    const physics = isRecord(v.physics) ? v.physics : v;
    if (!Array.isArray(physics.bodies)) return fail("/physics/bodies", "must be a list of bodies");
    if (!Array.isArray(physics.joints)) return fail("/physics/joints", "must be a list of joints");
    const bodyIds = new Set<string>();
    const owners = new Map<number, string>();
    for (let i = 0; i < physics.bodies.length; i++) {
      const bad = checkBody(physics.bodies[i], `/physics/bodies/${i}`, colliderCount, bodyIds, owners);
      if (bad) return bad;
    }
    if (owners.size !== colliderCount) {
      return fail("/physics/bodies", "every collider must belong to exactly one body");
    }
    const jointIds = new Set<string>();
    for (let i = 0; i < physics.joints.length; i++) {
      const bad = checkJoint(physics.joints[i], `/physics/joints/${i}`, bodyIds, jointIds);
      if (bad) return bad;
    }
    const mechanisms = v.mechanisms ?? physics.mechanisms;
    if (mechanisms !== undefined && mechanisms !== null) {
      const bad = checkMechanisms(mechanisms, bodyIds, jointIds);
      if (bad) return bad;
    }
    if (physics === v) return { ok: true, dynamics: v as unknown as ProceduralDynamics };
    return {
      ok: true,
      dynamics: {
        bodies: physics.bodies as unknown as ProceduralBody[],
        joints: physics.joints as unknown as ProceduralJoint[],
        mechanisms: mechanisms as ProceduralMechanisms | undefined,
      },
    };
  } catch {
    return fail("", "must be an object with bodies and joints");
  }
}
