// Track data (plain arrays, JSON-serialisable) and the queries a rollback game needs: frame at s,
// projection of a point on the centre line, curvature, and the road/wall triangle meshes that the
// Rapier world is built from. GAME-SPECIFIC in its source (how the centre line is authored) but the
// shape of the data is what a generic "TrackColliderBuilder" would take.
import { datan2 } from "./detmath.ts";
import { clamp, wrap } from "./mathx.ts";

export interface GridSlot { pos: [number, number, number]; tan: [number, number, number]; up: [number, number, number]; right: [number, number, number]; width: number; s: number }

export interface TrackData {
  id: string;
  length: number;
  /** Number of samples; sample i is at s = i * step, the loop closes from the last back to 0. */
  count: number;
  step: number;
  startS: number;
  /** x,y,z per sample. */
  pos: number[];
  tan: number[];
  up: number[];
  right: number[];
  width: number[];
  grid: GridSlot[];
}

export interface Frame { x: number; y: number; z: number; tx: number; ty: number; tz: number; ux: number; uy: number; uz: number; rx: number; ry: number; rz: number; width: number; s: number }

export function newFrame(): Frame {
  return { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, ux: 0, uy: 1, uz: 0, rx: -1, ry: 0, rz: 0, width: 14, s: 0 };
}

/** Frame at arc length s (wrapped), linear interpolation between samples, tangent and right re-normalised. */
export function frameAt(t: TrackData, s: number, out: Frame): Frame {
  const w = wrap(s, t.length);
  const f = w / t.step;
  let i0 = Math.floor(f);
  if (i0 >= t.count) i0 = t.count - 1;
  const a = f - i0;
  const i1 = i0 + 1 >= t.count ? 0 : i0 + 1;
  const b = 1 - a;
  const o0 = i0 * 3, o1 = i1 * 3;
  out.x = t.pos[o0] * b + t.pos[o1] * a;
  out.y = t.pos[o0 + 1] * b + t.pos[o1 + 1] * a;
  out.z = t.pos[o0 + 2] * b + t.pos[o1 + 2] * a;
  let tx = t.tan[o0] * b + t.tan[o1] * a, ty = t.tan[o0 + 1] * b + t.tan[o1 + 1] * a, tz = t.tan[o0 + 2] * b + t.tan[o1 + 2] * a;
  let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  tl = tl > 1e-12 ? 1 / tl : 1;
  out.tx = tx * tl; out.ty = ty * tl; out.tz = tz * tl;
  let rx = t.right[o0] * b + t.right[o1] * a, ry = t.right[o0 + 1] * b + t.right[o1 + 1] * a, rz = t.right[o0 + 2] * b + t.right[o1 + 2] * a;
  let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rl = rl > 1e-12 ? 1 / rl : 1;
  out.rx = rx * rl; out.ry = ry * rl; out.rz = rz * rl;
  out.ux = t.up[o0] * b + t.up[o1] * a; out.uy = t.up[o0 + 1] * b + t.up[o1 + 1] * a; out.uz = t.up[o0 + 2] * b + t.up[o1 + 2] * a;
  out.width = t.width[i0] * b + t.width[i1] * a;
  out.s = w;
  return out;
}

export interface Projection { s: number; lat: number }

/**
 * Nearest point on the centre line. With a hint only samples within +-window of it are searched
 * (karts move < 1 sample per tick); without one the whole loop is scanned. Pure function of its inputs.
 */
export function project(t: TrackData, x: number, z: number, hintS: number | null, out: Projection, window = 24): Projection {
  let best = Infinity, bi = 0;
  const n = t.count;
  let lo = 0, hi = n - 1;
  if (hintS !== null) {
    const c = Math.round(wrap(hintS, t.length) / t.step);
    lo = c - window; hi = c + window;
  }
  for (let k = lo; k <= hi; k++) {
    const i = ((k % n) + n) % n;
    const dx = x - t.pos[i * 3], dz = z - t.pos[i * 3 + 2];
    const d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; }
  }
  // refine on the segment bi -> bi+1 or bi-1 -> bi, whichever the point is in front of
  const px = x - t.pos[bi * 3], pz = z - t.pos[bi * 3 + 2];
  const tx = t.tan[bi * 3], tz = t.tan[bi * 3 + 2];
  const along = clamp(px * tx + pz * tz, -t.step, t.step);
  out.s = wrap(bi * t.step + along, t.length);
  // lateral offset to the right of the centre line (right of a +Z heading is -X)
  out.lat = px * t.right[bi * 3] + pz * t.right[bi * 3 + 2];
  return out;
}

/** |curvature| (rad/m) over +-2 m, as the reference bot measures it. */
export function curvature(t: TrackData, s: number): number {
  const a = frameAt(t, s - 2, _fa), b = frameAt(t, s + 2, _fb);
  const cross = a.tx * b.tz - a.tz * b.tx;
  const dot = a.tx * b.tx + a.tz * b.tz;
  return Math.abs(datan2(cross, dot)) / 4;
}
const _fa = newFrame();
const _fb = newFrame();

export interface TrackMesh { vertices: Float32Array; indices: Uint32Array }

export interface MeshOptions {
  /** Road surface extends this far past the road edge (curb + under the wall). */
  edgeExtra: number;
  /** Lateral offset of the INNER wall face from the road edge. Ball centre limit = this - ballRadius. */
  wallInset: number;
  wallThickness: number;
  wallBottom: number;
  wallTop: number;
  /** Every Nth sample becomes a mesh row (2 m with 1 m sampling). */
  rowStride: number;
  /** Road columns across the width as fractions of half the (width + edgeExtra), e.g. [-1,-0.5,0,0.5,1] or [-1,1]. */
  roadColumns: number[];
  /** 'closed' = inner face + top + outer face (thick wall), 'inner' = one quad strip (thin wall, 2 triangles per segment). */
  wallFaces: "closed" | "inner";
}

export const DEFAULT_MESH: MeshOptions = { edgeExtra: 1.6, wallInset: 1.0, wallThickness: 0.5, wallBottom: -0.6, wallTop: 2.0, rowStride: 2, roadColumns: [-1, -0.5, 0, 0.5, 1], wallFaces: "closed" };


/** Road ribbon: 5 columns across the width (plus edgeExtra), closed loop. */
export function buildRoadMesh(t: TrackData, o: MeshOptions = DEFAULT_MESH): TrackMesh {
  const rows = Math.floor(t.count / o.rowStride);
  const COLS = o.roadColumns;
  const cols = COLS.length;
  const v = new Float32Array(rows * cols * 3);
  const f = newFrame();
  for (let r = 0; r < rows; r++) {
    frameAt(t, r * o.rowStride * t.step, f);
    for (let c = 0; c < cols; c++) {
      const lat = COLS[c] * (0.5 * f.width + o.edgeExtra);
      const k = (r * cols + c) * 3;
      v[k] = f.x + f.rx * lat; v[k + 1] = f.y + f.ry * lat; v[k + 2] = f.z + f.rz * lat;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows; r++) {
    const r1 = (r + 1) % rows;
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = r * cols + c + 1, d = r1 * cols + c, e = r1 * cols + c + 1;
      // normal must point UP (+Y): with the road running along +tangent and +lat to the right that is (a, b, d), (b, e, d).
      // Rapier's FIX_INTERNAL_EDGES uses the triangle orientation: a downward-facing road gets no contacts from above.
      idx.push(a, b, d, b, e, d);
    }
  }
  return { vertices: v, indices: Uint32Array.from(idx) };
}

/** Both walls as thin extruded strips (inner face, top, outer face). */
export function buildWallMesh(t: TrackData, o: MeshOptions = DEFAULT_MESH): TrackMesh {
  const rows = Math.floor(t.count / o.rowStride);
  const f = newFrame();
  const v: number[] = [];
  const idx: number[] = [];
  for (let side = -1; side <= 1; side += 2) {
    const base = v.length / 3;
    for (let r = 0; r < rows; r++) {
      frameAt(t, r * o.rowStride * t.step, f);
      const e = 0.5 * f.width + o.wallInset;
      const lats = [e, e, e + o.wallThickness, e + o.wallThickness];
      const hs = [o.wallBottom, o.wallTop, o.wallTop, o.wallBottom];
      for (let k = 0; k < 4; k++) {
        const lat = side * lats[k];
        v.push(f.x + f.rx * lat + f.ux * hs[k], f.y + f.ry * lat + f.uy * hs[k], f.z + f.rz * lat + f.uz * hs[k]);
      }
    }
    for (let r = 0; r < rows; r++) {
      const r1 = (r + 1) % rows;
      for (let k = 0; k < (o.wallFaces === "inner" ? 1 : 4); k++) {
        const k1 = (k + 1) % 4;
        const a = base + r * 4 + k, b = base + r * 4 + k1, c = base + r1 * 4 + k, d = base + r1 * 4 + k1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  return { vertices: Float32Array.from(v), indices: Uint32Array.from(idx) };
}

/**
 * Start poses for n karts: the track's own grid for n <= grid.length, else the same pattern continued
 * (two lanes 4.2 m apart, rows 6 m apart, 3 m stagger) behind the line.
 */
export function gridSlots(t: TrackData, n: number): GridSlot[] {
  const out: GridSlot[] = [];
  const f = newFrame();
  for (let k = 0; k < n; k++) {
    if (k < t.grid.length) { out.push(t.grid[k]); continue; }
    const s = wrap(t.length - 8 - 3 * k, t.length);
    frameAt(t, s, f);
    const lat = k % 2 === 0 ? -2.1 : 2.1; // lat is to the right; slot 0 sits on the left (+X)
    out.push({ pos: [f.x + f.rx * lat, f.y, f.z + f.rz * lat], tan: [f.tx, f.ty, f.tz], up: [f.ux, f.uy, f.uz], right: [f.rx, f.ry, f.rz], width: f.width, s });
  }
  return out;
}
