// Multi-kart test harness: seeded "chaotic bots" that follow the centre line with noise, drift presses
// and the odd brake, so 8-16 karts bump each other, hit walls and drift. Used by the determinism tests
// and the benchmark. The bots are OUTSIDE the simulation: tests record the input codes they produce and
// replay those codes, exactly like a rollback client replays its input history.
import { neutralInput, packInput } from "./inputCode.ts";
import type { KartRapierSim } from "./kartSim.ts";
import { botInput, newProbe } from "./scenarios.ts";
import type { Probe } from "./scenarios.ts";
import { project } from "./track.ts";
import type { Projection, TrackData } from "./track.ts";

/** Integer PRNG (mulberry32); its 32-bit state is all there is. */
export class Rng {
  state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export class ChaosBots {
  readonly probes: Probe[] = [];
  readonly hints: (number | null)[] = [];
  readonly noise: number[] = [];
  readonly rng: Rng;
  readonly proj: Projection = { s: 0, lat: 0 };
  readonly inp = neutralInput();
  readonly n: number;
  readonly track: TrackData;
  readonly topSpeed: number;
  constructor(n: number, track: TrackData, topSpeed: number, seed = 1) {
    this.n = n; this.track = track; this.topSpeed = topSpeed;
    this.rng = new Rng(seed);
    for (let i = 0; i < n; i++) { this.probes.push(newProbe()); this.hints.push(null); this.noise.push(0); }
  }

  /** Input codes for the next tick, computed from the sim's current state. */
  next(sim: KartRapierSim): number[] {
    const out: number[] = [];
    const tick = sim.tick;
    for (let i = 0; i < this.n; i++) {
      const p = this.probes[i];
      sim.probe(i, p);
      project(this.track, p.x, p.z, this.hints[i], this.proj, 30);
      this.hints[i] = this.proj.s; p.s = this.proj.s; p.lat = this.proj.lat;
      if (tick % 20 === 0) this.noise[i] = (this.rng.next() - 0.5) * 0.9;
      botInput(p, this.track, this.topSpeed, 0, this.inp);
      this.inp.steer = Math.max(-1, Math.min(1, this.inp.steer + this.noise[i]));
      const phase = (tick + i * 37) % 360;
      if (phase < 150) {
        // a held drift: steer into the bend with at least 0.5
        const sign = this.noise[i] >= 0 ? 1 : -1;
        this.inp.steer = sign * Math.max(Math.abs(this.inp.steer), 0.5);
        this.inp.drift = true;
      } else this.inp.drift = false;
      if ((tick + i * 11) % 500 > 470) this.inp.brake = 1;
      out.push(packInput(this.inp));
    }
    return out;
  }
}

/** Run a sim for `ticks` with fresh bots and return the input history. */
export function recordRun(sim: KartRapierSim, bots: ChaosBots, ticks: number, onTick?: (tick: number) => void): number[][] {
  const hist: number[][] = [];
  for (let k = 0; k < ticks; k++) {
    const codes = bots.next(sim);
    hist.push(codes);
    sim.step(codes);
    onTick?.(sim.tick);
  }
  return hist;
}
