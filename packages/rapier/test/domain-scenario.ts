import { SnapReader, SnapWriter } from "@gamesaloon/rollback";
import type { DomainSpec, ShadowView } from "@gamesaloon/rollback/zones";
import { RapierDomainFactory } from "../src/domain-sim.ts";
import type { RapierDomainHooks, RapierDomainSim } from "../src/domain-sim.ts";
import { initRapier } from "../src/init.ts";

export const R = await initRapier();
export const EMPTY = new Uint8Array(0);
export const LEFT: DomainSpec = { id: 1, kind: "seat", cells: [0], seats: [0], replicas: [0, 1] };
export const RIGHT: DomainSpec = { id: 2, kind: "seat", cells: [1], seats: [1], replicas: [0, 1] };
export const MERGED: DomainSpec = { id: 1, kind: "seat", cells: [0, 1], seats: [0, 1], replicas: [0, 1] };

export const hooks: RapierDomainHooks<number> = {
  buildStatic(world) {
    world.sim.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [R.ColliderDesc.cuboid(20, 0.5, 20)]);
    world.sim.createBody(R.RigidBodyDesc.kinematicPositionBased());
  },
  spawnSeat(world, seat) {
    world.adopt(seat + 1, 0, new Uint8Array([seat]), seat);
  },
  buildEntity(_kind, params) {
    return {
      body: R.RigidBodyDesc.dynamic().setTranslation(params[0] === 0 ? -2 : 2, 2, 0),
      colliders: [R.ColliderDesc.ball(0.5)],
    };
  },
  buildJoint(world, _kind, _params, a, b) {
    return world.createImpulseJoint(R.JointData.rope(4, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), a, b, true);
  },
  applyInput(_world, _seat, body, input) {
    if (input !== 0) body.applyImpulse({ x: input, y: 0, z: 0 }, true);
  },
  events(world, w) {
    w.u16(1);
    w.i32(world.tick);
  },
  cellOf(x) { return x < 0 ? 0 : 1; },
  kinematicParts() {
    return [{
      body: 2,
      pose(tick, out) {
        out.translation.x = tick;
        out.translation.y = 10;
        out.translation.z = 0;
        out.rotation.x = 0;
        out.rotation.y = 0;
        out.rotation.z = 0;
        out.rotation.w = 1;
      },
    }];
  },
};

export const factory = new RapierDomainFactory(R, hooks);

export function shadow(from = RIGHT.id, bytes: Uint8Array = EMPTY): ShadowView {
  return { count: 1, fromDomain: () => from, reader: () => new SnapReader(bytes) };
}

export function snapshot(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.snapshot(w);
  return w.bytes().slice();
}

export function exported(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.exportEntities(w);
  return w.bytes().slice();
}

export function shadowBytes(sim: RapierDomainSim<number>): Uint8Array {
  const w = new SnapWriter();
  sim.shadowOut(w, LEFT.id);
  return w.bytes().slice();
}
