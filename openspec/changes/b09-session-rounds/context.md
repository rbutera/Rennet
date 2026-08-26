# Context packet — B09 session-rounds

Read `openspec/BUILD-LOOP.md` first. Plan row: B9.

## Objective

Implement #466: **Session = first-class durable root** (owns harness cursor, threads, claim; review attaches on target-bind, locked once boards exist — new target = new session). Harness = **cursor-resume** (fresh process per turn + SDK `resume`; CLI owns transcript/compaction/prompt-cache — the T3 Code pattern). Rennet owns: serialize turns per harness id, resume-vanished fallback ("context rebuilt", boards stay canonical), re-pass options every turn. Compaction surfaced honestly (compact_boundary row, PostCompact summary, ask-don't-estimate meter). Rework = one-shot workers outside the chat, serialized per document. Anchored threads: content transcript-only, boards hold anchor→thread refs. Staging writes: tool call → event log → projection, one path. Row click mints session AND claims target; re-entry mid-generation reattaches; pipeline starts idempotent per session. Rounds loop state machine (#486/R34): serialize dispatches, run watched live, round record pins asks/commits/generations, rounds ledger data.

## Out of scope

Chat UI (C7), rounds UI (C9), exits composition (B11).

## Blocked by

B3. Interlocks with B8 (pipeline idempotency, warm-session serialization) — same-track ordering handles it.

## Sources

- The decision: https://github.com/rbutera/rennet/issues/466 · post-round: https://github.com/rbutera/rennet/issues/486
- Engine asset §2 core/session + risk 3: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Existing: `packages/core/src/orchestrator-session*`, `packages/adapters/src/orchestrator-turn.ts`, harness ports
- Docs: `docs/developing/concepts/agent-handoff.md`, `harness-adapters.md`

## Verification

- `pnpm check` green. E2E: kill the host mid-generation, restart, reattach — session resumes, no duplicate pipeline start, boards intact; a vanished harness transcript triggers the honest fallback row.

## Completion sigil

`<promise>B09-COMPLETE</promise>`
