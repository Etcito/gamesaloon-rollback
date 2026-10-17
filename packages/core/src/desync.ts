// Desync handling helpers: the agreed authority for a mismatched tick, the readable debug dump and a pure base64
// encoder for snapshot bytes. Pure.
export interface DesyncDump {
  tick: number
  localHash: number
  remote: { peer: number; hash: number }[]
  snapshotB64: string | null
  /** Used input codes of the last ticks, one per player (in the order of `players`). */
  inputs: { tick: number; codes: number[] }[]
  /** Player index of each column of `inputs[].codes`. */
  players: number[]
  /** Whatever RollbackConfig.dumpInfo returned (or null). */
  info: unknown
}

interface HashGroup {
  hash: number
  /** Index of the group's first appearance in the input (total-order tiebreak). */
  first: number
  peers: number[]
}

/**
 * The majority hash, the tie-break by the group holding the lowest peer, and the lowest peer of the winning group.
 * losers are the peers of every other group, ascending. Every peer computes the same result from the same hashes.
 */
export function chooseAuthority(hashes: { peer: number; hash: number }[]): { hash: number; authority: number; losers: number[] } {
  const groups: HashGroup[] = []
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i].hash >>> 0
    let g: HashGroup | undefined
    for (let j = 0; j < groups.length; j++) {
      if (groups[j].hash === h) {
        g = groups[j]
        break
      }
    }
    if (!g) {
      g = { hash: h, first: i, peers: [] }
      groups.push(g)
    }
    g.peers.push(hashes[i].peer)
  }
  if (groups.length === 0) return { hash: 0, authority: -1, losers: [] }
  const byPeer = (a: number, b: number): number => a - b
  for (const g of groups) g.peers.sort(byPeer)
  groups.sort((a, b) => b.peers.length - a.peers.length || a.peers[0] - b.peers[0] || a.first - b.first)
  const win = groups[0]
  const losers: number[] = []
  for (let j = 1; j < groups.length; j++) for (const p of groups[j].peers) losers.push(p)
  losers.sort(byPeer)
  return { hash: win.hash, authority: win.peers[0], losers }
}

/** 8 lowercase hex digits of a u32. */
export function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 (with '=' padding) of the bytes, without btoa or Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let line = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    line += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
    if (line.length >= 4096) {
      parts.push(line)
      line = ''
    }
  }
  const rest = n - i
  if (rest === 1) {
    const v = bytes[i] << 16
    line += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + '=='
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    line += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='
  }
  parts.push(line)
  return parts.join('')
}

/** A readable multi-line text of the dump. */
export function dumpToText(d: DesyncDump): string {
  const out: string[] = []
  out.push('DESYNC DUMP')
  out.push('tick: ' + d.tick)
  out.push('local hash: ' + hex8(d.localHash))
  out.push('remote hashes:')
  if (d.remote.length === 0) out.push('  (none)')
  for (const r of d.remote) out.push('  peer ' + r.peer + ': ' + hex8(r.hash) + (r.hash >>> 0 === d.localHash >>> 0 ? '' : ' (differs)'))
  out.push('inputs (' + d.inputs.length + ' ticks, codes per player in hex):')
  for (const line of d.inputs) {
    const codes: string[] = []
    for (const c of line.codes) codes.push(hex8(c))
    out.push('  ' + line.tick + ': ' + codes.join(' '))
  }
  out.push('snapshot (base64):')
  out.push(d.snapshotB64 === null ? '  (none)' : d.snapshotB64)
  out.push('players: ' + d.players.join(' '))
  out.push('info (JSON):')
  out.push(JSON.stringify(d.info === undefined ? null : d.info, null, 2))
  return out.join('\n') + '\n'
}
