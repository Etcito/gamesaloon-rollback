// Control points of the two spike tracks (plain data, y = 0 everywhere). The reference game's track
// builder turns them into a spine; tools/ref-run.ts exports the resulting frames to fixtures/*.json, and
// the Rapier side builds its road/wall meshes from those frames only (no dependency on the game).
//
//  circuit : flat stadium, clockwise, heading +Z at the start line, ~800 m, road 14 m wide:
//            260 m start straight (60 m of lead-in before the line), 45 m radius hairpin, 320 m back
//            straight with a 6 m S-bend, hairpin.
//  skid    : flat ring of radius 200 m with a 160 m wide road, for steady-state turning circles.

export type Pt = [number, number, number];
export interface ControlPointDef { p: Pt; width?: number }

const SPACING = 10;

function arc(cx: number, cz: number, r: number, a0: number, a1: number): Pt[] {
  const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / SPACING));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), 0, cz + r * Math.sin(a)]);
  }
  return out;
}

export function circuitPoints(): ControlPointDef[] {
  const pts: Pt[] = [];
  for (let z = 0; z < 260; z += SPACING) pts.push([0, 0, z]);
  pts.push(...arc(-45, 260, 45, 0, Math.PI));
  for (let z = 260; z > -60; z -= SPACING) {
    const u = (200 - z) / 100; // S-bend between z = 200 and z = 100
    const dx = u > 0 && u < 1 ? 6 * Math.sin(2 * Math.PI * u) : 0;
    pts.push([-90 + dx, 0, z]);
  }
  pts.push(...arc(-45, -60, 45, Math.PI, 2 * Math.PI));
  for (let z = -60; z < 0; z += SPACING) pts.push([0, 0, z]); // 60 m straight lead-in before the line
  return pts.map((p) => ({ p }));
}

export function skidPoints(): ControlPointDef[] {
  return arc(-200, 0, 200, 0, 2 * Math.PI).map((p) => ({ p, width: 160 }));
}
