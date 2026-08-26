# Context packet — B11 exits-backend

Read `openspec/BUILD-LOOP.md` first. Plan row: B11. Last engine wave.

## Objective

The three exits' engine side (R29–R36 on #458, #486):

- **Asks are durable host-side per session** (decided, Q15): staged asks, line comments, quote threads, retired/detached ledgers, verdict override survive reload; receipt-is-undo everywhere. One write path: tool call → event log → projection.
- `core/exits/`: round work-order composition (asks → one dispatch, serialized), PR body draft, GitHub two-strata review composition (verdict proposed-not-derived, first-class approving review), publish submission shape.
- Idempotent push + open-PR; PR lane ripening across rounds; living-draft rework as one-shot workers (B9's queue) with quote-match carry.
- Nothing posts without Rai clicking post — draft/preview/post language; pushing a branch is not publishing.

## Out of scope

All UI (C8/C9). The round-report drafter (B8 owns it).

## Blocked by

B8, B9, B10.

## Sources

- Hand-off design session + rulings R29–R36: https://github.com/rbutera/rennet/issues/458 (2026-08-25 comments) · post-round: https://github.com/rbutera/rennet/issues/486
- Client asset risk 5 (asks durability rationale): https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Existing: `packages/core/src/handoff*`, `own-branch-submission`, GitHub review composition in `adapters`
- Docs: write `docs/developing/concepts/handoff-and-exits.md` (planned page exists — make it live)

## Verification

- `pnpm check` green. E2E: stage asks → kill host → restart → asks intact; dispatch a round work-order twice → exactly one dispatch; compose + preview a GitHub review draft for a real PR without posting.

## Completion sigil

`<promise>B11-COMPLETE</promise>`
