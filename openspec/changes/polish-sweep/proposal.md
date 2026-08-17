# Polish sweep (wave 11): #316, #65, #89, #92, #75, #223

## Why

Wave 11 of the delivery order is the polish sweep: six open follow-up issues, most filed several waves ago. The codebase has moved through nine waves since; each issue was re-verified against live code before speccing. Two resolve with no code (close with evidence), four have small real remainders. None of this blocks a review; all of it makes the product's answers more honest or its ceilings actually hold. #85 (the full design/usability pass) is the separate closing milestone and is NOT this change.

## Per-issue verdicts

### #316 — one per-review turn ceiling · REAL

Still live. The canvas flow computes the hypothesis on its own default budget (`apps/desktop/src/main/index.ts:629` calling `computeReviewHypothesis`, whose default budget is created at `index.ts:838-840`), while the flagged flow builds a separate `sharedBudget` (`index.ts:1044`) and computes the hypothesis again (`index.ts:1116`). One review = two hypothesis spends on two independent ceilings. Fix: a turn-aware intelligence session in MAIN — the hypothesis is computed once and ONE required `InvocationBudget` is shared by the hypothesis, Decisions, canvas, flagged, verification, refinement, and narration paths. The first canvas/flagged dispatch pair shares a session; re-entering either flow at the same review and patchset starts a fresh turn, so retries and Quick↔Dual toggles cannot inherit depleted spend or a stale hypothesis. The renderer sends the explicit mode to both routes, eliminating first-caller ceiling ambiguity and the canvas hardcoded-deep default. No promoted spec constrains these budgets (no `intelligence` requirement exists in `openspec/specs/`), so this is implementation + tests, no spec delta.

### #65 — bound primer B2/B3 · REAL

Still live. `assemblePrimer` (`packages/core/src/orchestrator-primer.ts:298-323`) maps `freshness` and `canvasState` one line per repo/canvas with no cap; the only backstop is the fail-closed throw at the 4 KiB ceiling. Fix: deterministic caps with exact rollup tails (`… +N more repos — X current / Y not current`, with stale/updating/failed all truthfully not current; `… +N more canvases — E elements, D/P dispositioned, U unread`) so the exact 10-repo / 20-canvas fixture assembles at or below 4,096 bytes without throwing. Input order cannot change the text, bytes, digest, or tail counts, and rolled-up rows stay reachable via the tool surface. The `orchestrator-session` spec says "one line per repo" — spec delta required.

### #89 — harness follows the model · REAL

Still live. `resolveAssignment` (`packages/core/src/model-council.ts:546` and `:560`) lets a tier/task override pin `harness` independently of `model`, producing the reproduced incoherent pair, and `trace.summary` records the incoherent harness. Per the issue's Rule Zero amendment, option (b) is struck; we take (c)+(a) — pure deletion: remove `harness` from the override type entirely and derive `harness = providerHarness(model)` exactly once after every default, availability-degradation, tier override, and task override has resolved model/effort. Even a contradictory degraded harness default therefore cannot escape as an incoherent pair. No live producer constructs overrides and no test asserts the independent pin (verified in the issue, re-checked at implementation). The `model-council` spec's resolution-order requirement changes — spec delta required.

### #92 — tokenizer classification refinements · REAL (items 1–2), item 3 deliberately not built

The owned tokenizer is still live (`packages/ui/src/syntax/`, `@pierre/diffs` not adopted) and none of the refinements landed: no word-boundary gate on line comments (`highlight.ts:169` matches a marker at any position), `isHexOrSep` (`highlight.ts:53`) shared across all radixes, exponent path without separator handling.

- Item 1 (per-grammar `#` word boundary, shell/yaml yes, python no, with diff markers tokenized outside the source grammar) and item 2 (radix-specific digit predicates + separators strictly between digits in radix, decimal, and exponent runs; malformed fails closed to plain): build, red-first.
- Item 3 (JS/TS regex literals): NOT built — the issue's own analysis says a line-local attempt risks MORE mis-highlighting (`/` divide-vs-literal is context-sensitive). Recorded on the issue at close.
- M2 test-comment wording in `code-view.test.tsx`: one-line comment tidy while in the area.

No promoted spec covers highlighting — no spec delta.

### #75 — council calibration read · CLOSE WITH EVIDENCE

Nothing to build. `documentRejected` occurs NOWHERE in `packages/`, `apps/`, or `docs/src` (case-insensitive grep, zero hits): the event this read would aggregate has no producer, the run ledger it would read does not exist, and nothing consumes the table. The issue's own Rule Zero amendment already struck the zero-writes acceptance criterion and blessed free deferral (P3, no consumer). Building the instrument before its signal exists is speculative scaffolding. Close with the grep evidence; reopen when a `dsl.documentRejected` producer ships.

### #223 — live working-tree symbols · CLOSE WITH EVIDENCE (+ one-line honest copy)

The correct scope shipped: `reviewPinnedToHead` (`apps/desktop/src/main/symbol-lookup-live.ts:46`) pins the inspector to the committed review range `base..head`, which the issue itself calls "the right default for review". The remainder — a working-tree snapshot overlay — is snapshot infrastructure the issue ranks P2/P3 with no demand signal; `packages/core/src/snapshot-overlay.ts` is the #143 non-default-base overlay, not this. NOT built (YAGNI). One-line polish while closing: the inspector's no-definition copy (`packages/ui/src/components/symbol-inspector.tsx:153`) names the committed-range scope, so a miss on a symbol that exists only in uncommitted local edits reads as "not in the reviewed range", not "does not exist". Close with the decision recorded.

## What Changes

- Desktop review flows share one required `InvocationBudget` per review turn; same-key re-entry starts fresh, while the paired canvas/flagged dispatches share the budget and hypothesis (#316).
- Primer B2/B3 gain deterministic caps + exact order-independent rollup tails; the acceptance fixture fits ≤ 4,096 bytes instead of throwing (#65).
- Council override type loses its `harness` field; `harness` always derives from the resolved model (#89). **BREAKING** only for the unused override-`harness` pin (no live producer).
- Tokenizer: per-grammar comment word-boundary flag, diff markers outside source tokenization, and radix-correct number scanning with separators only between digits (#92, items 1–2).
- Symbol-inspector miss copy names its committed-range scope (#223).
- Issues #75 and #223 closed with evidence; #92 closed recording item 3 as deliberately not built.
- Docs updated in the same change: delivery-order wave-11 entry; any docsite page describing primer per-repo lines or council override harness.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `orchestrator-session`: the primer requirement's B2/B3 clauses change from "one line per repo" / unbounded per-canvas lines to bounded sections with a deterministic rollup tail, provably ≤ 4 KB for large reviews.
- `model-council`: the resolution-order requirement changes — overrides set `model`/`effort` only; `harness` SHALL derive from the resolved model's provider on every model-resolving path.

## Impact

- `apps/desktop/src/main/{dispatch.ts,index.ts,review-intelligence-session.ts,review-pipeline-input.ts}` (turn lifecycle, shared budget + hypothesis memo), tests beside them.
- `packages/core/src/orchestrator-primer.ts` + test.
- `packages/core/src/model-council.ts` + test.
- `packages/protocol/src/index.ts` and `packages/ui/src/{app.tsx,canvas/load.ts,syntax/highlight.ts,components/code-view.tsx}` plus their tests.
- `docs/src/content/docs/developing/reference/delivery-order.md`; docsite pages made stale by the above.
- No new dependencies. `review.canvases` gains an optional `deepReview` input so both live flows carry the same explicit mode.
