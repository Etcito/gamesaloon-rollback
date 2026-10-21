# Roadmap: from "rollback" to GameSaloon sync models

Status: discussion notes (2026-10-21), nothing decided or built. Written after the question "can GameSaloon also run a tycoon / city builder, and should rollback become a plugin (tycoon, turn-by-turn, RTS, MMO)?".

## Core idea
What varies between games is **who computes the truth**, not the genre.

| Family | Who simulates | Server role | Examples |
|---|---|---|---|
| Client-simulated | the clients | relays inputs, compares state hashes, arbitrates the result | rollback (Royal Fiesta), lockstep RTS, relay (Kekkai today) |
| Server-authoritative | the server | runs the rules, validates every action | turn-by-turn, tycoon / city builder, MMO |

Common to all (already in GameSaloon, stays the core): identity, rooms, matchmaking, ranking, economy, saves, achievements, hooks. The core must not know whether a game uses rollback.

## Decisions to take (proposal, not yet agreed)
1. **Rollback = one sync model among others**, not a feature of the core. It already lives in its own package (`@gamesaloon/rollback`, `@gamesaloon/rollback-rapier`).
2. **A tycoon is not a "tycoon plugin".** It is a server-validated **command log + shared reducer**: the client proposes "build X at (3,4)", the server applies the same rules, checks cost, stores, returns state. Plus **offline progression** computed from server time at reconnection. Saves and economy exist; the server-side rules module is what is missing.
3. **Turn-by-turn is the same primitive**: a turn is a command; a lockstep tick is a batch of commands. Aim at two families (client-simulated, server-authoritative), not four plugins.
4. **MMO is out of scope** for now: world partitioning, interest management and scaling make it a different product.
5. **Do not design the interface before the second real game.** Extract it from what Kekkai and Royal Fiesta really do, then validate it with the tycoon client. Sketch only: a server game module with `onJoin`, `onCommand`, `onTick`, `snapshot`.

## Open questions (change the answer)
- Tycoon: solo with asynchronous social (visit a city, trade, ladder), or several players acting live in one world?
- Anti-cheat needed (paid currency)? If yes, server-side rules are mandatory.
- Does the client exist with its rules in TypeScript? If yes they can run unchanged on the server.

## Next steps (only once the answers are known)
1. Read what GameSaloon already offers a tycoon (`saves`, `economy`, `turn.ts`, `hooks`) and list the gaps.
2. Split the work: server game-module interface (server-authoritative family) vs. keeping the relay/rollback path untouched.
3. Prototype with the real tycoon client; only then generalise.
