# Rollback by zones

`@gamesaloon/rollback/zones` splits a match into domains. Each peer simulates only the domains near its seats, with
its own rollback per domain. `RollbackSession` stays the full-mesh mode and is unchanged. The general architecture is
in [`DESIGN.md`](DESIGN.md).

## Vocabulary

- **seat:** one player, id u16.
- **peer:** one machine with 1–4 seats (up to 8 on the wire), id u8 below `MAX_PEERS` = 64.
- **cell:** a level grid square, id u16 = `row*cols+col`. `0xFFFF` (`CONTROL_NO_CELL`) means no cell (observer).
- **domain:** one simulation island. A seat domain holds seats, a field domain holds an untouched interactive area,
  and the global domain (id 0) holds match-wide results.
- **replica set:** the peers simulating a domain. The first one is the producer.
- **shadow:** a link carrying one domain's confirmed boundary entities as inputs into another domain.
- **far stream:** display-only poses of entities outside the local peer's domains.
- **epoch E:** the ticks `[E*K, (E+1)*K)`. **Lead L:** assignment for epoch E reads control words at tick `E*K-L`.

## Control word

One u32 per playing seat per tick, written by the owning peer and carried in CONTROL. `packControl` and
`unpackControl` are the only encoders. Bits, LSB first:

| Bits | Field | Notes |
|---|---|---|
| 0–15 | cell | `0xFFFF` = none |
| 16–19 | cpuClass | same for every seat of a peer |
| 20–23 | bwClass | |
| 24–27 | latClass | |
| 28–31 | spareSlots | extra domains the peer may host |

Classes come from measurements through the tuning threshold tables (`classOf`).

## assign

`assign(roster, controls, prev, tuning)` is pure and runs identically on every peer:

1. Near graph over seats: an edge enters at Chebyshev cell distance ≤ `rEnter` and stays while ≤ `rExit`.
2. Union-find components, rooted at the lowest seat id.
3. A seat younger than `minResidenceEpochs` in its domain stays with its previous component, unless its peer is
   not live.
4. A component larger than the capacity of its best R peers is split in ascending (cell, seat) order. Adjacent
   chunks become shadow links in both directions.
5. Domain ids: global = 0, seat domain = 1 + lowest seat, field domain = 1 + seatCount + cell. Ascending id order
   is canonical.
6. Replicas: the owners of member seats, then weighted rendezvous up to `replicas` (or `untouchedReplicas`). The
   producer is the top-scored replica. Every live peer replicates the global domain.
7. Seat host: the owning peer if live, else `seatHostFor` over the live replicas, which drives a bot.

## Wire

Byte 0 is the type, byte 1 the sender peer. Little-endian, ticks i32, domain ids u16. Legacy `MSG` 1..8 is unchanged.
`decodeZone` never throws and returns reused objects.

| Type | Name | Layout | Channel, audience |
|---|---|---|---|
| 16 | CONTROL | firstTick, count u8, seats u8, seat u16[], words u32[] | unreliable, all live peers |
| 17 | ZINPUT | domain, ackTick, firstTick, count u8, seats u8, seat u16[], codes, senderTick, nChecks u8, (domain u16, tick, hash)[] | unreliable, replicas |
| 18 | DOMAIN_SNAPSHOT | domain, tick, part u16, parts u16, total u32, fnv u32, bytes (chunked at `SNAPSHOT_CHUNK`) | reliable, new replica or observer |
| 19 | FAR | domain, tick, stride u8, n u16, entries | unreliable, live non-replicas |
| 20 | SHADOW | fromDomain, toDomain, firstTick, count u8, (u16 length + bytes)[] | unreliable, target replicas |
| 21 | SLEEP | domain, id u32, tick, pose (rest of the frame) | reliable, live non-replicas |
| 22 | WAKE | domain, id u32, tick | reliable, live non-replicas |
| 23 | ZDROP | domain, lostPeer u8, lastTick | reliable, replicas |
| 24 | ZDESYNC | domain, tick, hash | reliable, replicas |

SLEEP carries the body's quantized pose: the pose fields of that entity's record in `snapshot()`, at the transition
tick. The producer takes it from `SleepEvent.pose`, which equals the bytes `DomainSim.sleepPose(id, w)` writes for
that entity, so it is a pure function of the simulation. WAKE has no pose.

## Epoch

At S = E*K, as part of the step to tick S (and replayed on rollback):

1. `assign` runs on the confirmed controls at `S-L`.
2. Domains with unchanged specs continue.
3. A merged or split domain is rebuilt locally only by a peer replicating all its sources. Otherwise the
   lowest-ranked replica holding all sources sends DOMAIN_SNAPSHOT at S.
4. Old replicas keep the source domains until `S + handoffGraceTicks`.

Each domain keeps an InputBuffer per member seat and per inbound shadow, a frontier (min over those), a snapshot
ring and a hash ring. It stalls at `frontier + maxPrediction`, independently of other domains.

Empty shadow rule: until the first SHADOW of a link is received, `ShadowView.reader(i)` returns a zero-length
reader for that link, meaning nothing from it this tick. `DomainSim.step` must skip that link without reading
it (no ghosts, no events). Every replica sees the same empty payload, and if the confirmed one differs, a
rollback follows.

## Handoff and recovery

- **Checks:** confirmed hashes travel as (domain, tick, hash) inside ZINPUT and are compared among replicas. On
  disagreement the domain kind's `costClass` decides: `tiebreak` (producer wins, losers snap through
  `CorrectionSmoother`), `checkpoint` (roll back to the last agreed keyframe and take the producer's
  DOMAIN_SNAPSHOT) or `reset` (`factory.reset` at the next epoch boundary).
- **Drop:** a silent peer is lost after the core lost timeout. Replicas of each affected domain exchange ZDROP with
  the last tick of its seats; S = max. From S+1 `seatHost(seat, botHost, true)` applies, and the bot host drives the
  seat after `botTakeoverMs` without news. Bot inputs (`botInput`) travel as normal ZINPUT. `onPeerLost(peer, tick)`
  reports it.
- **Rejoin:** a returning peer is an observer (its control words carry `CONTROL_NO_CELL`), receives DOMAIN_SNAPSHOT
  for its assigned domains, and its seats switch back at the next epoch boundary with `seatHost(seat, peer, false)`.
  The `observer` config flag starts a late rejoin that way.
- **SLEEP and WAKE:** only the producer sends them, from `sleepEvents(out)` of confirmed steps, never during
  resimulation. It sends exactly one reliable SLEEP (with `ev.pose`) and one reliable WAKE per confirmed transition,
  to the live peers outside the replica set (the FAR audience), with `sendMany` when available.
- **Receiving SLEEP:** any pose length is accepted, including 0, and nothing throws. The pose is copied into a
  per-domain sleep table (reused storage that grows only for larger poses), readable with
  `ZoneSession.sleepPoseOf(domain, id)` until the next message, and handed to the optional
  `FarSink.sleep?(domain, id, tick, asleep, pose)`. WAKE clears the entry and passes a zero-length pose. A display
  shows a sleeper at that pose until WAKE, because a sleeping body leaves the FAR stream.
- **SLEEP and WAKE never change replica state:** replicas simulate sleep deterministically, and the hash's sleep
  digest covers it. Awake poses come from FAR or DOMAIN_SNAPSHOT.
- **FAR** is display only: it goes to `config.farSink` and never enters a step.

## Tuning

Every number is a `ZoneTuning` field; `ZONE_DEFAULTS` holds the defaults and `validateZoneTuning` refuses invalid
sets. All peers use identical tuning; `tuningHash` goes into the room payload.

| Field | Default | Meaning |
|---|---|---|
| `epochTicks` (K) | 60 | ticks per epoch |
| `leadTicks` (L) | 30 | must exceed maxPrediction + maxDelay |
| `rEnter` / `rExit` | 1 / 2 | near-graph enter and exit cell distances, `rExit ≥ rEnter` |
| `minResidenceEpochs` | 2 | epochs before a seat may change domain |
| `replicas` / `untouchedReplicas` | 2 / 2 | replicas per domain |
| `capacityByCpuClass` | [2,4,8,12,16,24,32,48,64,…] | seat-equivalents per spare slot, by class |
| `cpuThresholdsMs`, `bwThresholdsKbps`, `latThresholdsMs` | — | measurement to class tables |
| `handoffGraceTicks` | 30 | how long old replicas keep a domain |
| `farStrides` | ≤2 cells: 2, ≤6: 6, else 15 | FAR stride by cell distance (`farStride`) |
| `costClass` | seat/field: checkpoint, global: reset | disagreement response |
| `botTakeoverMs` | 150 | silence before the bot host drives |
| `snapshotRing` | 40 | snapshot ring per domain |
| `keyframeEvery` | 1 | epochs between agreed keyframes |
