// Two peers, two players, one simulated network. Run: node --experimental-strip-types packages/core/examples/minimal.ts
import { NetSim, RollbackSession, evenPeers } from '../src/index.ts'
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
