// Loading fixtures and building drivers: shared by tools and tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initRapier } from "@gamesaloon/rollback-rapier";
import { KartRapierSim } from "./kartSim.ts";
import type { Tuning } from "./kartSim.ts";
import type { PhysParams } from "./driving.ts";
import type { Scenario, TrackId } from "./scenarios.ts";
import { gridSlots } from "./track.ts";
import type { TrackData } from "./track.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "fixtures");

export function loadTracks(): Record<TrackId, TrackData> {
  const rd = (f: string): TrackData => JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
  return { circuit: rd("track-circuit.json"), skid: rd("track-skid.json") };
}

export interface Reference { sim: string; tickHz: number; phys: PhysParams; metrics: Record<string, Record<string, number | boolean | number[] | null>>; traces: Record<string, { t: number[]; speed: number[]; x: number[]; z: number[]; yaw: number[] }> }

export function loadReference(): Reference {
  return JSON.parse(readFileSync(join(FIXTURES, "reference.json"), "utf8"));
}

export async function makeRapierFactory(tracks: Record<TrackId, TrackData>, phys: PhysParams, tickHz: number, tuning: Partial<Tuning> = {}): Promise<(sc: Scenario) => KartRapierSim> {
  const R = await initRapier();
  return (sc) => {
    const slots = gridSlots(tracks[sc.track], sc.karts);
    return new KartRapierSim(R, { track: tracks[sc.track], slots, dt: 1 / tickHz, phys, tuning });
  };
}
