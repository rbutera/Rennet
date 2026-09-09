## Why

The Flagged lens runs two seats — `flagged-claude` and `flagged-codex` — that both draft into ONE shared board concurrently (`runFlaggedDual`, `packages/server/src/runtime/lens-pipeline.ts:3206`, `Promise.all` at :3293), and a post-pass folds their agreement by code location (`reconcileFlaggedVoices`, :684). Dogfooding the lens on PR #927 surfaced a header reading "Proposal fidelity" with no prose under it, only code-block excerpts. The transcript and the persisted board log say exactly what happened, and it indicts the architecture, not one bad turn.

The Codex seat authored a SECOND top-level `section` ("Proposal fidelity") and hung three bare `code_ref` elements directly under it before its findings. A `section` element carries only a title and children — it structurally cannot hold prose — and the Flagged prompt (`packages/prompts/src/prompts/flagged.md`) tells each seat to create ONE top-level section and attach FINDINGS to it, with code refs living INSIDE a finding's `code` field. So the header was a section the model invented, and the code blocks under it were citations orphaned from any finding. The board log confirms the shape: `ge5` "Proposal fidelity" (author `lens:flagged:codex`) with children `[ge6, ge7, ge8, ge9, fe4]` where `ge6/7/8` are bare `code_ref`s, and `fe4` is a finding the OTHER seat's "Findings" section (`fe1`) already owns.

Three failures stacked into one bad header:

1. **Two seats each hold free authority over board STRUCTURE.** Nothing stops a seat from minting a second top-level section or hanging bare citations off it. One did.
2. **The two seats race into one board.** `fe4` ends up a child of two sections; the seats never see each other's structure.
3. **There is no guard that suppresses a Flagged section left with no finding.** Orphan `code_ref`s render as standalone code with a heading and no explanation.

The mechanical location-match reconciliation has its own silent defect the same run shows: two models describing the same bug at slightly different lines never match, so they persist as two separate solos instead of one concurred finding.

Rai's ruling, 2026-09-08: fix the immediate defect fast, then rework the lens so structure has a single disciplined author. The action Rai asked for — "tell them not to run the gate, Rennet runs it for them" — is kept as a scope-and-cost instruction but NOT as a claim that the branch is green: Rennet does not run the reviewed repo's gate (it reviews the diff and reads the forge's already-computed CI as non-gating telemetry — `attachCiSignal`, `create-server.ts:2567`; `fetchCiStatus`, `packages/adapters/src/github-forge.ts:260`), and telling a review seat "assume the branch is fine" would suppress the exact class of findings the lens exists to catch.

## What Changes

This lands in two moves. Move one ships alone, first, because it stops the bleeding at near-zero cost and is correct regardless of the rework.

**Move one — the orphan-section guard (fast, standalone).**

- **The Flagged prompt forbids the shape that caused #927.** `flagged.md` states: exactly ONE top-level section; never attach a `code_ref` — or anything but a finding — directly to a section; code refs live inside a finding's `code` field. It also drops any language that could read as "assume the branch passes," and adds one line that running the repo's build/test/lint gate is out of scope (CI owns pass/fail and Rennet already reads it) — phrased as scope and cost, never as a claim the code is correct.
- **A Flagged section with no finding is suppressed, and bare `code_ref` children never render as standalone blocks.** On the Flagged lens, a direct `code_ref` child of a section is orphaned evidence and is not rendered; a top-level Flagged section whose surviving children hold no finding is dropped from the board. Both are defense in depth that outlive the rework.

**Move two — review-then-compile pipeline (the rework).**

- **BREAKING: the two Flagged seats stop drafting the board. They review and write findings to a file.** Each seat (`flagged-claude`, `flagged-codex`) runs its investigation and writes a structured markdown findings file under the project's `.rennet/` folder — one finding per section in the same shape the `concern` string already mandates (claim ≤10 words, blank line, body, `**Fix:**`, explicit `path:line` refs, a severity tag). The seat gets no board tools and no structural authority. This is where the #927 authoring error becomes impossible: a seat that must fill a body field cannot emit a bare header, and a seat with no `add_section` verb cannot mint a rogue section.
- **A third compiler agent — the orchestrator/composition class — reads both files and writes the whole Flagged board in one `write_board` call.** It reuses the existing composition-seat machinery (`composeReviewDraft`, `composeContextFiles`, `renderComposePrompt`, `lens-pipeline.ts:933`) that already writes per-input files and hands an orchestrator agent their paths. The compiler ASSEMBLES; it does not rewrite. Finding prose travels verbatim from the review files into `concern`. The compiler dedupes by semantic match, ranks by severity, and produces a flat ranked list of findings under a single heading — no thematic sections, which removes the element kind #927 abused.
- **Concurrence and origin are the compiler's judgment, stamped per finding.** "Both models raised this" (concur), "they conflict" (split), and "only one raised it" (solo) are decided by the compiler reading two finished findings, which is a better signal than location-matching. Each finding keeps its origin model as author. The concurrence/accord logic currently in `reconcileFlaggedVoices` moves into the compiler and location-matching retires.
- **The review seats do not run the repo gate.** The scope-and-cost instruction from move one carries into the review-seat prompt.

Move two is scoped to the Flagged lens but shaped to reuse the general composition-seat mechanism, so it is the wedge that mechanism was built for rather than a parallel one. It adds one orchestrator-class turn per Flagged run; that recurring cost is the trade and is called out here because a diff cannot show it.

## Capabilities

### New Capabilities

- `flagged-review-compile`: the Flagged lens's two seats review and write structured findings files under `.rennet/`; a compiler agent of the orchestrator class reads both files and writes the whole Flagged board in one `write_board` call, assembling — not rewriting — findings into a flat ranked list, stamping concurrence and origin as its own judgment; review seats hold no board tools and do not run the reviewed repo's gate.

### Modified Capabilities

- The Flagged prompt and the Flagged section renderer gain the move-one guards (single top-level section, no bare `code_ref` section children, no finding-less Flagged section) as defense in depth beneath the rework.
