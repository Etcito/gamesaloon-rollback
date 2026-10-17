import RAPIER from "@dimforge/rapier3d-deterministic-compat";

export type RapierModule = typeof RAPIER;

let pending: Promise<RapierModule> | null = null;

/**
 * Initialise the Rapier WASM module once. Safe to call many times and
 * concurrently: every caller gets the same promise. The WASM is embedded in the
 * "-compat" package (base64), so no fetch or bundler asset handling is needed in
 * the browser or in Node.
 *
 * MUST be the deterministic build ("rapier3d-deterministic-compat"): the
 * non-deterministic builds use SIMD and may differ across CPUs / engines.
 */
export function initRapier(): Promise<RapierModule> {
  if (!pending) {
    pending = RAPIER.init().then(() => RAPIER);
  }
  return pending;
}
