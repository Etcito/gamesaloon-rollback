// Kart input <-> u32 input code. GENERIC: this is the piece a rollback game puts on the wire.
// Layout copied from the Monster Racer simulation core so both sims consume the very same codes:
// bit 0 drift, 1 item, 2 itemBack, 3 lookBack; bits 4-7 throttle (0..15); 8-11 brake (0..15);
// 12-19 steer (0..254, 127 = centre). Quantisation is part of the simulation: always run the sim on
// unpack(pack(x)), never on the raw analogue value, so the local player and the remote peers agree.

export interface KartInput {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
  item: boolean;
  itemBack: boolean;
  lookBack: boolean;
}

export function neutralInput(): KartInput {
  return { throttle: 0, brake: 0, steer: 0, drift: false, item: false, itemBack: false, lookBack: false };
}

function q01(v: number): number {
  const c = v > 0 ? (v < 1 ? v : 1) : 0;
  return Math.round(c * 15);
}

function qSteer(v: number): number {
  const c = v > -1 ? (v < 1 ? v : 1) : -1;
  return Math.round(c * 127) + 127;
}

export function packInput(i: KartInput): number {
  let code = 0;
  if (i.drift) code |= 1;
  if (i.item) code |= 2;
  if (i.itemBack) code |= 4;
  if (i.lookBack) code |= 8;
  code |= q01(i.throttle) << 4;
  code |= q01(i.brake) << 8;
  code |= qSteer(i.steer) << 12;
  return code >>> 0;
}

export function unpackInput(code: number, out: KartInput = neutralInput()): KartInput {
  out.drift = (code & 1) !== 0;
  out.item = (code & 2) !== 0;
  out.itemBack = (code & 4) !== 0;
  out.lookBack = (code & 8) !== 0;
  out.throttle = ((code >>> 4) & 15) / 15;
  out.brake = ((code >>> 8) & 15) / 15;
  let s = (code >>> 12) & 255;
  if (s > 254) s = 254;
  out.steer = (s - 127) / 127;
  return out;
}

/** Code of the neutral input (no buttons, steer centred). */
export const NEUTRAL_CODE = (127 << 12) >>> 0;

export function inputCode(partial: Partial<KartInput>): number {
  return packInput({ ...neutralInput(), ...partial });
}
