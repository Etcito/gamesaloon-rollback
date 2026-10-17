# Design of @gamesaloon/rollback

This library is a generic extraction of the rollback netcode of Monster Racer, a kart racing game by the same owner.
It is a clean descendant of that code only. This document describes the architecture, the determinism rules a
game must follow, what changed when the kart coupling was removed, and one open design question (interest
management).

## 1. What it does

Every peer runs the whole simulation locally at a fixed tick rate. A peer never waits for the network to advance:

1. The local input is sampled each tick and scheduled `delay` ticks in the future (input delay).
2. Remote inputs that have not arrived are predicted (the last known input is repeated).
3. Each tick saves a snapshot into a ring, then steps.
4. When a real remote input arrives and differs from the one the tick was simulated with, the session restores the
   snapshot of the earliest wrong tick and re-simulates up to the present (rollback). Only the earliest wrong tick
   matters, so several late inputs cost one resimulation.
5. A tick becomes confirmed once every awaited input before it is known. Its hash is sent to the other peers
   (3 times, piggybacked on INPUT packets). Two peers that disagree on a confirmed hash have desynced.
6. The simulation stalls only when it would run more than `maxPrediction` ticks ahead of the oldest missing input.

```
 game loop ──frame(dt, sampleLocal)──▶ RollbackSession ──step/snapshot/restore──▶ Simulation (yours)
                                           │   ▲
                                  send/drain│   │now()
                                           ▼   │
                                       NetTransport (WebRTC, WebSocket, NetSim)
```

### Modules (`packages/core/src`)

| file | role |
| --- | --- |
| `types.ts` | `Simulation`, `InputCodec`, `NetTransport`, `RollbackConfig`, `SimView`, `RegionHints` |
| `rollback.ts` | `RollbackSession`: delay, prediction, rollback, stalls, time sync, checksums, desync episodes, drop agreement, resync |
| `wire.ts` | binary codec (INPUT, PING, PONG, SNAPSHOT, DROP, DESYNC, READY, BYE), `SnapshotAssembler`; reused buffers, no allocation after warm-up on the hot messages |
| `timing.ts` | RTT/jitter estimator, input delay formula, delay controller, time sync |
| `inputBuffer.ts` | per-player ring of u32 input codes with a contiguous-known frontier and prediction |
| `desync.ts` | authority choice, desync dump, base64 and text rendering of the dump |
| `smoothing.ts` | `CorrectionSmoother`: displayed pose keeps the pre-rollback value and decays to the simulated one |
| `netsim.ts` | `NetSim`: deterministic fake network (latency, jitter, loss, reorder, kill) on a virtual clock |
| `snap.ts`, `rng.ts` | `SnapWriter`/`SnapReader`, `fnv1a32`, seeded `Rng` |

### Wire protocol

Little-endian. Byte 0 is the message type, byte 1 the sender peer id. Ticks are u32 on the wire and decoded as signed
32-bit (so -1 survives). Every decoder returns `null` for anything malformed and never throws; decoded messages are
reused objects valid until the next decode of the same type.

- INPUT (fast): ack of the receiver's inputs, `firstTick`, up to 64 ticks x players-per-peer u32 codes, the sender's
  tick (for time sync) and the not-yet-repeated confirmed checksums. Redundancy (every tick newer than the ack is
  resent) makes single losses harmless.
- PING/PONG (fast): RTT and jitter. SNAPSHOT (reliable): authority snapshot in parts of at most 16000 bytes, verified
  by fnv1a32 on reassembly. DROP, DESYNC, BYE (reliable). READY (reserved for a pre-game handshake; the session ignores it).

### Input delay and time sync

`delay = clamp(ceil((rtt/2 + jitter) * tickRate / 1000) - delayHiddenTicks, minDelay, maxDelay)` using the worst
live peer; the delay moves at most one tick per 500 ms. If the local peer runs more than 2 ticks ahead of the others on
average it skips a tick (at most once per 30 ticks) so that slow peers are not permanently the one rolling back.

### Drop handling

A peer is lost when it says BYE, its transport reports `closed`, or it is silent for `lostAfterMs`. Each survivor
broadcasts DROP with the lost peer's last inputs and the last tick it holds. Once a DROP from every survivor is in,
the switch tick `S` is the maximum announced tick, so all survivors agree on exactly which inputs of the lost peer
were real. From tick `S + 1` the lost peer's players get the codec's `neutral` input and `Simulation.playerDropped(player)`
is called (idempotently, every tick, also during re-simulations) so the game can remove the player or hand it to a bot.
A survivor that does not answer within `dropWaitMs` is declared lost too and the agreement restarts over the smaller set.

### Desync detection, dump and resync

A mismatching confirmed hash starts an episode: `onDesync(dump)` fires (tick, local and remote hashes, snapshot of
the mismatch tick in base64, the last `dumpTicks` ticks of used inputs, your `dumpInfo()`), and DESYNC is broadcast.
Once every live peer's hash for that tick is known, `chooseAuthority` picks the majority hash; ties go to the group
holding the lowest peer id. The authority sends the snapshot of its latest confirmed tick to the losers, which load
it and re-simulate to the present with their buffered inputs. A loser's stale checksums are ignored while it resyncs.
All peers compute the same decision from the same data, so no extra coordination is needed.

## 2. Determinism rules (what your `Simulation` must obey)

Rollback is only correct if `step` is a pure function of the restorable state and the inputs, bit for bit, on every
machine and browser.

1. **No hidden state.** Everything `step` reads or writes that persists across ticks must be written by `snapshot`
   and read by `restore`, including `tick` and RNG state. Caches derived from restorable state are fine if they are
   rebuilt or provably equal. A test must exist that restores a snapshot mid-run and compares hashes (the reference
   tests do exactly this by comparing peers that rolled back with peers that did not).
2. **No clocks, no `Math.random`, no `Date`, no `performance`.** Randomness comes from a seeded generator whose state
   is part of the snapshot (`Rng` is provided).
3. **No platform-dependent math.** `+ - * /`, `Math.sqrt`, `abs`, `min`, `max`, `floor`, `ceil`, `round`, `trunc`,
   `fround` and `Math.imul` are exactly specified. Transcendental functions (`sin`, `cos`, `atan2`, `exp`, `pow`, `log`...)
   differ between engines: use your own (polynomial) implementations, or integer / fixed-point math. Monster Racer
   forbids them in simulation code and checks it with a source scan; do the same.
4. **Deterministic iteration order.** Iterate arrays by index; sort with total orders (index tiebreak); no reliance on
   `Set`/`Map` insertion order unless it is itself deterministic.
5. **Inputs are quantised.** The simulation only sees `decode(encode(x))`. The session guarantees it, also for the
   local player. Inputs fit in 32 bits.
6. **View side effects are muted during re-simulation.** Sounds and particles must not replay on rollback: implement
   `beginResim` / `endResim`, and drive view events from confirmed state or from events emitted outside re-simulation.
7. **Floating point is allowed only if you can prove it bit-exact** (IEEE-754 doubles with the operations of rule 3 and
   no fused multiply-add differences, which JS does not do). Physics engines (see `packages/rapier`) need their own
   determinism guarantees.
8. **Hot path discipline.** `step`, `read`, `encode` and `decode` should not allocate. The session itself keeps the Monster Racer discipline: reused buffers, rings and message objects, no per-tick allocation in the tick/receive/send path. It still allocates a small `SnapReader` per rollback and, on a desync, the dump and snapshot parts; those are rare events. This is by construction, not enforced by a test.

Hashes: by default the session hashes the snapshot bytes (fnv1a32), so a game gets desync detection for free and the
hash covers exactly what is restorable. `Simulation.hash()` is an optional fast path; if present it is called once per
simulated tick before `step` and must cover the same state.

## 3. What was generalised compared to the kart original

| Monster Racer | here |
| --- | --- |
| `RaceSession` (karts, track, controllers, events, `saveState`/`loadState`) | `Simulation<TInput>`: `tick`, `step(inputs)`, `snapshot(w)`, `restore(r)`, optional `hash`, `playerDropped`, `beginResim`/`endResim`, `view` |
| `KartInput` + `packInput`/`unpackInput`/`NEUTRAL_CODE` (hard-coded layout) | `InputCodec<TInput>` (`create`, `encode`, `decode`, `neutral`) |
| karts per peer, max 8 (`MAX_WIRE_KARTS`), human karts only | players per peer, any number from 0 to 8 per peer (`MAX_WIRE_PLAYERS`); players nobody owns get the neutral input; observer peers with 0 players |
| 'net' controller reading `race.ext('net.inputs')` | the session passes the decoded inputs array straight to `step` |
| lost peer's karts switch to AI controllers (`setController`) | lost peer's players get `neutral` input from `S + 1` and `playerDropped(player)` is called |
| `events.muted` during re-simulation | `beginResim` / `endResim` hooks |
| `setup: RaceSetup` in the desync dump | `dumpInfo()` callback, opaque to the library |
| kart `Vector3` / `Quaternion` smoothing with `dexp` | `CorrectionSmoother` over a flat float view (`SimView`), view-side only |
| `SnapWriter.vec3/quat` (three.js) | removed; `i16`, `f32` added; zero dependencies |
| constants (120 Hz tick, prediction 16, ring 40, delay 2..8, hidden 6, timeouts) | `RollbackTuning` options with defaults; tick rate default 60 Hz |
| READY carried `raceIndex` / `setupHash` | same bytes renamed `session` / `configHash` |
| hash = fnv1a32 of the snapshot | same by default, `Simulation.hash()` optional |
| `RollbackSession` constructor took a CPU timer | `cfg.cpuMs` optional |

Kept unchanged: fixed tick and accumulator with `maxSubsteps`, snapshot ring, used-code ring, misprediction detection
(`usedCode` vs late-arriving real code), earliest-tick rollback, stall at `maxPrediction`, RTT-driven delay, time sync,
drop agreement with switch tick, desync episodes with majority authority, snapshot resync in reliable parts, checksum
redundancy, `NetSim` and the whole wire format.

### Not generalised (known limits)

- **Inputs are one u32 per player per tick.** Games with larger inputs must pack or quantise. Variable-size inputs would
  need a length-prefixed wire format and variable-width input buffers.
- **At most 8 peers** (`MAX_PEERS`) and **8 players per peer** (`MAX_WIRE_PLAYERS`); both are constants and one byte on
  the wire, and the mesh is full (every peer talks to every peer), so bandwidth grows with the square of the peer count.
- **The peer roster is fixed at session creation.** A peer that falls away is dropped for good. A true late joiner
  (a new peer entering a running match) is not supported: the supported recoveries are a peer starting late within
  `lostAfterMs` (the others stall, then everyone converges) and a peer starting from a wrong state (detected on the
  first confirmed tick, resynced from the authority snapshot). A real late join needs a roster-change protocol
  (agreed join tick, a snapshot pushed by an authority, input delay bootstrap) and is future work.
- **Resync snapshots older than `RESYNC_MAX_TICKS` (240) are refused**; the snapshot is a single reliable message of up
  to 16 MiB. Large worlds will want delta or interest-filtered snapshots (see below).
- **`CorrectionSmoother` blends plain linear floats.** Rotations (quaternions) and wrapping angles are not handled.
- **Time sync is the original heuristic** (skip a tick when ahead), not a clock-synchronisation protocol.

## 4. Interest management (open design question)

The owner wants rollback by proximity zones: a peer fully simulates, predicts and rolls back only the entities near it,
and drives the far ones from received state. This is **not implemented**. The current model is the opposite: a global
deterministic lockstep-with-rollback where every peer simulates everything, and any peer's input can invalidate any
tick.

What the seam is: `Simulation.regions?: RegionHints` (`regionOf(player)`, `adjacent(a, b)`) and `Simulation.view`
exist in the contract. The session ignores them today. A simulation can already declare regions; a future session
could use them to decide which entities are local-authoritative.

Open questions:

1. **Ownership of far entities.** Far entities cannot be re-simulated from inputs they never receive, so they must come
   from state. Who is authoritative for an entity: its owning peer (client-authoritative, cheating risk), a region host,
   or a server? With a pure peer mesh the natural choice is "the peer that fully simulates it", with handoff when a
   player crosses a region border.
2. **Two kinds of entities in one snapshot.** Snapshots, hashes and the desync check must be split: near (predicted,
   rolled back, hash-checked among the peers that share the region) and far (injected state with a tick stamp, not
   rolled back, not hash-checked). `snapshot`/`restore`/`hash` need a per-region or per-entity-range form so that a peer can
   restore only its near set.
3. **Rollback coupling at region borders.** A near entity can interact with a far one (collision, projectile). Options:
   keep a margin ring of "shadow" entities simulated from state with dead reckoning, and accept a visible correction
   when authoritative state arrives; or treat border interactions as events resolved by the region owner and applied
   with a delay.
4. **Input routing.** INPUT packets would go only to peers whose regions are adjacent (`adjacent(a, b)`), turning the full
   mesh into a dynamic graph and requiring join/leave of region subscriptions without breaking the ack/confirm logic
   (today `confirmed` assumes every peer's inputs are known).
5. **Handoff protocol.** A player moving between regions needs an agreed handoff tick so that exactly one peer is
   authoritative, similar to the drop agreement (agreed switch tick) but bidirectional.
6. **Desync handling.** Majority-authority resync assumes all peers simulate the same state. With regions, hash groups are
   per region, and the authority is chosen per region (resync only the near snapshot).
7. **Determinism of far-state injection.** Injected state arrives at different times on different peers, so far entities are
   outside the deterministic core; anything near that depends on them inherits that non-determinism. Either near
   entities only read far state through a deterministic, tick-stamped interface (state at tick `T - k`, delayed
   identically for everyone), or the near/far boundary is declared non-deterministic and only hash-checked on the near set.
8. **Granularity.** Fixed grid cells, game-defined zones or a dynamic radius? A dynamic radius is attractive for open
   worlds but changes the peer set per player every tick.

A plausible first step that fits the current code: keep the global model, but let `RegionHints` filter which players'
inputs are sent to which peers and treat the far players' inputs as always predicted (never rolled back); the hash
check is then limited to the shared region. That already cuts bandwidth and rollback cost but still requires correction
of far players, which is question 3 above.

## 5. Testing

`packages/core/test/` has a reference simulation (`pointsim.ts`: N point masses with integer math, input bitmasks,
collisions and a seeded wind that couple all players) and a harness that wires N sessions through `NetSim` on a virtual
60 fps clock. Scenarios: 2, 3 and 4 peers with latency, jitter, loss and reordering all end with identical hashes on
every confirmed tick; several players per peer and an observer; forced desync (majority and tie) with dump and resync;
late start; a peer starting from a stale state; peer loss (kill and BYE) with switch-tick agreement; wire, timing, codec,
buffer and smoother unit tests. Run with `npm test` in `packages/core`.
