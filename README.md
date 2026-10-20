# gamesaloon-rollback

Deterministic rollback netcode for browser and Node games, in TypeScript, plus an adapter that makes the
[Rapier](https://rapier.rs) physics engine rollback-safe. It is game-agnostic and transport-agnostic: you bring a
deterministic simulation and a way to move bytes between peers, the library does the rest.

This repository is a monorepo of three packages:

| package | path | what it is |
| --- | --- | --- |
| `@gamesaloon/rollback` 0.1.0 | `packages/core` | The rollback core. Pure TypeScript, zero runtime dependencies, no DOM. |
| `@gamesaloon/rollback-rapier` 0.0.1 | `packages/rapier` | Snapshot, restore and hash for a Rapier world (deterministic build, pinned to 0.21.0). |
| `@gamesaloon/kart-spike` (private) | `packages/kart-spike` | A feasibility experiment (an arcade kart on Rapier compared with a hand-written sim). Not a library, see "Status and limits". |

## What it does

Every peer runs the whole simulation locally at a fixed tick rate and never waits for the network:

- local input is scheduled a few ticks ahead (input delay, derived from the measured RTT and jitter);
- missing remote inputs are predicted (last known input repeated);
- each tick saves a snapshot into a ring, then steps;
- when a real remote input differs from the prediction, the session restores the snapshot of the earliest wrong tick
  and re-simulates up to the present (rollback);
- confirmed ticks are hashed and hashes are exchanged, so a desync is detected, dumped (`onDesync`) and repaired by
  resyncing the losing peers from the majority peer's snapshot;
- lost peers are handled with an agreed switch tick, so all survivors agree on exactly which inputs were real.

It also ships a deterministic fake network (`NetSim`: latency, jitter, loss, reorder, kill, on a virtual clock) so
netcode can be tested headless, the binary wire format, and a `CorrectionSmoother` for hiding rollback corrections on
screen. 2 to 8 peers, several players per peer.

## Who it is for

Developers of real-time multiplayer games (peer to peer, small rooms, up to 8 peers) who can make their simulation
deterministic and want rollback without building the plumbing. It is a poor fit if your game cannot be made
deterministic, needs more than 8 peers, or needs a late-join protocol (see limits).

## Install

The packages are **not published to npm** (`npm view @gamesaloon/rollback` returns 404) and there is no build step:
`main`/`exports` point at the TypeScript sources (`src/index.ts`). What works today is cloning the repository:

```sh
git clone <url of this repository> gamesaloon-rollback
cd gamesaloon-rollback
npm install        # Node >= 22.18
npm test           # core, rapier and kart-spike tests
```

Then either work inside the workspace (add your game as another `packages/*` entry and depend on
`@gamesaloon/rollback`), or vendor `packages/core/src` into your project: it has no dependencies. Because the entry
points are `.ts` files, consume them through a TypeScript-aware bundler (Vite, esbuild, ...) or, in Node, from a path
that is not under `node_modules` (Node does not strip types of files inside `node_modules`). The scripts use
`node --experimental-strip-types`. The tests were run here with Node 24.21.0.

## Minimal example (no network, no game)

Two peers, two players, a simulated lossy network. The file is `packages/core/examples/minimal.ts`:

```ts
import { NetSim, RollbackSession, evenPeers } from '../src/index.ts'   // '@gamesaloon/rollback' from your own package
import type { InputCodec, SnapReader, SnapWriter, Simulation } from '../src/index.ts'

interface Pad { bits: number } // left=1 right=2 up=4 down=8
const codec: InputCodec<Pad> = {
  create: () => ({ bits: 0 }),
  encode: (i) => i.bits & 15,
  decode: (code, out) => { out.bits = code & 15; return out },
  neutral: 0,
}

// Integer math only, every persistent value is in snapshot()/restore().
class GridSim implements Simulation<Pad> {
  tick = 0
  x = new Int32Array(2)
  y = new Int32Array(2)
  step(inputs: readonly Pad[]) {
    for (let p = 0; p < 2; p++) {
      this.x[p] += (inputs[p].bits & 2 ? 1 : 0) - (inputs[p].bits & 1 ? 1 : 0)
      this.y[p] += (inputs[p].bits & 8 ? 1 : 0) - (inputs[p].bits & 4 ? 1 : 0)
    }
    this.tick++
  }
  snapshot(w: SnapWriter) { w.u32(this.tick); for (let p = 0; p < 2; p++) { w.i32(this.x[p]); w.i32(this.y[p]) } }
  restore(r: SnapReader) { this.tick = r.u32(); for (let p = 0; p < 2; p++) { this.x[p] = r.i32(); this.y[p] = r.i32() } }
}

const net = new NetSim(2, { seed: 1, rttMs: 80, jitterMs: 10, loss: 0.03 })
const sims = [new GridSim(), new GridSim()]
const sessions = [0, 1].map((peer) =>
  new RollbackSession(sims[peer], { localPeer: peer, playerCount: 2, peers: evenPeers(2), codec, tickRate: 60 }, net.transport(peer)))
sessions.forEach((s) => { s.onDesync = (d) => console.warn('desync at tick', d.tick) })

for (let frame = 0; frame < 600; frame++) {
  net.advance(1000 / 60)
  sessions.forEach((s, peer) => {
    // "keyboard": peer 0 walks right then down, peer 1 walks left then up
    s.frame(1 / 60, (local) => { local[0].bits = (frame >> 6) & 1 ? (peer ? 4 : 8) : (peer ? 1 : 2) })
  })
}
const t = Math.min(sessions[0].stats.confirmedTick, sessions[1].stats.confirmedTick)
console.log('confirmed tick', t, 'hashes', sessions[0].confirmedHash(t), sessions[1].confirmedHash(t))
console.log('rollbacks', sessions.map((s) => s.stats.rollbacks), 'desyncs', sessions.map((s) => s.stats.desyncs))
```

```sh
node --experimental-strip-types packages/core/examples/minimal.ts
# confirmed tick 599 hashes 1738694686 1738694686
# rollbacks [ 7, 7 ] desyncs [ 0, 0 ]
```

Both peers end with the same hash on the same confirmed tick, after rollbacks caused by 80 ms RTT, jitter and 3 %
packet loss. In a real game you call `session.frame(dtSeconds, sampleLocal)` once per rendered frame; it returns the
interpolation alpha (0..1) between the last two ticks.

## API at a glance (`@gamesaloon/rollback`)

- `RollbackSession<TInput>(sim, config, transport)`: `frame(dt, sampleLocal)`, `stats`, `smoother`, `onDesync`,
  `onPeerLost`, `leave()`, `dispose()`, `switchTick(peer)`, `confirmedHash(tick)`, `desyncTick`, `desyncAuthority`,
  `resyncs`.
- `Simulation<TInput>` (you implement): `tick`, `step(inputs)`, `snapshot(w)`, `restore(r)`; optional `hash()`,
  `playerDropped(player)`, `beginResim()` / `endResim()`, `view` (smoothing).
- `InputCodec<TInput>` (you implement): `create`, `encode` (to u32), `decode`, `neutral`.
- `NetTransport` (you implement): `send(peer, 'fast' | 'reliable', bytes)`, `drain(out)`, `closed(peer)`, `now()`.
- Helpers: `NetSim`, `SnapWriter` / `SnapReader`, `fnv1a32`, `Rng`, `CorrectionSmoother`, `evenPeers`, `chooseAuthority`,
  `dumpToText`, timing helpers.
- Tuning, all optional: `tickRate` (60), `maxSubsteps` (8), `maxPrediction` (16), `snapshotRing` (40), `minDelay` /
  `maxDelay` (2 / 8), `delayHiddenTicks` (6), `lostAfterMs` (3000), `dropWaitMs` (1500), `dumpTicks` (240).

Full architecture, wire protocol, drop and desync handling: [`docs/DESIGN.md`](docs/DESIGN.md).

## Transport-agnostic design, and GameSaloon

The core never opens a socket. It talks to a `NetTransport` with two channels: `fast` (may drop and reorder, like UDP,
for inputs and pings) and `reliable` (ordered and lossless, for snapshots, drop agreement and desync notices). The
only clock it uses is `transport.now()`. In production that would be a WebRTC data-channel mesh (one unordered
unreliable channel and one ordered channel per peer pair) or a WebSocket relay; in tests it is `NetSim`.

[GameSaloon](https://gameserver.etcito.com) provides rooms and peer-to-peer WebRTC signaling (its rooms protocol
forwards `signal` messages between room members by peer id and, per `PROTOCOL.md` in the GameSaloon repository,
never relays race data). The intended fit is: GameSaloon rooms hand out the peer ids and carry the signaling, you open
the data channels, wrap them in a `NetTransport`, and give the room's peer ids to `RollbackSession` through `peers`.
No ready-made GameSaloon `NetTransport` adapter is included in this repository, so you write that wrapper yourself
(it is a four-method interface plus `now()`). Nothing in this library depends on GameSaloon: it works with any
transport.

## Rapier adapter (`@gamesaloon/rollback-rapier`)

`RapierWorldSim` wraps a Rapier world so it can be snapshotted every tick, restored, and hashed:
`initRapier()` (once, WASM embedded), `createBody`, `removeBody`, `body(id)`, `ids()`, `step()`, `takeSnapshot()`,
`restoreSnapshot(bytes)`, `hash()`, `free()`, plus `TICK_RATE = 60` and `FIXED_DT = 1/60`. Bodies are addressed by
stable ids, not Rapier handles, and the id registry is part of the snapshot, so adding and removing bodies is rolled
back correctly. Wrapping it as a `Simulation` takes a few lines, see [`docs/RAPIER.md`](docs/RAPIER.md), which also has
measured costs (for example 200 bodies: about 1.1 ms per tick including a snapshot, about 10 ms for an 8-tick
rollback, on a desktop CPU under Node 24).

## Determinism: what you must obey

Rollback is only correct if `step` is a pure function of the restorable state and the inputs, bit for bit, on every
peer. The short version (details in [`docs/DESIGN.md`](docs/DESIGN.md) section 2):

- Everything `step` reads or writes across ticks, including `tick` and RNG state, goes through `snapshot` / `restore`.
- No `Math.random`, `Date`, `performance`. Use the seeded `Rng`, whose state you snapshot.
- Only exactly specified math: `+ - * /`, `Math.sqrt`, `abs`, `min`, `max`, floor/ceil/round/trunc, `Math.fround`,
  `Math.imul`. `sin`, `cos`, `atan2`, `exp`, `pow`, `log` differ between JS engines: use your own implementations or
  fixed-point / integer math.
- Deterministic iteration order (arrays by index, total-order sorts); with Rapier, bodies must be created in the same
  order on every peer and only from the simulation step.
- The sim sees only `decode(encode(input))`; inputs fit in 32 bits.
- Mute sounds and particles during re-simulation (`beginResim` / `endResim`).
- Rapier: use the deterministic build and pin the exact version on all peers. Cross-browser and cross-architecture
  bit-equality is what that build promises, but this repository's tests ran on V8 / x86 only; test your target
  browsers before relying on it.

## Status and limits

Version 0.1.0 of the core, 0.0.1 of the adapter: early, not published, not battle-tested outside the tests below.

- Tests: `npm test` runs core (26 tests: 2, 3 and 4 peers with latency, jitter, loss and reordering; several players
  per peer; observer; forced desync with dump and resync; late start; peer loss; wire, timing and codec units),
  rapier (10 tests) and kart-spike (10 tests). All pass here.
- One u32 input per player per tick. At most 8 peers and 8 players per peer; full mesh, so traffic grows with the
  square of the peer count.
- The peer roster is fixed at session creation: no late join into a running match, and a lost peer does not come back.
- Resync snapshots older than 240 ticks are refused; a snapshot is sent whole (up to 16 MiB), no delta snapshots.
- Rapier adapter: full-world snapshots only (cost grows with the world). `userData`, character controller state and
  event queues are not in the snapshot. Multibody joints, heightfields / trimeshes and velocity-based kinematic bodies
  are untested.
- Interest management (rollback by proximity zones) is not implemented; `Simulation.regions` is a reserved seam the
  session ignores.
- `CorrectionSmoother` blends plain linear floats; it does not handle quaternions or wrapping angles.
- `packages/kart-spike` is a private experiment, copied in part from a kart game by the same owner, and is not part of
  the library surface.

## License

MIT, copyright 2026 Etcito. See [`LICENSE`](LICENSE). The Rapier adapter depends on
`@dimforge/rapier3d-deterministic-compat` (Apache-2.0, Dimforge) and credits ideas from Sketchbook (MIT); see
`packages/rapier/NOTICE`.
