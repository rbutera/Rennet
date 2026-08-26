# Context packet — B4 boards-runtime

Read `openspec/BUILD-LOOP.md` first. Plan row: B4.

## Objective

The board store: embed `@whiteboard/server` in-process in `server/boards/`, persist the append-only event log under `.rennet/` (local, never staged), broadcast projections. Promote `server/projection.ts` (KEEP as-is) to also wrap board events and projections before broadcast — board data carries absolute paths; this is the privacy seam. Add `adapters/whiteboard-client.ts`: the five whiteboard tools, **the only writer of board ops**. Rennet does not write its own event-log engine (engine asset §3).

## Out of scope

The lens pipeline that fills boards (B8); client rendering (C5).

## Blocked by

B3, and **Track A5 (npm alpha)** — this is the cross-track gate. Verify `@whiteboard/server` ships embeddable-in-process with pluggable persistence (the A3 SPEC requirement); if it doesn't, STOP and escalate to the master orchestrator rather than writing a local event log.

## Sources

- Element/event-log model, append-then-freeze, topology A: https://github.com/rbutera/rennet/issues/457
- Statelessness/dedup (op-ids, get_events): https://github.com/rbutera/rennet/issues/453 · tools: https://github.com/rbutera/rennet/issues/455
- Engine asset §2 server + risk 1: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Privacy: `packages/server/src/projection.ts` + `docs/developing/concepts/architecture-contracts.md`

## Verification

- `pnpm check` green. E2E: a scripted sequence (create canvas with the Rennet host schema → apply ops → read events → project) round-trips through the embedded server and survives a process restart with the same `.rennet/` log.
- Positive control: a projection containing an absolute path must be caught by the privacy-wrap test.

## Completion sigil

`<promise>B04-COMPLETE</promise>`
