# Rapier adapter (`@gamesaloon/rollback-rapier`)

Wraps the cross-platform deterministic Rapier build (`@dimforge/rapier3d-deterministic-compat`,
pinned to 0.21.0) so a rollback core can snapshot, restore and hash a physics world.
All numbers below were measured (Node 24, AMD Ryzen 9 3900XT, WSL2, single thread, WASM).

## API

```ts
import { initRapier, RapierWorldSim } from "@gamesaloon/rollback-rapier";

const R = await initRapier();            // once; memoised; WASM is embedded (base64), no fetch
const sim = new RapierWorldSim(R);       // gravity (0,-9.81,0), dt = 1/60

const id = sim.createBody(R.RigidBodyDesc.dynamic().setTranslation(0, 5, 0), [R.ColliderDesc.ball(0.5)]);
sim.body(id).applyImpulse({ x: 0, y: 3, z: 0 }, true);   // inputs: by stable id, in a fixed order
sim.step();                              // exactly one fixed tick, sim.tick++
const bytes = sim.takeSnapshot();        // Uint8Array
sim.restoreSnapshot(bytes);              // replaces the World, frees the old one
sim.hash();                              // fnv1a32 over the exact snapshot bytes
sim.removeBody(id);
```

Also: `ids()` (insertion order), `hasBody`, `bodyCount`, `world` (raw Rapier World, for joints and
queries), `free()`, constants `TICK_RATE = 60`, `FIXED_DT = 1/60`, and `fnv1a32(bytes)`.

Snapshot layout: `[24 B header: magic, version, tick, nextId, count, rapierLen][count x (id u32, handle f64)][Rapier bincode bytes]`.
The id registry and the id counter are inside the snapshot, so add/remove between snapshots is
rolled back too and ids are handed out again identically on replay.

### Wrapping as a core `Simulation<TInput>`

```ts
class PhysicsSim implements Simulation<MyInput> {
  constructor(private sim: RapierWorldSim) {}
  get tick() { return this.sim.tick; }
  step(inputs: MyInput) { applyInputs(this.sim, inputs); this.sim.step(); }
  snapshot(w: SnapWriter) { w.bytes(this.sim.takeSnapshot()); }
  restore(r: SnapReader) { this.sim.restoreSnapshot(r.bytes()); }
  hash() { return this.sim.hash(); }
}
```

Game state that lives outside Rapier (cooldowns, health, state machines) must be snapshotted by
the game next to this and mixed into the hash; the adapter only covers the physics world.

## Determinism rules

1. Use the deterministic build only (`rapier3d-deterministic-compat`). The regular and SIMD builds
   can differ across CPUs and browsers. Pin the exact version on all peers; a version bump changes
   the snapshot format and the results.
2. One `step()` = one tick of `dt = 1/60`. Never feed a wall-clock delta. `world.timestep` is
   forced to `dt` at construction and after every restore.
3. No `Math.random`, `Date.now`, `performance.now` in sim code. Use an integer PRNG whose state
   is part of your snapshot (see `mulberry32` in `test/scenario.ts`).
4. Float math outside Rapier (steering, springs, aiming) is your responsibility. `+ - * /` and
   `Math.sqrt` are exactly specified by IEEE 754 and safe. `Math.sin/cos/pow/exp/atan2/...` are
   implementation-defined and can differ between engines (V8 vs JavaScriptCore vs SpiderMonkey);
   use your own polynomial/table versions or fixed-point in sim code. Avoid `Math.fround`
   mismatches: be consistent about when you round to f32.
5. Insertion order is state. Rapier's internal arenas hand out handles in creation order and
   iterate by arena index, so two peers must create/remove bodies and colliders in the same order
   (tested: swapping two creations changes the hash). Create bodies from the sim step or the
   snapshot, never from render or network callbacks.
6. Apply inputs in a canonical order (ascending player id / body id), always before `step()`.
   Iterate `sim.ids()`, never a JS `Set`/object built from unordered data.
7. Keep Rapier object references out of long-lived state. After `restoreSnapshot` the World is a
   new WASM object; hold `BodyId`s and call `sim.body(id)`.
8. Compare with `hash()` (exact bytes, no rounding). Exchange it with peers on a confirmed tick
   to detect desync.

## Measured results

Scenario: ground + 4 walls + N dynamic bodies (alternating balls and cuboids, restitution 0.3,
friction 0.7) dropped in a grid, run 180 ticks (landed, many contacts), impulses every 7th tick.
"never sleep" = `canSleep(false)` (worst case, every body always simulated).

(a) Two independent worlds, 200 bodies, identical inputs, 5000 steps: hashes compared every 50
ticks (100 comparisons) and the final snapshot compared byte for byte: identical.

(b) Snapshot at tick 300, run to 420, restore, rerun: identical hash and identical bytes, 5
consecutive rollbacks; also identical when restored into a freshly built sim instance; also
identical for restores at ticks 0, 8, 96, 232, 400, 592 of a 600 tick run (200 bodies).
Snapshot -> restore -> snapshot is byte-identical.

(c)+(d) Cost per operation in ms (mean) and snapshot size:

| bodies | sleeping | step | snapshot | restore | fnv1a32 only | hash() | tick + save | rollback 8 ticks | snapshot size | bytes/body |
|-------:|:--------:|-----:|---------:|--------:|-------------:|-------:|------------:|-----------------:|--------------:|-----------:|
| 50   | allowed | 0.22 | 0.20 | 0.23 | 0.08 | 0.23 | 0.31 | 2.6  | 68 KB    | 1361 |
| 200  | allowed | 0.89 | 0.92 | 0.56 | 0.37 | 1.0  | 1.1  | 9.8  | 357 KB   | 1786 |
| 1000 | allowed | 6.5  | 4.3  | 3.3  | 2.4  | 6.0  | 9.7  | 81.6 | 2.34 MB  | 2339 |
| 50   | never   | 0.19 | 0.06 | 0.29 | 0.07 | 0.12 | 0.28 | 2.7  | 67 KB    | 1348 |
| 200  | never   | 1.0  | 0.49 | 0.44 | 0.38 | 0.93 | 1.5  | 12.1 | 351 KB   | 1754 |
| 1000 | never   | 7.0  | 3.6  | 2.9  | 2.5  | 5.0  | 10.4 | 89   | 2.34 MB  | 2337 |

"tick + save" = one step plus one snapshot (the steady state cost if you snapshot every tick).
"rollback 8 ticks" = restore + 8 x (step + snapshot). Timings fluctuate by roughly +-20% between
runs (small snapshot times are dominated by allocation/GC noise); treat them as order of magnitude.

Budget at 60 Hz = 16.7 ms per tick, 8 tick rollback window:

- 50 bodies: 0.3 ms steady, 2.7 ms for an 8 tick rollback. Very comfortable.
- 200 bodies: 1.1-1.5 ms steady, 10-12 ms for a rollback frame. Fits (rollback frame stays under
  one 16.7 ms tick), but leaves little room next to rendering on a slow phone (this CPU is desktop class).
- 1000 bodies: 9.7-10.4 ms steady (60% of the frame budget just for sim + save) and 80-90 ms for a
  rollback frame (5 dropped frames). Not affordable with a full world snapshot every tick. Practical
  ceiling with full snapshots is roughly 250-400 bodies on this CPU for an 8 tick window with
  rollbacks staying in one frame; budget a factor 2-3 less on low-end mobile.

Cost split at 1000 bodies (sleeping allowed): step 6.5 ms, serialisation 4.3 ms, fnv1a32 2.4 ms, i.e. about 49% / 33% / 18% (the hash is pure JS and
is only needed on ticks you exchange, not every tick; snapshot cost is needed every tick unless
you snapshot every Nth tick and resimulate more).

Memory: a ring of 8 snapshots is 8 x snapshot size: ~0.5 MB at 50 bodies, ~2.9 MB at 200, ~19 MB at 1000.
About 1.3-2.3 KB per body (contact graph and solver warm-start data dominate, which is why the
size grows per body when bodies are in contact).

(e) Adding/removing bodies between snapshots: tested. Remove 3, add 3, add+remove 1, step 40,
restore to the earlier snapshot: removed bodies are back with their ids, added ids are gone,
every id resolves to a live body; replaying the same script allocates the same ids and ends in the
identical hash. Rapier handles are preserved by the bincode snapshot; the registry is stored and
re-linked on restore.

## Known limits

- Full-world snapshots only: the cost is O(world), not O(changed). No delta snapshots yet.
- Not in the snapshot (keep in your own snapshotted state): `userData` (measured: undefined after
  restore), anything JS-side such as character controller settings and the kinematic character
  controller's own state (the Rapier KinematicCharacterController is stateless; the previous
  velocity/grounded flags you keep are yours), your `EventQueue` contents, and your own `BodyId`
  to game-object map.
- Event queue: collision/contact events are produced per `step(queue)` and must be drained inside
  the same tick. Events emitted during a resimulation are emitted again; dedupe by tick or
  suppress side effects while resimulating. Do not carry an undrained queue across a restore.
- Verified surviving restore: dynamic and fixed bodies, position-based kinematic bodies (including
  their pending next-kinematic target), colliders (shape, friction, collision groups), spherical
  impulse joints, sleeping state, contact warm-start (snapshot -> restore -> snapshot is
  byte-identical). Not tested: multibody joints, CCD-heavy scenes, heightfields/trimeshes, velocity-based
  kinematic bodies, other joint types (they use the same serialisation path).
- JS handles to Rapier objects (`RigidBody`, `Collider`, `ImpulseJoint`) are invalid after a
  restore; re-fetch via `sim.body(id)` / `sim.world`.
- Snapshot bytes are tied to the Rapier version and to this adapter's `VERSION`; do not persist
  them across upgrades or send them between peers on different versions.
- Cross-engine bit-exactness (V8 vs JavaScriptCore vs SpiderMonkey, x86 vs ARM) is what the
  deterministic build promises; this repo's tests only ran on V8/x86 (two worlds in one process
  and across restores), so cross-browser/arch equality is not independently verified here.
  Run the same test in your target browsers before relying on it.
- Differences from the reference project: it excluded body positions from its checksum because it saw
  small divergence after restore. With this adapter, restore plus resimulation was bit-exact in all
  tests here, so the full snapshot can be hashed. The divergence there most likely came from game-side
  state not being restored (or being restored out of order) rather than from Rapier itself, but that
  was not investigated.
