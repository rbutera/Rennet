# Context packet — B08 lens-pipeline

Read `openspec/BUILD-LOOP.md` first. Plan row: B8. The largest engine change; expect multiple waves inside it.

## Objective

The drafting pipeline (#464 + #493 + #486), in `server/runtime/` over pure `core/board/`:

- **Drafters** = harness sessions in the PR worktree, seeded with the inlined DeltaPacket (B5) + lens prompt from `packages/prompts` + host schema; **structured returns** validated by `DraftBoardSchema` — the host writes board ops on their behalf (whiteboard tools are orchestrator + human only). Round-report drafter runs FIRST on rounds (R58); per-board arrival powers R58 reveal.
- **Validation loop** (#493): 19 lint rules + schema constraints, ZodError-shaped JSON pointers on one retry channel; the drafter gets one repair turn after the initial draft, and passing elements freeze. An element still invalid afterward takes the honest-omission exit (drop element, hunks → `skippedHunks` with reason); unresolved board-level or schema violations become labeled `blemishes[]`, visible and never blocking. Three gates: lint (pre-post-process) → immutability check → composition every-hunk check.
- **Composition**: mechanical in code (coverage assertion, verbatim carry on stable ids, delta stamps) vs authored (orchestrator on the versioned `composition` prompt); curation enters the next generation's packet. Lens boards ARE the reading surface — no sixth board.
- Council job ids: `lens-draft`, `lens-draft-flagged` (dual + `agreement` routing), `lens-draft-noise`, `board-post-process`, `round-report`. Dual-seat merge keeps `finding-reconcile`.
- #493's seven flagged conflicts are pre-resolved — apply them (R17 code-bytes at parse time via derived schema; R20 backtick + patchset-identifier exemption; `review-draft-voice.md` lint coverage; spike drift must not propagate into the schema).

## Out of scope

Client rendering (C5); exits (B11). Measure the warm-session concurrency cost (engine asset risk 3) before trusting the six-seat fan-out — record the measurement in the change.

## Blocked by

B4, B5. B6/B7 outputs consumed if landed; degrade gracefully if not.

## Sources

- Decisions: https://github.com/rbutera/rennet/issues/464 · https://github.com/rbutera/rennet/issues/493 · https://github.com/rbutera/rennet/issues/486 · https://github.com/rbutera/rennet/issues/457
- Rulings thread (R17–R22, R57/R58 batches): https://github.com/rbutera/rennet/issues/458
- Prompts: `packages/prompts/src/prompts/*` (post-B2 name) — verbatim, including the unslop editor pass
- Engine asset §2 core/board + server/runtime + §4 data flow: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Docs: write `docs/developing/concepts/lens-pipeline.md` (planned page exists — make it live)

## Verification

- `pnpm check` green. E2E: a full pipeline run against a real Rennet PR produces five frozen lens boards in the event log with every hunk either covered or in `skippedHunks`; a deliberately-invalid drafter return exercises the retry ladder and lands as a blemish, not a block.

## Completion sigil

`<promise>B08-COMPLETE</promise>`
