# ARCHITECTURE

This document describes zoned rollback netcode for very large matches across three repositories:

- **clone-bf2be11c7567** holds `@gamesaloon/rollback` (packages `core` and `rapier`).
- **royal-fiesta** is the game.
- **gamesaloon-relay** is the relay server.

The numbered sections are the shared contract and are decided once. Each module section states what that module owns.

## 1. Vocabulary
- **seat:** one player. Seat ids are u16.
- **peer:** one machine with 1–4 seats (up to 8 on the wire). Peer ids are u8, below `MAX_PEERS` = 64 (`packages/core/src/timing.ts`).
- **cell:** a level grid square. Cell id = u16 `row*cols+col`. `0xFFFF` means no cell (observer).
- **domain:** one PointSim island or one Rapier World.
  - A seat domain holds seats.
  - A field domain holds an untouched interactive area.
  - The global domain holds match-wide results.
- **replica set:** the peers that simulate a domain. The first one is the producer.
- **shadow:** a link that carries one domain's confirmed boundary entities as inputs into another domain.
- **far stream:** display-only poses of entities outside the local peer's domains.
- **epoch E:** the ticks `[E*K, (E+1)*K)`.
- **lead L:** the assignment for epoch E reads control words at tick `E*K-L`.

## 2. ZoneTuning (`packages/core/src/zones/tuning.ts`)
Every value is configuration. `ZONE_DEFAULTS` holds the defaults, and `validateZoneTuning` refuses invalid sets. Every peer in a match uses the same tuning, and its fnv1a32 (`tuningHash`) is part of the room payload.

| Field | Default | Meaning |
|---|---|---|
| `epochTicks` (K) | 60 | Ticks per epoch |
| `leadTicks` (L) | 30 | Must be greater than maxPrediction + maxDelay |
| `rEnter` | 1 | Chebyshev cell distance at which seats join the near graph |
| `rExit` | 2 | Distance at which they leave it. Must be ≥ `rEnter` |
| `minResidenceEpochs` | 2 | Epochs before a seat may change domain |
| `replicas` (R) | 2 | Minimum replicas per domain |
| `untouchedReplicas` | 2 | Replicas for an untouched domain. May be 1 |
| `capacityByCpuClass` | [2,4,8,12,16,24,32,48,64,…] | Seat-equivalents per spare slot, indexed by class |
| `cpuThresholdsMs`, `bwThresholdsKbps`, `latThresholdsMs` | — | Ascending tables that map measurements to classes 0..15 |
| `handoffGraceTicks` | 30 | How long old replicas keep a domain after a handoff |
| `farStrides` | [{maxCells:2,stride:2},{maxCells:6,stride:6},{maxCells:65535,stride:15}] | Far-stream stride by cell distance |
| `costClass` | {seat:'checkpoint', field:'checkpoint', global:'reset'} | How each domain kind responds to a disagreement (§6) |
| `botTakeoverMs` | 150 | Per-game value |
| `snapshotRing` | 40 | Snapshot ring size per domain |
| `keyframeEvery` | 1 epoch | How often an agreed keyframe is taken |

## 3. Control seat word (`zones/control.ts`)
Each playing seat has one u32 per tick. The owning peer writes it, and CONTROL carries it. Bits, LSB first:

| Bits | Field | Notes |
|---|---|---|
| 0–15 | cell | `0xFFFF` = none |
| 16–19 | cpuClass | |
| 20–23 | bwClass | |
| 24–27 | latClass | |
| 28–31 | spareSlots | Extra domains the peer may host |

- The class fields are the same for every seat of one peer.
- `packControl` and `unpackControl` are the only encoders.
- Classes come from measurements through the tuning tables (`classOf`). No thresholds are hard-coded.

## 4. assign (`zones/assign.ts`, pure)
`assign(roster, controls, prev, tuning) -> Assignment` takes:
- `roster` = `{ seatCount, peers: {peer, seats[]}[], live: boolean[] }`;
- `controls` = `{ epoch, words: Uint32Array(seatCount) }`, sampled at the confirmed tick `epoch*K-L`;
- `prev` = `Assignment | null`.

It runs these steps:
1. **Near graph** over seats. An edge enters when the cell distance is ≤ `rEnter`. An existing edge (from `prev`) stays while the distance is ≤ `rExit`.
2. **Union-find components.** The root is the lowest seat id.
3. **Minimum residence.** A seat that has been in its domain for fewer than `minResidenceEpochs` stays with its previous domain's component, unless its peer is not live.
4. **Capacity split.** A component with more seats than the capacity of its best R peers is split into chunks in ascending (cell, seat) order. Chunks that were adjacent become shadow links in both directions.
5. **Domain ids.**
   - The global domain is 0.
   - A seat domain is 1 + its lowest seat id.
   - A field domain is 1 + seatCount + cellId.
   - Ascending id order is canonical everywhere.
6. **Replicas.**
   - Peers that own member seats always replicate.
   - The remaining replicas, up to R (or `untouchedReplicas`), are chosen by weighted rendezvous. `score = (fnv1a32(u16 domainId, u8 peer) >>> 8) * weight`, where `weight = capacityByCpuClass[cpuClass] * spareSlots`.
   - Candidates are ordered by score descending, with ties going to the lower peer. A peer with zero weight is only taken when it owns a member seat.
   - The producer is the top-scored replica.
   - Every live peer replicates the global domain.
7. **Seat host.** `seatHost[seat]` is the owning peer when it is live. Otherwise it is chosen by rendezvous over (seat, epoch) among the live replicas of the seat's domain, and that peer drives a bot.

Types:
- `Assignment` = `{ epoch, domains: DomainSpec[], shadows: ShadowLink[], seatDomain: Int32Array, seatHost: Int16Array, residence: Uint16Array }`.
- `DomainSpec` = `{ id, kind: 'seat'|'field'|'global', cells: number[], seats: number[], replicas: number[] }`.
- `ShadowLink` = `{ from, to }`.

Every domain also emits events (finish, eliminate, fall) over an implicit shadow link to the global domain.

## 5. Domain simulation interface (`zones/types.ts`)
`DomainSim<TInput>` has these members:
- `tick`.
- `step(inputs: readonly TInput[] /* spec.seats order */, shadows: ShadowView)`.
- `snapshot(w: SnapWriter)` and `restore(r: SnapReader)`.
- `hash()`: fnv1a32 over the awake-entity block, followed by the u32 sleep digest. The sleep digest is fnv1a32 over ascending (id u32, sleepTick i32).
- `exportEntities(w)`, in ascending id order.
- `shadowOut(w, to)`, `events(w)` and `far(w, stride)`.
- `seatHost(seat, peer, bot: boolean)`.
- `sleepEvents(out)` and `sleepPose(id, w): boolean`.
- Optional `beginResim`, `endResim` and `view`.

`DomainFactory<TInput>` has these members:
- `create(spec, tick)`.
- `rebuild(spec, tick, sources: SnapReader[])`. Each source is the `exportEntities` output of one source domain, merged in ascending entity id.
- `reset(spec, tick)`: a deterministic reset from the spec.

Rules:
- **Ids.** Entity and joint ids are stable u32 values and are never reused. Non-interactive moving parts are kinematic by tick and are not part of the entity export.
- **SleepEvent** = `{ id, tick, asleep, pose: Uint8Array }`.
  - When `asleep=true`, `pose` is the body's quantized pose at the transition tick. Its bytes are the pose fields of that entity's `snapshot()` record, and they equal what `sleepPose` writes at that tick.
  - For WAKE, `pose` is zero-length.
  - The domain owns `pose` and preallocates it, so `sleepEvents` allocates nothing. It stays valid until the next `step` or `restore`.
- **`sleepPose(id, w)`** returns false when the domain does not hold the entity.
- **Empty shadow rule.** `ShadowView.reader(i)` may return a zero-length reader. That means the link has had no payload yet, and every replica sees the same thing. `step` must skip that link without reading or throwing. If the confirmed payload later differs, a rollback follows.
- **`GroupTransport extends NetTransport`** with an optional `sendMany(peers, ch, data)`. ZoneSession uses it when it is present.

## 6. ZoneSession rules (`zones/session.ts`)
**Per-domain state:**
- one InputBuffer per member seat, plus one per inbound shadow link;
- a frontier, which is the minimum over those inputs;
- a snapshot ring and a hash ring;
- its own rollback.

A domain stalls at `frontier + maxPrediction`. Hot paths allocate nothing.

**Epoch boundary S = E*K.** This is applied as part of the step to tick S and is replayed on rollback:
1. Compute `assign` from the confirmed controls at `S-L`.
2. Domains whose specs did not change continue.
3. A merged or split domain is rebuilt locally only by a peer that replicates all of its sources. Every other new replica receives DOMAIN_SNAPSHOT at S from the lowest-ranked replica that holds all the sources.
4. Old replicas keep the source domains until `S + handoffGraceTicks`.

**Hash checks.** Confirmed hashes are piggybacked per domain as (domain, tick, hash) and compared among replicas. On a disagreement, the domain's `costClass` decides the response:
- `tiebreak`: the producer wins, and the losers snap to its snapshot through `CorrectionSmoother`.
- `checkpoint`: roll back to the last agreed keyframe and take the producer's DOMAIN_SNAPSHOT.
- `reset`: call `factory.reset` at the next epoch boundary.

**Drop.**
- Replicas agree on the drop per domain. They exchange the last tick of the lost peer's seats, and S = max.
- ZDROP applies to every DomainState with that domain id, current or grace, so an agreement that spans a boundary still completes.
- From S+1 the session calls `seatHost(seat, botHost, true)`. The bot host drives the seat once `botTakeoverMs` passes without news. Bot inputs travel as normal inputs.

**Rejoin.**
- A returning peer comes back as an observer. Each current or grace state that this peer produces sends it the newest ring snapshot at or below confirmed, as DOMAIN_SNAPSHOT.
- The observer accepts the snapshot from the producer of the snapshot tick's epoch. It computes that producer with `assign` from its CONTROL samples. Until it has those samples, it accepts the lowest-id live replica it has heard from.
- It adopts that epoch's assignment and switches to seated play at the next boundary R = `rejoinAt[owner]`.
- While the owner is still observing, it does not count as driving its seat. Seat ticks below R are bot-driven by the planned host (`hostAt`). From R onward the owner's own inputs drive the seat.

**Resend after silence.**
- CONTROL and SHADOW are reliable, but frames can still be lost silently (for example under `NetSim.partition`).
- After more than max(4 ticks, 100 ms) of silence from a peer, its next frame rewinds that peer's resend cursors. They go to its last reported confirmed tick + 1, or to the oldest retained tick when that is unknown.
- CONTROL and the producer's SHADOW payloads are then resent to it, reliably and in order. Receivers store them idempotently.

**Heal after split-brain.**
- A peer may hear from a peer it had marked lost whose id is lower than the lowest id in its own live set. It then resigns: it becomes an observer and resyncs through the rejoin path.
- The side holding the lowest peer id keeps its state.
- Rejoin and partition/heal end with zero per-domain hash mismatches and no permanent stall.

**SLEEP and WAKE.**
- Only the producer sends them, taken from `sleepEvents` of confirmed steps and never during resimulation. It sends exactly one reliable message per transition (SLEEP with `ev.pose`, WAKE with an empty pose).
- They go to the live peers that do not replicate the domain, using `sendMany` when available.
- Receivers accept a pose of any length, including 0, and never throw. They copy the pose into a per-domain sleep table with reused storage, and WAKE clears the entry.
- `ZoneSession.sleepPoseOf(domain, id): Uint8Array | null` returns a view that is valid until the next message. The optional `FarSink.sleep?(domain, id, tick, asleep, pose)` is called with a view that is valid during the call.
- SLEEP and WAKE never change replica state. A display shows a sleeper at its SLEEP pose until WAKE.

**Far stream.** The producer sends FAR at `farStride(cellDistance)`. FAR is display only and never enters a step. Awake bodies on display come from FAR or DOMAIN_SNAPSHOT.

## 7. Zone wire (`zones/wire.ts`)
- The frame layout matches the legacy wire: byte 0 is the type and byte 1 is the sender peer (u8).
- Values are little-endian. Ticks are i32 and domain ids are u16.
- Legacy `MSG` types 1..8 are unchanged.
- `ZoneWireWriter` reuses buffers. `decodeZone` never throws and returns reused objects.

| Type | Name | Layout |
|---|---|---|
| 16 | CONTROL | firstTick, count u8, seats u8, seat u16[], words u32[] |
| 17 | ZINPUT | domain, ackTick, firstTick, count u8, seats u8, seat u16[], codes, senderTick, nChecks u8, checks (domain u16, tick, hash)[] |
| 18 | DOMAIN_SNAPSHOT | domain, tick, part u16, parts u16, total u32, fnv u32, bytes. Chunked at `SNAPSHOT_CHUNK` and reassembled with `SnapshotAssembler` semantics |
| 19 | FAR | domain, tick, stride u8, n u16, entries |
| 20 | SHADOW | fromDomain, toDomain, firstTick, count u8, payloads (u16 length + bytes) |
| 21 | SLEEP | domain, id u32, tick, pose (quantized snapshot-form pose, any length) |
| 22 | WAKE | domain, id u32, tick |
| 23 | ZDROP | domain, lostPeer u8, lastTick |
| 24 | ZDESYNC | domain, tick, hash |

## 8. NetSim (`packages/core/src/netsim.ts`)
- `new NetSim(peers ≤ 64, opts)` creates the simulator.
- `setLink(a, b, Partial<NetSimOptions>)` sets the options for one direction.
- `partition(groups: number[][])` splits peers into groups, and `heal()` reconnects them.
- Links without overrides keep the existing Rng draw order (loss, jitter, reorder), so older tests replay identically.

## 9. Relay zone rooms (gamesaloon-relay)
**Rooms and queues.**
- `create` and `queue` accept `game: string` (1..64 characters) and `zones: true`. A zone room needs both.
- Players are capped by `MAX_ZONE_PEERS` = 64 and by the game's entry in env `RELAY_GAMES` (comma list of `game:maxPeers`, for example `royal-fiesta:64`).
- Queues are keyed `${game}|${players}|${cadence}`. The error code `unknown game` exists for games without an entry.

**Binary frames.**
- Only members of a zone room may send them.
- Client → server: byte 0 = `0x5A`, byte 1 = 0, bytes 2..9 = destination mask as u64 LE (bit p = peer p; all zero = every other member), then the payload.
- Server → client: byte 0 = `0x5A`, byte 1 = the sender peer, then the payload.
- Size cap: env `RELAY_MAX_BIN_BYTES`, default 20000 (larger than `SNAPSHOT_CHUNK` plus headers).
- Rate cap: env `RELAY_BIN_RATE_PER_SEC`, default 2000.
- Binary frames are not logged for resume. Rejoin uses DOMAIN_SNAPSHOT instead.

**Server wiring.**
- The transport delivers binary frames to `EndpointSession.binary?(frame: Uint8Array)`. Pending (unclaimed) sockets ignore binary.
- `ClientConn` (declared in `src/hub.ts`) has an optional `sendBinary?(data: Uint8Array)`.
- `RelayHub` takes an optional third constructor argument `{ games?, maxBinBytes?, binRatePerSec? }`. The composition root `src/handshake.ts` passes these values from `Config`.

**Config.**
- `relayGames`, `relayMaxBinBytes` and `relayBinRatePerSec` are optional. `loadConfig` sets each one only when its env var is present, so `loadConfig({})` keeps its old shape.
- The defaults are `DEFAULT_RELAY_MAX_BIN_BYTES` and `DEFAULT_RELAY_BIN_RATE_PER_SEC` in `src/config.ts`.

The royal-fiesta client keeps its own typed copy of this protocol in `packages/game/src/net/zoneRelayProtocol.ts`.

## 10. Zones sidecar (royal-fiesta `courses/<id>.zones.json`)
```
{ "format": "royal-fiesta.zones", "version": 0, "course": "<courseId>",
  "grid": { "origin": [x, z], "cell": [sx, sz], "cols": n, "rows": n },
  "parts": { "<obstacleId>": "kinematic" | "physics" },
  "tuning": { <optional ZoneTuning overrides> } }
```
- Unknown keys are refused with `RefusalError` (`[zones] path: what; fix`).
- `parts` defaults come from the motion kind: seesaw is physics, everything else is kinematic.
- In zone mode, a course without a sidecar is refused. It still plays in full-mesh mode.

## 11. Royal Fiesta zone match
- Seats = peers × local seats (1–4).
- In zone mode, bots are either headless peers (the `apps/headless` zone bot client) or takeover bots. Takeover bots are driven by the bot host with `sim/bots` `evaluateBrain` and follow the course.
- Round results come only from the global domain (`MatchLedger`), which is fed by domain events.
- **FAR content.** When `FiestaDomain.far(w, stride)` is due, it writes `encodeFar` over every seat character the domain holds, in ascending seat order, asleep or awake. Kinematic obstacles, seesaws and other non-seat bodies are never written to FAR.
- **SLEEP poses.** SLEEP keeps Rapier's opaque snapshot-form pose. No Fiesta SLEEP codec or body-to-seat mapping exists.

## Module ownership

| Module | Owner | Repo | Files |
|---|---|---|---|
| zones-contract | 1 | clone-bf2be11c7567 | packages/core/src/zones/types.ts, packages/core/src/zones/tuning.ts, packages/core/test/zone-tuning.test.ts |
| zones-control | 1 | clone-bf2be11c7567 | packages/core/src/zones/control.ts, packages/core/test/zone-control.test.ts |
| zones-assign | 1 | clone-bf2be11c7567 | packages/core/src/zones/assign.ts, packages/core/src/zones/nearGraph.ts, packages/core/src/zones/rendezvous.ts, packages/core/test/zone-assign.test.ts |
| zones-wire | 1 | clone-bf2be11c7567 | packages/core/src/zones/wire.ts, packages/core/src/timing.ts, packages/core/test/zone-wire.test.ts |
| netsim-links | 1 | clone-bf2be11c7567 | packages/core/src/netsim.ts, packages/core/test/netsim-links.test.ts |
| zones-session | 2 | clone-bf2be11c7567 | packages/core/src/zones/session.ts, frontier.ts, domainRing.ts, epoch.ts, recovery.ts, far.ts |
| zones-entry | 2 | clone-bf2be11c7567 | packages/core/src/zones/index.ts, packages/core/package.json, scripts/release-pack.mjs, docs/ZONES.md |
| zoned-pointsim-kit | 2 | clone-bf2be11c7567 | packages/core/test/zones/zonePointSim.ts, packages/core/test/zones/zoneHarness.ts, packages/core/test/zone-session.test.ts, packages/core/test/zone-epoch.test.ts, packages/core/test/zone-recovery.test.ts, packages/core/test/long/zone-scale.long.ts |
| rapier-domain-world | 3 | clone-bf2be11c7567 | packages/rapier/src/domain-world.ts, packages/rapier/src/index.ts, packages/rapier/package.json, packages/rapier/test/domain-world.test.ts, package-lock.json |
| rapier-domain-rebuild | 3 | clone-bf2be11c7567 | packages/rapier/src/domain-rebuild.ts, packages/rapier/test/domain-rebuild.test.ts |
| rapier-domain-sim | 3 | clone-bf2be11c7567 | packages/rapier/src/domain-sim.ts, packages/rapier/test/domain-scenario.ts, packages/rapier/test/domain-zoned.test.ts, packages/rapier/test/domain-zoned.long.ts |
| rf-zones-file | 4 | royal-fiesta | packages/sim/src/zones/zonesFile.ts, packages/sim/src/zones/cells.ts, packages/sim/test/zonesFile.test.ts, courses/race-sprint.zones.json, courses/obstacle-gallery.zones.json |
| rf-domain-sim | 4 | royal-fiesta | packages/sim/src/zones/fiestaDomain.ts, fiestaDomainFactory.ts, ledger.ts, farState.ts, packages/sim/test/fiestaDomain.test.ts |
| rf-zone-match | 4 | royal-fiesta | packages/game/src/net/zoneMatch.ts, zoneTuning.ts, takeoverBot.ts, zoneLoopback.ts, packages/game/test/zoneMatch.test.ts |
| rf-far-render | 4 | royal-fiesta | packages/game/src/net/farFeed.ts, packages/game/src/render/farRender.ts, apps/web/src/zone/zoneView.ts, packages/game/test/farFeed.test.ts |
| relay-binary | 5 | gamesaloon-relay | src/transport.ts, src/hub.ts, src/relay/binary.ts, test/relay.binary.test.ts |
| relay-zone-rooms | 5 | gamesaloon-relay | src/relay/groups.ts, src/relay/gameQueues.ts, src/relay/hub.ts, src/relay/protocol.ts, src/relay/endpoint.ts, src/handshake.ts, src/config.ts, docs/RELAY.md, deploy/TARGET.md, deploy/rooms.env.example, deploy/deploy.ts, test/relay.zones.test.ts |
| rf-zone-relay-client | 6 | royal-fiesta | packages/game/src/net/zoneRelayProtocol.ts, zoneRelayTransport.ts, zoneRelayClient.ts, packages/game/test/zoneRelayTransport.test.ts |
| rf-zone-bots | 6 | royal-fiesta | apps/headless/src/zoneBot.ts, apps/headless/src/zoneLaunch.ts, apps/headless/test/zoneBot.test.ts, apps/web/src/zone/zoneLobby.ts, package.json |
| rf-split-screen | 7 | royal-fiesta | packages/game/src/client/localSeats.ts, packages/game/src/render/splitScreen.ts, apps/web/src/zone/splitView.ts, packages/game/test/localSeats.test.ts |
| rf-zones-courses | 7 | royal-fiesta | courses/race-bean-dash.zones.json, courses/race-hammer-hill.zones.json, courses/hub-plaza.zones.json, courses/podium.zones.json, courses/survival-hammer-ring.zones.json, courses/survival-spin-zone.zones.json, courses/survival-sprint.zones.json, packages/sim/test/zonesCourses.test.ts |

## Module: zones-contract
- Repo: clone-bf2be11c7567. Owner: 1. Consumes: nothing.
- Exports: DomainId, SeatId, DomainKind, DomainSpec, ShadowLink, Assignment, Roster, ControlSample, DomainSim, DomainFactory, ShadowView, SleepEvent, GroupTransport, CostClass, ZoneTuning, ZONE_DEFAULTS, validateZoneTuning, tuningHash.
- Defines the types in §2, §4 and §5, including `SleepEvent.pose` and `DomainSim.sleepPose`.
- `hash()`, the sleep digest and `snapshot()` keep the forms given in §5.

## Module: zones-control
- Repo: clone-bf2be11c7567. Owner: 1. Consumes: zones-contract.
- Exports: packControl, unpackControl, CONTROL_NO_CELL, CONTROL_BITS, classOf, ControlFields.
- Implements §3.

## Module: zones-assign
- Repo: clone-bf2be11c7567. Owner: 1. Consumes: zones-contract, zones-control.
- Exports: assign, nearComponents, splitByCapacity, rendezvousRank, seatHostFor, domainIdOf.
- Implements §4 as pure functions.

## Module: zones-wire
- Repo: clone-bf2be11c7567. Owner: 1. Consumes: zones-contract.
- Exports: ZMSG, ZoneWireWriter, decodeZone, ZoneMessage, ZControlMsg, ZInputMsg, ZDomainSnapshotMsg, ZFarMsg, ZShadowMsg, ZSleepMsg, ZWakeMsg, ZDropMsg, ZDesyncMsg, and MAX_PEERS = 64 (in timing.ts).
- Implements §7.

## Module: netsim-links
- Repo: clone-bf2be11c7567. Owner: 1. Consumes: nothing.
- Exports: NetSim (64 peers, setLink, partition, heal), NetSimOptions, LinkOptions.
- Implements §8.

## Module: zones-session
- Repo: clone-bf2be11c7567. Owner: 2. Consumes: zones-contract, zones-control, zones-assign, zones-wire.
- Exports: ZoneSession, ZoneSessionConfig, ZoneStats, DomainState, farStride, FarSink.
- Implements §6: per-domain rollback, epoch boundaries, handoff, hash checks, drop, rejoin, resend after silence, heal after split-brain, the SLEEP/WAKE sleep table (`sleepPoseOf`, `FarSink.sleep`) and the far stream.
- `ShadowInput` returns one shared empty reader for a link that has no payload yet. `frontier.ts` treats that link like any other input.
- The resend path is off the hot path.

## Module: zones-entry
- Repo: clone-bf2be11c7567. Owner: 2. Consumes: zones-contract, zones-control, zones-assign, zones-wire, zones-session.
- Exports: the `@gamesaloon/rollback/zones` subpath, which re-exports all zones modules.
- `docs/ZONES.md` documents the following:
  - the wire table, including that SLEEP carries the quantized snapshot-form pose;
  - the SLEEP/WAKE delivery and display rules;
  - the empty shadow rule;
  - resending CONTROL and SHADOW from the last confirmed tick after silence, where duplicates are harmless;
  - heal after a partition: the lowest-id side keeps its state, and the other side rejoins as observers through DOMAIN_SNAPSHOT and switches at the next boundary.

## Module: zoned-pointsim-kit
- Repo: clone-bf2be11c7567. Owner: 2. Consumes: zones-entry, netsim-links.
- Exports: ZonePointSim, ZonePointFactory, zonePointCodec, zoneSetup, zoneRun, domainHashMismatches.
- `ZonePointSim.sleepPose` writes x i32 and y i32, the pose fields of its snapshot record. Each preallocated `sleepPool` entry has an 8-byte pose. WAKE uses one shared zero-length buffer.
- `step` and `stepGlobal` skip zero-byte shadow readers before reading the u16 count.
- `zone-session.test.ts` asserts that a peer outside a domain's replica set receives exactly one SLEEP per transition, that `sleepPoseOf` equals the producer's `sleepPose` bytes at the transition tick, and that WAKE clears the entry.
- The long scale run (`test/long/zone-scale.long.ts`) runs only through `.nmc/commands.json`.

## Module: rapier-domain-world
- Repo: clone-bf2be11c7567. Owner: 3. Consumes: zones-entry.
- Exports: RapierDomainWorld, EntityId, JointId, DomainWorldSnapshot, DomainEntityBuilder, DomainJointBuilder.
- `src/index.ts` also re-exports the rapier-domain-rebuild and rapier-domain-sim surfaces, because the package exposes only `.`.
- `proxyIds(source, out)` clears `out` and fills it with the source entity ids of every proxy row for `source`, sorted ascending. It never uses Map insertion order.
- The proxy table is persisted in the snapshot envelope. It is the only record of which proxies exist.

## Module: rapier-domain-rebuild
- Repo: clone-bf2be11c7567. Owner: 3. Consumes: rapier-domain-world.
- Exports: rebuildDomain, exportEntities, mergeEntityStreams, ShadowProxies, kinematicByTick.
- `ShadowProxies` reconciles against the world's proxy table:
  - It reads a non-empty payload from source S (count 0 included).
  - It collects `world.proxyIds(S, scratch)` and then removes every id that is absent from the payload, in ascending order.
  - It keeps no list of seen ids, so a fresh instance on a restored world removes stale proxies.
- A zero-length reader skips the link.
- Tests check that restoring a world with proxies and stepping it with a count-zero payload leaves no proxy for that source, and that the hash and snapshot bytes equal the original world's.

## Module: rapier-domain-sim
- Repo: clone-bf2be11c7567. Owner: 3. Consumes: rapier-domain-world, rapier-domain-rebuild, zones-entry, netsim-links.
- Exports: RapierDomainSim, RapierDomainFactory, RapierDomainHooks.
- `step` skips zero-length shadow readers.
- Recovery paths (checkpoint restore, deterministic reset, DOMAIN_SNAPSHOT handoff) rely on `ShadowProxies` reconciliation and never patch proxies themselves.
- The long zoned run (`domain-zoned.long.ts`, cases merge-split, merge-split-mixed, checkpoint, drop, rejoin, combined) runs only through `.nmc/commands.json`, after `npm run build`.

## Module: rf-zones-file
- Repo: royal-fiesta. Owner: 4. Consumes: zones-entry.
- Exports: ZONES_FORMAT, ZONES_VERSION, ZonesFile, parseZonesFile, loadZonesFile, cellOf, cellDistance, partMode.
- Implements §10 and provides the race-sprint and obstacle-gallery sidecars.

## Module: rf-domain-sim
- Repo: royal-fiesta. Owner: 4. Consumes: rf-zones-file, rapier-domain-sim, rapier-domain-rebuild, zones-entry.
- Exports: FiestaDomain, createFiestaDomainFactory, MatchLedger, FiestaEvent, encodeFar, decodeFar, FarEntity.
- `step` skips zero-length shadow readers.
- FAR and SLEEP follow §11.

## Module: rf-zone-match
- Repo: royal-fiesta. Owner: 4. Consumes: rf-domain-sim, rf-zones-file, zones-entry, netsim-links.
- Exports: createZoneMatch, ZoneMatch, ZoneMatchConfig, FIESTA_ZONE_TUNING, takeoverInput, ZoneLoopback.

## Module: rf-far-render
- Repo: royal-fiesta. Owner: 4. Consumes: rf-zone-match, rf-domain-sim.
- Exports: FarFeed, FarRenderer, mountZoneView.
- `FarFeed` implements `FarSink`:
  - `far()` decodes into a pooled `FarEntity[]` and keeps the last two samples per seat.
  - The display interpolates position linearly and yaw along the shortest arc over the stride. It holds the last sample when nothing newer has arrived and never extrapolates.
  - A seat is dropped after 4 × its last stride ticks with no entry, or when the caller marks it local (NEAR).
  - `sleep()` does nothing, and SLEEP poses are never decoded.
- Display only: nothing `FarFeed` holds ever feeds a step.

## Module: relay-binary
- Repo: gamesaloon-relay. Owner: 5. Consumes: nothing.
- Exports: BIN_KIND, encodeBinOut, decodeBinIn, EndpointSession.binary, ClientConn.sendBinary.
- Covers binary frame encoding and transport delivery (§9).
- Its only change to `src/hub.ts` is adding `sendBinary?` to `ClientConn`.

## Module: relay-zone-rooms
- Repo: gamesaloon-relay. Owner: 5. Consumes: relay-binary.
- Exports: ZoneGroup, routeMask, GameQueues, queueKey, parseGameLimits, Config.relayGames, Config.relayMaxBinBytes, Config.relayBinRatePerSec, DEFAULT_RELAY_MAX_BIN_BYTES, DEFAULT_RELAY_BIN_RATE_PER_SEC, MAX_ZONE_PEERS, RelayHub.binary.
- Covers zone rooms, game queues, routing and the size and rate caps (§9).
- Its only change to `src/handshake.ts` is passing the zone settings from `Config`.
- `test/turn.test.ts` passes unchanged.

## Module: rf-zone-relay-client
- Repo: royal-fiesta. Owner: 6. Consumes: rf-zone-match, zones-entry, relay-binary, relay-zone-rooms.
- Exports: ZONE_BIN_KIND, ZoneQueuePayload, ZoneRelayTransport, ZoneRelayClient.
- Keeps the client's typed copy of the §9 protocol. `ZoneRelayTransport` implements `GroupTransport` over masked binary frames.

## Module: rf-zone-bots
- Repo: royal-fiesta. Owner: 6. Consumes: rf-zone-relay-client, rf-zone-match, rf-far-render.
- Exports: runZoneBot, launchZoneBots, the npm script `zone:bots`, mountZoneLobby.

## Module: rf-split-screen
- Repo: royal-fiesta. Owner: 7. Consumes: rf-zone-match, rf-far-render, rf-zone-bots.
- Exports: LocalSeats, assignPads, SplitScreenLayout, splitRects, mountSplitView.
- Handles 1–4 local seats per peer.

## Module: rf-zones-courses
- Repo: royal-fiesta. Owner: 7. Consumes: rf-zones-file.
- Provides a zones sidecar for every remaining race, survival, hub and podium course, one per course id in `courses/`. `zonesCourses.test.ts` checks that every course has a valid sidecar.

## Milestone proofs
- M1 Zone contract, control word, assign, wire and NetSim links: `npm test -w packages/core`
- M2 Zone session with epochs, recovery and SLEEP poses on ZonePointSim: `node --experimental-strip-types --test packages/core/test/long/zone-scale.long.ts`
- M3 Rapier domain worlds with rebuild, shadows and zoned recovery: `env DOMAIN_LONG_CASE=combined node --experimental-strip-types --test packages/rapier/test/domain-zoned.long.ts`
- M4 Royal Fiesta zoned domains, zone match and far rendering: `node --experimental-strip-types tools/zoneMatchRun.ts`
- M5 Relay binary frames and zone rooms: `node --experimental-strip-types --test test/relay.binary.test.ts test/relay.zones.test.ts`
- M6 Zone relay client and headless zone bots: `node --experimental-strip-types --test packages/game/test/zoneRelayTransport.test.ts apps/headless/test/zoneBot.test.ts`
- M7 Split-screen local seats and zone sidecars for every course: `env NMC_GPU_WAIT_S=600 node --experimental-strip-types tools/splitGate.ts`
