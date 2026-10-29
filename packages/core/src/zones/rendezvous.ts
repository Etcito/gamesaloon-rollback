// Weighted rendezvous hashing for domain replicas and seat hosts. Pure.

import { fnv1a32 } from '../snap.ts'

const domainKey = new Uint8Array(3)
const seatKey = new Uint8Array(7)
const seatView = new DataView(seatKey.buffer)

// The >>> 8 keeps the score at 24 bits, so score * weight stays exact as a double.
function domainScore(domainId: number, peer: number): number {
  domainKey[0] = domainId & 0xff
  domainKey[1] = (domainId >>> 8) & 0xff
  domainKey[2] = peer
  return fnv1a32(domainKey) >>> 8
}

/** Writes the candidates with weight > 0 into out, best score first (ties to the lower peer), and returns out. */
export function rendezvousRank(
  domainId: number,
  peers: readonly number[],
  weights: readonly number[],
  out: number[],
): number[] {
  out.length = 0
  for (let i = 0; i < peers.length; i++) if (weights[i] > 0) out.push(i)
  // out holds candidate indices until the final map.
  out.sort((a, b) => {
    const d = domainScore(domainId, peers[b]) * weights[b] - domainScore(domainId, peers[a]) * weights[a]
    return d || peers[a] - peers[b]
  })
  for (let k = 0; k < out.length; k++) out[k] = peers[out[k]]
  return out
}

// Rendezvous keeps the choice stable when one replica leaves: only the seats it hosted move.
export function seatHostFor(seat: number, epoch: number, replicas: readonly number[]): number {
  seatView.setUint16(0, seat, true)
  seatView.setUint32(2, epoch, true)
  let best = -1
  let bestScore = -1
  for (const peer of replicas) {
    seatKey[6] = peer
    const s = fnv1a32(seatKey) >>> 8
    if (s > bestScore || (s === bestScore && peer < best)) {
      best = peer
      bestScore = s
    }
  }
  return best
}
