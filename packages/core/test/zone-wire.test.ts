import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZMSG, ZoneWireWriter, decodeZone } from '../src/zones/wire.ts'
import { MAX_WIRE_TICKS, decode } from '../src/wire.ts'
import { fnv1a32 } from '../src/snap.ts'

test('zone message types occupy 16 through 24', () => {
  assert.deepEqual(ZMSG, {
    CONTROL: 16,
    ZINPUT: 17,
    DOMAIN_SNAPSHOT: 18,
    FAR: 19,
    SHADOW: 20,
    SLEEP: 21,
    WAKE: 22,
    ZDROP: 23,
    ZDESYNC: 24,
  })
})

test('legacy decode rejects every zone message type', () => {
  for (const type of Object.values(ZMSG)) {
    const frame = new Uint8Array(12)
    frame[0] = type
    assert.equal(decode(frame), null)
  }
})

const writer = new ZoneWireWriter()

for (const pose of [new Uint8Array(0), new Uint8Array([0, 128, 255])]) {
  test(`SLEEP round trip with ${pose.length} pose bytes`, () => {
    const frame = writer.sleep(63, 0xabcd, 0xfedcba98, -123, pose)
    assert.deepEqual([...frame.subarray(0, 12)], [21, 63, 205, 171, 152, 186, 220, 254, 133, 255, 255, 255])
    const msg = decodeZone(frame)
    assert.deepEqual(msg, { type: ZMSG.SLEEP, from: 63, domain: 0xabcd, id: 0xfedcba98, tick: -123, pose })
    assert.ok(msg?.type === ZMSG.SLEEP)
    assert.equal(msg.pose.buffer, frame.buffer)
    assert.equal(msg.pose.byteOffset, frame.byteOffset + 12)
    if (pose.length) {
      pose[0] = 42
      assert.equal(msg.pose[0], 0)
      frame[12] = 7
      assert.equal(msg.pose[0], 7)
    }
  })
}

test('fixed messages round trip with peer 63 and little-endian signed ticks', () => {
  const wake = writer.wake(63, 0xabcd, 0xffffffff, -2147483648)
  assert.deepEqual([...wake], [22, 63, 205, 171, 255, 255, 255, 255, 0, 0, 0, 128])
  assert.deepEqual(decodeZone(wake), { type: ZMSG.WAKE, from: 63, domain: 0xabcd, id: 0xffffffff, tick: -2147483648 })
  const drop = writer.drop(63, 65535, 62, -1)
  assert.deepEqual([...drop], [23, 63, 255, 255, 62, 255, 255, 255, 255])
  assert.deepEqual(decodeZone(drop), { type: ZMSG.ZDROP, from: 63, domain: 65535, lostPeer: 62, lastTick: -1 })
  const desync = writer.desync(63, 0xabcd, 2147483647, 0xdeadbeef)
  assert.deepEqual([...desync], [24, 63, 205, 171, 255, 255, 255, 127, 239, 190, 173, 222])
  assert.deepEqual(decodeZone(desync), { type: ZMSG.ZDESYNC, from: 63, domain: 0xabcd, tick: 2147483647, hash: 0xdeadbeef })
})

test('every fixed header truncation returns null; fixed messages ignore trailing bytes', () => {
  const frames = [
    writer.sleep(63, 1, 2, -1, new Uint8Array(0)).slice(),
    writer.wake(63, 1, 2, -1).slice(),
    writer.drop(63, 1, 62, -1).slice(),
    writer.desync(63, 1, -1, 0xffffffff).slice(),
  ]
  for (const frame of frames) {
    for (let cut = 0; cut < frame.length; cut++) {
      assert.equal(decodeZone(frame.subarray(0, cut)), null, `type ${frame[0]}, cut ${cut}`)
    }
    if (frame[0] === ZMSG.SLEEP) continue
    const expected = { ...decodeZone(frame) }
    const extended = new Uint8Array(frame.length + 3)
    extended.set(frame)
    extended.fill(255, frame.length)
    assert.deepEqual(decodeZone(extended), expected)
  }
})

test('SLEEP uses every remaining byte, including shortened and extended poses', () => {
  const frame = writer.sleep(63, 42, 123, -1, new Uint8Array([1, 2, 3])).slice()
  const extended = new Uint8Array(frame.length + 2)
  extended.set(frame)
  extended.set([4, 5], frame.length)
  for (let len = 12; len <= extended.length; len++) {
    // A nonzero byte offset must not affect field or pose reads.
    const padded = new Uint8Array(len + 7)
    padded.set(extended.subarray(0, len), 7)
    const input = padded.subarray(7)
    const msg = decodeZone(input)
    assert.ok(msg?.type === ZMSG.SLEEP)
    assert.deepEqual(msg, { type: ZMSG.SLEEP, from: 63, domain: 42, id: 123, tick: -1, pose: extended.subarray(12, len) })
    assert.equal(msg.pose.buffer, input.buffer)
    assert.equal(msg.pose.byteOffset, input.byteOffset + 12)
  }
})

test('garbage and unknown types return null without throwing', () => {
  for (let type = 0; type <= 255; type++) {
    const short = new Uint8Array([type, 63, 255])
    assert.equal(decodeZone(short), null)
    if (type >= ZMSG.CONTROL && type <= ZMSG.ZDESYNC) {
      // Every zone message is fuzzed: random bodies may decode or not, but never throw.
      let seed = type * 2654435761
      for (let i = 0; i < 500; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0
        const frame = new Uint8Array(seed % 300)
        for (let j = 0; j < frame.length; j++) {
          seed = (seed * 1103515245 + 12345) >>> 0
          frame[j] = seed >>> 24
        }
        if (frame.length > 0) frame[0] = type
        assert.doesNotThrow(() => decodeZone(frame))
      }
      continue
    }
    const garbage = new Uint8Array(32).fill(255)
    garbage[0] = type
    assert.equal(decodeZone(garbage), null)
  }
  assert.equal(decodeZone(new Uint8Array(0)), null)
})

test('writer reuses one growable buffer and cached views; decoder reuses each message', () => {
  const w = new ZoneWireWriter()
  const first = w.wake(1, 2, 3, 4)
  assert.equal(w.desync(1, 2, 3, 4), first)
  assert.equal(w.drop(1, 2, 3, 4).buffer, first.buffer)
  const pose = new Uint8Array(1000).fill(123)
  const grown = w.sleep(63, 2, 3, 4, pose)
  assert.notEqual(grown.buffer, first.buffer)
  assert.equal(w.sleep(63, 2, 3, 4, pose), grown)
  assert.deepEqual(grown.subarray(12), pose)
  assert.equal(w.wake(1, 2, 3, 4).buffer, grown.buffer)
  for (const encode of [
    () => w.sleep(63, 2, 3, 4, pose),
    () => w.wake(63, 2, 3, 4),
    () => w.drop(63, 2, 3, 4),
    () => w.desync(63, 2, 3, 4),
  ]) {
    const msg = decodeZone(encode())
    assert.ok(msg)
    const frame = encode()
    frame[1] = 62
    assert.equal(decodeZone(frame), msg)
    assert.equal(msg.from, 62)
  }
})

const zcontrol = (count: number, seats: number) => ({
  type: ZMSG.CONTROL, from: 63, firstTick: 1000, count, seats,
  seatIds: Uint16Array.from([0, 7, 0x1234, 0xfffe]).subarray(0, seats),
  words: Uint32Array.from({ length: count * seats }, (_, i) => (0xf0000000 + i * 0x01010101) >>> 0),
})

test('CONTROL round-trips 4 seats x 3 ticks from peer 63', () => {
  const src = zcontrol(3, 4)
  const m = decodeZone(new ZoneWireWriter().control(src))
  assert.ok(m && m.type === ZMSG.CONTROL)
  assert.equal(m.from, 63)
  assert.equal(m.firstTick, 1000)
  assert.equal(m.count, 3)
  assert.equal(m.seats, 4)
  assert.deepEqual([...m.seatIds], [0, 7, 0x1234, 0xfffe])
  assert.deepEqual([...m.words], [...src.words])
})

test('ZINPUT round-trips 2 seats x 5 ticks with ackTick -1 and three checks', () => {
  const checks = [{ domain: 0, tick: 10, hash: 0xdeadbeef }, { domain: 5, tick: -1, hash: 1 }, { domain: 0xfffe, tick: 99, hash: 0xffffffff }]
  const codes = Uint32Array.from({ length: 10 }, (_, i) => i * 0x11111111 >>> 0)
  const m = decodeZone(new ZoneWireWriter().zinput({
    type: ZMSG.ZINPUT, from: 63, domain: 300, ackTick: -1, firstTick: 42, count: 5, seats: 2,
    seatIds: Uint16Array.from([3, 0xfffe]), codes, senderTick: 47, checks,
  }))
  assert.ok(m && m.type === ZMSG.ZINPUT)
  assert.equal(m.from, 63)
  assert.equal(m.domain, 300)
  assert.equal(m.ackTick, -1)
  assert.equal(m.firstTick, 42)
  assert.equal(m.count, 5)
  assert.equal(m.seats, 2)
  assert.deepEqual([...m.seatIds], [3, 0xfffe])
  assert.deepEqual([...m.codes], [...codes])
  assert.equal(m.senderTick, 47)
  assert.deepEqual(m.checks.map((c) => ({ ...c })), checks)
})

test('count 200 is clamped to MAX_WIRE_TICKS', () => {
  const m = decodeZone(new ZoneWireWriter().control(zcontrol(200, 1)))
  assert.ok(m && m.type === ZMSG.CONTROL)
  assert.equal(m.count, MAX_WIRE_TICKS)
  assert.equal(m.words.length, MAX_WIRE_TICKS)
})

test('CONTROL and ZINPUT reject every truncation and one extra byte', () => {
  const w = new ZoneWireWriter()
  const frames = [
    w.control(zcontrol(3, 4)).slice(),
    w.zinput({
      type: ZMSG.ZINPUT, from: 1, domain: 2, ackTick: 0, firstTick: 0, count: 2, seats: 2,
      seatIds: Uint16Array.from([1, 2]), codes: new Uint32Array(4), senderTick: 0, checks: [{ domain: 1, tick: 2, hash: 3 }],
    }).slice(),
  ]
  for (const f of frames) {
    assert.ok(decodeZone(f))
    for (let cut = 0; cut < f.length; cut++) assert.equal(decodeZone(f.subarray(0, cut)), null, `cut ${cut}`)
    const longer = new Uint8Array(f.length + 1)
    longer.set(f)
    assert.equal(decodeZone(longer), null)
  }
})

test('seats = 9 in a hand-built frame is rejected', () => {
  const c = new Uint8Array(8 + 9 * 2 + 9 * 4)
  c[0] = ZMSG.CONTROL
  c[6] = 1
  c[7] = 9
  assert.equal(decodeZone(c), null)
  const z = new Uint8Array(14 + 9 * 2 + 9 * 4 + 5)
  z[0] = ZMSG.ZINPUT
  z[12] = 1
  z[13] = 9
  assert.equal(decodeZone(z), null)
})

test('DOMAIN_SNAPSHOT chunks at SNAPSHOT_CHUNK and round-trips', () => {
  const w = new ZoneWireWriter()
  const bytes = new Uint8Array(40000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff
  const parts = w.domainSnapshotParts(63, 700, -5, bytes)
  assert.equal(parts.length, 3)
  const joined: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const m = decodeZone(parts[i])
    assert.ok(m && m.type === ZMSG.DOMAIN_SNAPSHOT)
    assert.equal(m.from, 63)
    assert.equal(m.domain, 700)
    assert.equal(m.tick, -5)
    assert.equal(m.part, i)
    assert.equal(m.parts, 3)
    assert.equal(m.totalLen, 40000)
    assert.equal(m.hash, fnv1a32(bytes))
    joined.push(...m.bytes)
  }
  assert.deepEqual(Uint8Array.from(joined), bytes)
  for (let cut = 0; cut < 20; cut++) assert.equal(decodeZone(parts[2].subarray(0, cut)), null)
  const empty = w.domainSnapshotParts(63, 1, 0, new Uint8Array(0))
  assert.equal(empty.length, 1)
  const m = decodeZone(empty[0])
  assert.ok(m && m.type === ZMSG.DOMAIN_SNAPSHOT)
  assert.equal(m.bytes.length, 0)
  assert.equal(m.parts, 1)
})

test('FAR round-trips and truncated prefixes give null', () => {
  const w = new ZoneWireWriter()
  const entries = new Uint8Array(24).map((_, i) => i + 1)
  const frame = w.far(63, 0xfffe, 1234, 15, 3, entries).slice()
  const m = decodeZone(frame)
  assert.ok(m && m.type === ZMSG.FAR)
  assert.deepEqual({ ...m, entries: [...m.entries] }, { type: ZMSG.FAR, from: 63, domain: 0xfffe, tick: 1234, stride: 15, n: 3, entries: [...entries] })
  for (let cut = 0; cut < 11; cut++) assert.equal(decodeZone(frame.subarray(0, cut)), null)
})

test('SHADOW round-trips, rejects overruns, leftovers and oversize payloads', () => {
  const w = new ZoneWireWriter()
  const payloads = [new Uint8Array(0), new Uint8Array(5).fill(7), new Uint8Array(300).map((_, i) => i & 0xff)]
  const frame = w.shadow(63, 3, 9, -2, payloads)!.slice()
  const m = decodeZone(frame)
  assert.ok(m && m.type === ZMSG.SHADOW)
  assert.equal(m.from, 63)
  assert.equal(m.fromDomain, 3)
  assert.equal(m.toDomain, 9)
  assert.equal(m.firstTick, -2)
  assert.equal(m.count, 3)
  assert.deepEqual(m.payloads.map(p => [...p]), payloads.map(p => [...p]))
  for (let cut = 0; cut < frame.length; cut++) assert.equal(decodeZone(frame.subarray(0, cut)), null, `cut ${cut}`)
  const extra = new Uint8Array(frame.length + 1)
  extra.set(frame)
  assert.equal(decodeZone(extra), null)
  const over = frame.slice()
  over[12] = 0xff // first length prefix now overruns
  assert.equal(decodeZone(over), null)
  assert.equal(w.shadow(1, 1, 2, 0, [new Uint8Array(0x10000)]), null)
})
