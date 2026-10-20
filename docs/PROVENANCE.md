# Provenance of @gamesaloon/rollback

## Origin

The rollback netcode in this library was first written for a kart racing game (Monster Racer) by the same author.
The game-specific code was removed and the rest was generalised into a game-agnostic library. This is a
descendant of that code only: no game content, assets or game-specific constants are included.

The generalisation was deliberate. A short summary of what changed and what was kept follows, for readers who
know the original code.

## What was generalised

| Original (game) | Here |
| --- | --- |
| `RaceSession` (karts, track, controllers, events, `saveState`/`loadState`) | `Simulation<TInput>`: `tick`, `step(inputs)`, `snapshot(w)`, `restore(r)`, optional `hash`, `playerDropped`, `beginResim`/`endResim`, `view` |
| Fixed input struct with a hard-coded bit layout (`packInput`/`unpackInput`/`NEUTRAL_CODE`) | `InputCodec<TInput>` (`create`, `encode`, `decode`, `neutral`) |
| Karts per peer, capped at a constant of 8, human karts only | Players per peer, any number from 0 to 8 per peer; players nobody owns get the neutral input; observer peers with 0 players |
| A "net" controller reading `race.ext('net.inputs')` | The session passes the decoded inputs array straight to `step` |
| A lost peer's karts switch to AI controllers (`setController`) | A lost peer's players get `neutral` input from `S + 1` and `playerDropped(player)` is called |
| `events.muted` during re-simulation | `beginResim` / `endResim` hooks |
| `setup` object in the desync dump | `dumpInfo()` callback, opaque to the library |
| Vector / quaternion smoothing with a game math library | `CorrectionSmoother` over a flat float view (`SimView`), view side only |
| Vector and quaternion serialisation helpers | Removed; `i16` and `f32` added; zero dependencies |
| Game constants (tick rate, prediction window, ring size, delay bounds, timeouts) | `RollbackTuning` options with defaults; tick rate default 60 Hz |
| READY carried a race index and a setup hash | Same bytes, renamed `session` / `configHash` |
| Hash = fnv1a32 of the snapshot | Same by default; `Simulation.hash()` optional |
| Session constructor took a CPU timer | `cfg.cpuMs` optional |

## What was kept unchanged

Fixed tick and accumulator with `maxSubsteps`, snapshot ring, used-code ring, misprediction detection (used code
versus late-arriving real code), earliest-tick rollback, stall at `maxPrediction`, RTT-driven input delay, time sync,
drop agreement with switch tick, desync episodes with majority authority, snapshot resync in reliable parts, checksum
redundancy, the simulated network (`NetSim`) and the whole wire format.

## Known differences from the original reference project

- The Rapier adapter's notes (see [`RAPIER.md`](RAPIER.md)) record one difference observed against the reference
  project: the reference excluded body positions from its checksum because it saw small divergence after restore.
  With the adapter, restore plus resimulation was bit-exact in every test, so the full snapshot is hashed.
