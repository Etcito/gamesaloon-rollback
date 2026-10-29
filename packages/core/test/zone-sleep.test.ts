import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapWriter } from '../src/snap.ts'
import type { NetChannel } from '../src/types.ts'
import { packControl } from '../src/zones/control.ts'
import { ZoneSession } from '../src/zones/session.ts'
import { ZONE_DEFAULTS } from '../src/zones/tuning.ts'
import type { GroupTransport } from '../src/zones/types.ts'
import { decodeZone, ZMSG, ZoneWireWriter } from '../src/zones/wire.ts'
import { ZonePointFactory, zonePointCodec } from './zones/zonePointSim.ts'

type Packet = { peer: number; ch: NetChannel; data: Uint8Array }

function setup() {
  const incoming: Packet[] = [], sent: Packet[] = [], batches: number[][] = []
  const transport: GroupTransport = {
    now: () => 0,
    closed: () => false,
    drain: (out) => { out.length = 0; out.push(...incoming); incoming.length = 0 },
    send: (peer, ch, data) => { sent.push({ peer, ch, data: data.slice() }) },
    sendMany: (peers, ch, data) => {
      batches.push([...peers])
      for (const peer of peers) transport.send(peer, ch, data)
    },
  }
  const factory = new ZonePointFactory({
    seatCount: 1, gridCols: 256, gridRows: 1, cellSize: 10000, fieldPerCell: 0,
    windEvery: 100, windMag: 0, radius: 10, stopBelow: 1, sleepTicks: 1,
    shadowMargin: 1, goalY: 10000, maxGhosts: 4, maxEvents: 4, eventKinds: 1,
  })
  const controls = new Uint32Array([packControl({ cell: 0, cpuClass: 0, bwClass: 0, latClass: 0, spareSlots: 1 })])
  const transitions: { asleep: boolean; pose: Uint8Array }[] = []
  const session = new ZoneSession({
    localPeer: 0, roster: { seatCount: 1, peers: [
      { peer: 0, seats: [0] }, { peer: 1, seats: [] }, { peer: 2, seats: [] },
    ], live: [true, true, false] },
    tuning: { ...ZONE_DEFAULTS, replicas: 1 },
    factory: {
      create: (spec, tick) => {
        const sim = factory.create(spec, tick)
        // This pose fixture has no match ledger consuming predicted event shadows.
        if (spec.kind === 'global') sim.step = () => { sim.tick++ }
        return sim
      },
      rebuild: (spec, tick, sources) => factory.rebuild(spec, tick, sources),
      reset: (spec, tick) => factory.reset(spec, tick),
    }, codec: zonePointCodec, controls,
    minDelay: 0, initialDelay: 0,
    farSink: { far: () => {}, sleep: (_d, _id, _t, asleep, pose) => { transitions.push({ asleep, pose: pose.slice() }) } },
  }, transport)
  return { session, incoming, sent, batches, transitions, controls }
}

test('zone SLEEP retains received poses, dedupes transitions and clears only on a newer WAKE', () => {
  const { session, incoming, transitions } = setup()
  const w = new ZoneWireWriter(), domain = 900, id = 42
  const before = session.domain(1)!.sim.hash()
  const deliver = (data: Uint8Array) => {
    incoming.push({ peer: 1, ch: 'reliable', data })
    session.frame(0, () => {})
  }
  const first = w.sleep(1, domain, id, 1, new Uint8Array([1, 2, 3])).slice()
  deliver(first)
  first.fill(0)
  const held = session.sleepPoseOf(domain, id)!
  assert.deepEqual([...held], [1, 2, 3])
  deliver(w.sleep(1, domain, id, 1, new Uint8Array([9])))
  deliver(w.wake(1, domain, id, 0))
  assert.equal(transitions.length, 1)
  assert.equal(session.sleepPoseOf(domain, id), held)
  deliver(w.wake(1, domain, id, 2))
  assert.equal(session.sleepPoseOf(domain, id), null)
  assert.equal(transitions[1].pose.length, 0)
  deliver(w.sleep(1, domain, id, 3, new Uint8Array([4, 5, 6])))
  assert.equal(session.sleepPoseOf(domain, id), held)
  assert.deepEqual([...held], [4, 5, 6])
  deliver(w.wake(1, domain, id, 4))
  deliver(w.sleep(1, domain, id, 5, new Uint8Array(0)))
  assert.equal(session.sleepPoseOf(domain, id)!.length, 0)
  deliver(w.wake(1, domain, id, 6))
  deliver(w.sleep(1, domain, id, 7, new Uint8Array([7, 8, 9, 10])))
  assert.deepEqual([...session.sleepPoseOf(domain, id)!], [7, 8, 9, 10])
  assert.equal(session.domain(1)!.sim.hash(), before)
  assert.equal(session.stats.malformed, 0)
  assert.equal(session.stats.sleepTransitions, transitions.length)
  session.dispose()
  assert.equal(session.sleepPoseOf(domain, id), null)
})

test('zone producer sends the confirmed snapshot-form SLEEP pose once to live non-replicas', () => {
  const { session, sent, batches, controls } = setup()
  const sample = (_inputs: unknown, out: Uint32Array) => out.set(controls)
  session.frame(1 / 60, sample)
  const sleeps = sent.filter((p) => p.data[0] === ZMSG.SLEEP)
  assert.equal(sleeps.length, 1)
  assert.equal(sleeps[0].peer, 1)
  assert.equal(sleeps[0].ch, 'reliable')
  assert.ok(batches.some((peers) => peers.length === 1 && peers[0] === 1))
  const m = decodeZone(sleeps[0].data)
  assert.ok(m?.type === ZMSG.SLEEP)
  const pose = new SnapWriter()
  assert.equal(session.domain(m.domain)!.sim.sleepPose(m.id, pose), true)
  assert.deepEqual(m.pose, pose.bytes())
  assert.equal(m.pose.length, 8)
  session.frame(1 / 60, sample)
  assert.equal(sent.filter((p) => p.data[0] === ZMSG.SLEEP).length, 1)
  session.dispose()
})
