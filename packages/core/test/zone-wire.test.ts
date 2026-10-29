import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZMSG, ZoneWireWriter, decodeZone } from '../src/zones/wire.ts'
import { decode } from '../src/wire.ts'

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
    if (type >= ZMSG.CONTROL && type <= ZMSG.ZDESYNC) continue
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
