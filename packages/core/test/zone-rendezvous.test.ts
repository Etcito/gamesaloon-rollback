import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rendezvousRank, seatHostFor } from '../src/zones/rendezvous.ts'
import { fnv1a32 } from '../src/snap.ts'

// The contract formula, written out here independently of the implementation.
function contractScore(domainId: number, peer: number, weight: number): number {
  const key = Uint8Array.of(domainId & 0xff, (domainId >>> 8) & 0xff, peer)
  return (fnv1a32(key) >>> 8) * weight
}

function rank(domainId: number, peers: number[], weights: number[]): number[] {
  return rendezvousRank(domainId, peers, weights, [])
}

const D = 0x0102
// Reference FNV-1a of the key bytes of (domain 0x0102, peer 3) and (domain 0x0102, peer 4).
const H3 = 0xa57be89d
const H4 = 0x9e7bdd98
const S3 = H3 >>> 8
const S4 = H4 >>> 8

test('rendezvous: the domain score is fnv1a32 of (u16 domain LE, u8 peer) >>> 8, times the weight', () => {
  assert.equal(fnv1a32(Uint8Array.of(0x02, 0x01, 0x03)), H3)
  assert.equal(fnv1a32(Uint8Array.of(0x02, 0x01, 0x04)), H4)
  assert.equal(contractScore(D, 3, 1), S3)
  assert.equal(contractScore(D, 4, 1), S4)
  // Equal products tie, so the lower peer id comes first whatever the input order.
  assert.deepEqual(rank(D, [4, 3], [S3, S4]), [3, 4])
  assert.deepEqual(rank(D, [3, 4], [S4, S3]), [3, 4])
  // One unit less on peer 3 breaks the tie in peer 4's favour.
  assert.deepEqual(rank(D, [4, 3], [S3, S4 - 1]), [4, 3])
})

test('rendezvous: order is score descending, ties to the lower peer', () => {
  const peers = Array.from({ length: 64 }, (_, i) => i)
  const weights = peers.map((p) => 1 + ((p * 5) % 11))
  const expected = [...peers].sort((a, b) => {
    const d = contractScore(D, b, weights[b]) - contractScore(D, a, weights[a])
    return d || a - b
  })
  assert.deepEqual(rank(D, peers, weights), expected)
})

test('rendezvous: zero-weight peers are excluded', () => {
  const got = rank(D, [1, 2, 3, 4], [1, 0, 2, 0])
  assert.equal(got.length, 2)
  assert.deepEqual([...got].sort((a, b) => a - b), [1, 3])
  assert.deepEqual(rank(D, [1, 2], [0, 0]), [])
})

test('rendezvous: out is reused and returned, truncated to the ranked candidates', () => {
  const out = [9, 9, 9, 9]
  const got = rendezvousRank(D, [5, 6], [1, 1], out)
  assert.equal(got, out)
  assert.equal(out.length, 2)
  assert.deepEqual(out, rank(D, [5, 6], [1, 1]))
})

const DOMAINS = Array.from({ length: 200 }, (_, i) => i + 1)
const PEERS = Array.from({ length: 64 }, (_, i) => i)
const WEIGHTS = PEERS.map((p) => 1 + ((p * 7) % 13))
const R = 3

function topR(order: number[]): number[] {
  return order.slice(0, R).sort((a, b) => a - b)
}

test('rendezvous: removing a peer keeps the others in order and moves the top R only where it was', () => {
  let inTop = 0
  for (const d of DOMAINS) {
    const full = rank(d, PEERS, WEIGHTS)
    for (const p of PEERS) {
      const rest = PEERS.filter((x) => x !== p)
      const without = rank(d, rest, rest.map((x) => WEIGHTS[x]))
      assert.deepEqual(without, full.filter((x) => x !== p), `domain ${d} minus peer ${p}`)
      if (topR(full).includes(p)) inTop++
      else assert.deepEqual(topR(without), topR(full), `domain ${d} minus peer ${p}`)
    }
  }
  assert.ok(inTop > 0)
})

test('rendezvous: adding a peer moves the top R only into domains where it enters', () => {
  let entered = 0
  for (const d of DOMAINS) {
    const full = rank(d, PEERS, WEIGHTS)
    for (const q of PEERS) {
      const rest = PEERS.filter((x) => x !== q)
      const before = rank(d, rest, rest.map((x) => WEIGHTS[x]))
      if (topR(full).includes(q)) entered++
      else assert.deepEqual(topR(before), topR(full), `domain ${d} plus peer ${q}`)
    }
  }
  assert.ok(entered > 0)
})

test('seatHostFor: deterministic, a member of the list, -1 on empty', () => {
  const replicas = [3, 7, 11, 40, 63]
  const hosts = new Set<number>()
  for (let seat = 0; seat < 200; seat++) {
    const h = seatHostFor(seat, 5, replicas)
    assert.equal(seatHostFor(seat, 5, replicas), h)
    assert.ok(replicas.includes(h))
    hosts.add(h)
  }
  assert.ok(hosts.size > 1)
  assert.equal(seatHostFor(0, 0, []), -1)
})

test('seatHostFor: a seat changes host only when its host leaves', () => {
  const replicas = [1, 4, 9, 16, 25, 36, 49, 63]
  for (let seat = 0; seat < 200; seat++) {
    for (const epoch of [0, 3]) {
      const host = seatHostFor(seat, epoch, replicas)
      for (const p of replicas) {
        const rest = replicas.filter((x) => x !== p)
        const next = seatHostFor(seat, epoch, rest)
        if (p !== host) {
          assert.equal(next, host, `seat ${seat} epoch ${epoch} minus ${p}`)
        } else {
          assert.notEqual(next, host, `seat ${seat} epoch ${epoch} minus host ${p}`)
          assert.ok(rest.includes(next))
        }
      }
    }
  }
})
