import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NetSim } from '../src/netsim.ts'
import { MAX_PEERS } from '../src/timing.ts'

interface Drain {
  peer: number
  ch: 'fast' | 'reliable'
  data: Uint8Array
}

function drain(net: NetSim, peer: number): Drain[] {
  const out: Drain[] = []
  net.transport(peer).drain(out)
  return out
}

function opts(seed = 1, rttMs = 20, jitterMs = 0, loss = 0, reorder = 0) {
  return { seed, rttMs, jitterMs, loss, reorder }
}

test('netsim links: setLink(0, 1, { rttMs: 200 }) only slows 0→1', () => {
  const net = new NetSim(3, opts(1, 20))
  net.setLink(0, 1, { rttMs: 200 })
  net.transport(0).send(1, 'fast', new Uint8Array([1]))
  net.transport(1).send(0, 'fast', new Uint8Array([2]))
  net.advance(9)
  assert.equal(drain(net, 1).length, 0)
  assert.equal(drain(net, 0).length, 0)
  net.advance(1)
  assert.equal(drain(net, 0).length, 1, '1→0 keeps the global 20 ms rtt')
  assert.equal(drain(net, 1).length, 0)
  net.advance(90)
  const got = drain(net, 1)
  assert.equal(got.length, 1)
  assert.equal(net.now(), 100, '0→1 takes 200 / 2 = 100 ms')
})

test('netsim links: setLink(0, 1, { loss: 1 }) drops only 0→1 fast packets', () => {
  const net = new NetSim(2, opts(1, 20))
  net.setLink(0, 1, { loss: 1 })
  for (let i = 0; i < 20; i++) {
    net.transport(0).send(1, 'fast', new Uint8Array([i]))
    net.transport(1).send(0, 'fast', new Uint8Array([i]))
  }
  net.advance(20)
  assert.equal(drain(net, 1).length, 0)
  assert.equal(drain(net, 0).length, 20)
})

test('netsim links: partition blocks across groups both ways, in flight too, and heal restores', () => {
  const net = new NetSim(4, opts(3, 20))
  net.partition([[0, 1], [2, 3]])
  assert.equal(net.transport(0).closed(2), false, 'a partition is silent loss, not a close')

  for (let i = 0; i < 3; i++) net.transport(0).send(1, 'fast', new Uint8Array([i]))
  net.transport(0).send(2, 'fast', new Uint8Array([9]))
  net.transport(2).send(0, 'fast', new Uint8Array([9]))
  net.transport(2).send(0, 'reliable', new Uint8Array([9]))
  net.advance(50)
  assert.equal(drain(net, 1).length, 3, '0→1 is inside one group')
  assert.equal(drain(net, 0).length, 0)
  assert.equal(drain(net, 2).length, 0)

  net.transport(0).send(2, 'fast', new Uint8Array([4]))
  net.advance(50)
  assert.equal(drain(net, 2).length, 0, 'a partitioned send is dropped before any draw')

  net.heal()
  net.transport(0).send(2, 'fast', new Uint8Array([5]))
  net.transport(2).send(0, 'reliable', new Uint8Array([6]))
  net.advance(50)
  assert.equal(drain(net, 2).length, 1)
  assert.equal(drain(net, 0).length, 1)
})

test('netsim links: packets in flight when partitioned are released undelivered', () => {
  const net = new NetSim(4, opts(4, 20))
  net.transport(0).send(2, 'fast', new Uint8Array([1]))
  net.transport(0).send(2, 'reliable', new Uint8Array([2]))
  net.transport(2).send(0, 'fast', new Uint8Array([3]))
  net.transport(0).send(1, 'fast', new Uint8Array([4]))
  net.partition([[0, 1], [2, 3]])
  net.advance(100)
  assert.equal(drain(net, 2).length, 0)
  assert.equal(drain(net, 0).length, 0)
  assert.equal(drain(net, 1).length, 1, '0→1 was never split')
})

test('netsim links: 200 reliable packets 0→1 arrive in send order across rtt changes', () => {
  const net = new NetSim(2, opts(5, 20, 50, 0.5))
  const a = net.transport(0)
  for (let i = 0; i < 200; i++) {
    net.setLink(0, 1, { rttMs: (i % 2) * 300 + 10 })
    a.send(1, 'reliable', new Uint8Array([i]))
    if (i % 7 === 0) net.advance(3)
  }
  net.advance(1000)
  const out = drain(net, 1)
  assert.equal(out.length, 200, 'the reliable channel never loses')
  assert.deepEqual(out.map((e) => e.data[0]), [...Array(200).keys()])
})

test('netsim: 64 peers work, peer 63 reaches 0, above MAX_PEERS throws', () => {
  const net = new NetSim(MAX_PEERS, opts(2, 20))
  net.transport(MAX_PEERS - 1).send(0, 'reliable', new Uint8Array([7]))
  net.advance(100)
  const got = drain(net, 0)
  assert.equal(got.length, 1)
  assert.equal(got[0].peer, MAX_PEERS - 1)
  assert.throws(() => new NetSim(MAX_PEERS + 1, opts()), /\[netsim\] peers must be 1\.\.MAX_PEERS/)
  assert.throws(() => new NetSim(0, opts()), /\[netsim\] peers must be 1\.\.MAX_PEERS/)
})

test('netsim links: an override on an unused pair leaves the Rng stream untouched', () => {
  const base = opts(9, 40, 12, 0.2, 0.1)
  const run = (override: boolean) => {
    const net = new NetSim(8, base)
    if (override) net.setLink(5, 6, { rttMs: 900, jitterMs: 40, loss: 0.9, reorder: 0.5 })
    const log: { t: number; ch: string; data: number[] }[] = []
    const collect = () => {
      for (const e of drain(net, 1)) log.push({ t: net.now(), ch: e.ch, data: [...e.data] })
    }
    for (let i = 0; i < 500; i++) {
      net.transport(0).send(1, 'fast', new Uint8Array([i & 0xff, i >>> 8]))
      if (i % 25 === 0) {
        net.advance(5)
        collect()
      }
    }
    net.advance(1000)
    collect()
    return log
  }
  const plain = run(false)
  assert.ok(plain.length > 200, `loss ate too much: ${plain.length}/500`)
  assert.deepEqual(run(true), plain)
})
