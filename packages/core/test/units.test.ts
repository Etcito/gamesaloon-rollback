import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CorrectionSmoother, DelayController, InputBuffer, MSG, MAX_WIRE_TICKS, NetSim, RttEstimator, SnapReader, SnapWriter, SnapshotAssembler,
  SNAPSHOT_CHUNK, TimeSync, WireWriter, chooseAuthority, decode, fnv1a32, inputDelayFor,
} from '../src/index.ts'
import type { SimView } from '../src/index.ts'

test('snap: round trip of every field type', () => {
  const w = new SnapWriter()
  w.u8(200); w.u16(65000); w.u32(4000000000); w.i32(-5); w.i16(-300); w.f32(1.5); w.f64(Math.PI); w.bool(true); w.str('héllo')
  const r = new SnapReader(w.bytes().slice())
  assert.equal(r.u8(), 200); assert.equal(r.u16(), 65000); assert.equal(r.u32(), 4000000000); assert.equal(r.i32(), -5)
  assert.equal(r.i16(), -300); assert.equal(r.f32(), 1.5); assert.equal(r.f64(), Math.PI); assert.equal(r.bool(), true); assert.equal(r.str(), 'héllo')
  assert.equal(r.remaining, 0)
  assert.throws(() => r.u8(), /overrun/)
})

test('fnv1a32 known values', () => {
  assert.equal(fnv1a32(new Uint8Array(0)), 0x811c9dc5)
  assert.equal(fnv1a32(new TextEncoder().encode('a')), 0xe40c292c)
})

test('input buffer: contiguous frontier, prediction, stale slots', () => {
  const b = new InputBuffer(0, 16)
  assert.equal(b.predict(5), 0)
  b.set(0, 7); b.set(2, 9)
  assert.equal(b.lastTick, 0)
  b.set(1, 8)
  assert.equal(b.lastTick, 2)
  assert.equal(b.predict(10), 9)
  assert.equal(b.predict(1), 8)
  assert.equal(b.get(3), undefined)
  assert.equal(b.set(1, 8), false)
  assert.equal(b.set(1, 6), true)
})

test('timing: input delay table, RTT estimator, delay controller, time sync', () => {
  const p = { tickRate: 120, minDelay: 2, maxDelay: 8, hiddenTicks: 6 }
  assert.equal(inputDelayFor(0, 0, p), 2)
  assert.equal(inputDelayFor(150, 20, p), 6)
  assert.equal(inputDelayFor(400, 0, p), 8)
  const e = new RttEstimator()
  e.sample(100); e.sample(100)
  assert.equal(e.rtt, 100)
  const d = new DelayController(2, p)
  assert.equal(d.update(0, 150, 20), 3)
  assert.equal(d.update(100, 150, 20), 3)
  assert.equal(d.update(600, 150, 20), 4)
  const ts = new TimeSync(60)
  for (let i = 0; i < 10; i++) ts.observe(1, 100, 110, 0)
  assert.equal(ts.advantage(1), 10)
  assert.equal(ts.shouldSkip(200), true)
  assert.equal(ts.shouldSkip(210), false)
})

test('wire: every message round-trips, malformed input is rejected without throwing', () => {
  const w = new WireWriter()
  const codes = new Uint32Array([1, 2, 0xdeadbeef, 4, 5, 6])
  const m = decode(w.input({ from: 3, ackTick: -1, firstTick: 10, count: 3, players: 2, codes, senderTick: 12, checks: [{ tick: 9, hash: 0xcafebabe }] }))
  assert.ok(m && m.type === MSG.INPUT)
  if (m && m.type === MSG.INPUT) {
    assert.equal(m.ackTick, -1)
    assert.deepEqual([...m.codes], [...codes])
    assert.equal(m.checks[0].hash, 0xcafebabe)
  }
  const ping = decode(w.ping(2, 77, 12.5))
  assert.ok(ping && ping.type === MSG.PING && ping.id === 77 && ping.ms === 12.5)
  const drop = decode(w.drop(1, 2, 20, 18, 1, 3, [7, 8, 9]))
  assert.ok(drop && drop.type === MSG.DROP && drop.lostPeer === 2 && drop.count === 3)
  const ds = decode(w.desync(4, 99, 0x12345678))
  assert.ok(ds && ds.type === MSG.DESYNC && ds.hash === 0x12345678)
  const rd = decode(w.ready(1, 5, 0xabcdef01))
  assert.ok(rd && rd.type === MSG.READY && rd.session === 5)
  assert.ok(decode(w.bye(7))?.type === MSG.BYE)
  const good = w.ping(1, 1, 1).slice()
  assert.equal(decode(good.subarray(0, 5)), null)
  assert.equal(decode(new Uint8Array([99, 0, 0, 0])), null)
  assert.equal(decode(new Uint8Array(0)), null)
  assert.equal(MAX_WIRE_TICKS, 64)
})

test('wire: a multi-part snapshot reassembles and a corrupted one is refused', () => {
  const w = new WireWriter()
  const bytes = new Uint8Array(40000)
  let s = 5
  for (let i = 0; i < bytes.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; bytes[i] = s >>> 24 }
  const hash = fnv1a32(bytes)
  const parts = w.snapshotParts(1, 321, hash, bytes).map((p) => p.slice())
  assert.ok(parts.length === 3 && parts.every((p) => p.length <= SNAPSHOT_CHUNK + 32))
  const asm = new SnapshotAssembler()
  let got = null
  for (const p of parts.reverse()) {
    const m = decode(p)
    if (m && m.type === MSG.SNAPSHOT) got = asm.push(m) ?? got
  }
  assert.ok(got && got.tick === 321 && got.bytes.length === bytes.length && fnv1a32(got.bytes) === hash)
  const bad = w.snapshotParts(1, 322, hash ^ 1, bytes).map((p) => p.slice())
  let refused = true
  for (const p of bad) {
    const m = decode(p)
    if (m && m.type === MSG.SNAPSHOT && asm.push(m)) refused = false
  }
  assert.ok(refused)
})

test('chooseAuthority: majority wins, ties go to the group holding the lowest peer', () => {
  assert.deepEqual(chooseAuthority([{ peer: 0, hash: 1 }, { peer: 1, hash: 2 }, { peer: 2, hash: 2 }]), { hash: 2, authority: 1, losers: [0] })
  assert.deepEqual(chooseAuthority([{ peer: 0, hash: 1 }, { peer: 1, hash: 2 }]), { hash: 1, authority: 0, losers: [1] })
  assert.deepEqual(chooseAuthority([]), { hash: 0, authority: -1, losers: [] })
})

test('NetSim: latency, ordering of the reliable channel, loss, kill', () => {
  const sim = new NetSim(3, { seed: 1, rttMs: 100, jitterMs: 30, loss: 0.5 })
  const t0 = sim.transport(0)
  const t1 = sim.transport(1)
  for (let i = 0; i < 50; i++) t0.send(1, 'reliable', new Uint8Array([i]))
  let fast = 0
  for (let i = 0; i < 200; i++) t0.send(1, 'fast', new Uint8Array([1]))
  sim.advance(10)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  t1.drain(out)
  assert.equal(out.length, 0, 'nothing may arrive before the latency elapsed')
  sim.advance(200)
  t1.drain(out)
  const rel = out.filter((e) => e.ch === 'reliable').map((e) => e.data[0])
  fast = out.filter((e) => e.ch === 'fast').length
  assert.deepEqual(rel, [...Array(50).keys()], 'reliable must be lossless and ordered')
  assert.ok(fast > 50 && fast < 150, `loss rate off: ${fast}/200 fast packets arrived`)
  sim.kill(1)
  assert.equal(t0.closed(1), true)
  assert.equal(t0.closed(2), false)
})

test('CorrectionSmoother: offset = captured - new, decays, snaps beyond the limit', () => {
  const pos = new Float64Array([0, 0, 100, 100])
  const view: SimView = { entities: 2, stride: 2, read: (o) => o.set(pos) }
  const sm = new CorrectionSmoother(2, 2, 10, 6)
  sm.capture(view)
  pos[0] = -3; pos[2] = 50
  sm.settle(view)
  const out = new Float64Array(4)
  sm.apply(out)
  assert.equal(out[0], 3)
  assert.equal(out[2], 0, 'entity moved further than the snap distance: not smoothed')
  sm.decay(0.1)
  out.fill(0); sm.apply(out)
  assert.ok(Math.abs(out[0] - 3 * Math.exp(-1)) < 1e-9)
})
