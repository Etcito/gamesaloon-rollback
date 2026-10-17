export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** x wrapped into [0, len). Returns 0 when len <= 0. */
export function wrap(x: number, len: number): number {
  if (!(len > 0)) return 0;
  let r = x % len;
  if (r < 0) r += len;
  return r >= len ? 0 : r;
}
