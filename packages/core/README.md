# @gamesaloon/rollback

Generic, game-agnostic rollback netcode in pure TypeScript. Zero runtime dependencies, no DOM, no Node-only APIs,
no clock besides your transport's `now()`. Runs in browsers and in Node.

You provide a deterministic fixed-tick `Simulation`, an input codec and a `NetTransport`. The library provides input
delay from the measured RTT, prediction, a snapshot ring, misprediction detection, resimulation, time sync, drop
handling, desync detection with a dump, authority resync, correction smoothing, the binary wire format and `NetSim`
(a deterministic fake network for headless tests). 2 to 8 peers, several players per peer.

## Usage

```ts
import { RollbackSession, evenPeers } from '@gamesaloon/rollback'
import type { InputCodec, NetTransport, SnapReader, SnapWriter, Simulation } from '@gamesaloon/rollback'

interface Pad { bits: number }                       // left=1 right=2 up=4 down=8
const codec: InputCodec<Pad> = {
  create: () => ({ bits: 0 }),
  encode: (i) => i.bits & 15,
  decode: (code, out) => { out.bits = code & 15; return out },
  neutral: 0,
}

class MySim implements Simulation<Pad> {              // integer / fixed-point math only, see docs/DESIGN.md
  tick = 0
  x = new Int32Array(2); y = new Int32Array(2)
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

const session = new RollbackSession(new MySim(), {
  localPeer: myPeerId, playerCount: 2, peers: evenPeers(2), codec, tickRate: 60,
}, transport)                                         // transport: your NetTransport (WebRTC, WebSocket...)
session.onDesync = (dump) => console.warn('desync at tick', dump.tick)

function frame(dtSeconds: number) {                   // call once per rendered frame
  const alpha = session.frame(dtSeconds, (local) => { local[0].bits = readKeyboard() })
  render(alpha)                                       // alpha = 0..1 between the last two ticks
}
```

Test without a network:

```ts
import { NetSim } from '@gamesaloon/rollback'
const net = new NetSim(2, { seed: 1, rttMs: 80, jitterMs: 10, loss: 0.03 })
const t0 = net.transport(0), t1 = net.transport(1)    // one NetTransport per peer
net.advance(1000 / 60)                                // virtual clock, call before each frame
```

See `test/` for a full reference simulation and scenarios with 2, 3 and 4 peers, forced desync, late start and drops.

## API

- `RollbackSession<TInput>(sim, config, transport)`: `frame(dt, sampleLocal)` returns the interpolation alpha;
  `stats`, `smoother`, `onDesync`, `onPeerLost`, `leave()`, `dispose()`, `switchTick(peer)`, `confirmedHash(tick)`,
  `desyncTick`, `desyncAuthority`, `resyncs`.
- `Simulation<TInput>`: `tick`, `step`, `snapshot`, `restore`; optional `hash`, `playerDropped`, `beginResim`,
  `endResim`, `view` (smoothing) and the reserved `regions` seam.
- `InputCodec<TInput>`: `create`, `encode` (to u32), `decode`, `neutral`.
- `NetTransport`: `send(peer, 'fast' | 'reliable', bytes)`, `drain(out)`, `closed(peer)`, `now()`.
- `NetSim`, `SnapWriter` / `SnapReader`, `fnv1a32`, `Rng`, wire `WireWriter` / `decode`, `CorrectionSmoother`,
  `chooseAuthority`, `dumpToText`, timing helpers (`inputDelayFor`, `RttEstimator`, `DelayController`, `TimeSync`).

Tuning (all optional): `tickRate` (60), `maxSubsteps` (8), `maxPrediction` (16), `snapshotRing` (40), `minDelay` /
`maxDelay` (2 / 8), `delayHiddenTicks` (6), `lostAfterMs` (3000), `dropWaitMs` (1500), `dumpTicks` (240).

## Scripts

`npm test` (Node 22.18+, `node --experimental-strip-types --test`), `npm run typecheck`.

MIT.
