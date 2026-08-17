# Tasks — polish sweep

Red-first: every code change lands its failing control before the fix. Close-with-evidence issues need no code — their task is the evidence comment.

## 1. #65 — bound primer B2/B3

- [x] 1.1 RED: add a test in `packages/core/src/orchestrator-primer.test.ts` assembling a primer for 10 repos / 20 canvases; assert it returns (no throw) with `bytes ≤ PRIMER_MAX_BYTES` and that B2/B3 end in rollup tail lines. Confirm it fails against current `assemblePrimer` (throws or overruns).
- [x] 1.2 Implement the caps + rollup tails in `packages/core/src/orchestrator-primer.ts` per design (named K constant; `… +N more repos — X fresh / Y stale`; `… +N more canvases — aggregate counts`). Keep ordering and the ceiling throw.
- [x] 1.3 Extend the determinism test to cover the rollup path (same large inputs → identical bytes/digest); confirm small reviews' primer bytes are unchanged (existing tests stay green untouched).
- [x] 1.4 Docs: update any docsite page stating "one line per repo" for B2 (grep `docs/src/content/docs` for primer section descriptions) to the bounded-with-rollup truth.

## 2. #89 — harness follows the model

- [x] 2.1 RED: add a test in `packages/core/src/model-council.test.ts` reproducing the issue's incoherent pair (task override `{ model: <codex model>, harness: "claude-code" }` shape, adapted to the post-change type by asserting on the model-only override): resolution harness AND `trace.summary` name `providerHarness(model)`. Confirm the trace/harness assertion fails today.
- [x] 2.2 Delete `harness` from the override type in `packages/core/src/model-council.ts`; derive `harness = providerHarness(model)` after all overrides on every model-resolving path; remove the two independent-pin lines (~546, ~560).
- [x] 2.3 Grep the repo for any override-`harness` producer or test assertion (`overrides.*harness`, `tierOverride.harness`, `taskOverride.harness`) and delete dead references; typecheck is the sweep's control.
- [x] 2.4 Docs: fix any docsite page describing overrides as able to pin harness (grep `docs/src/content/docs` for the resolver's override description).

## 3. #92 — tokenizer items 1–2

- [x] 3.1 RED: add cases to `packages/ui/src/syntax/highlight.test.ts`: shell `echo foo#bar` (`#bar` NOT comment), shell `echo foo #bar` (comment), yaml `url: https://x.test/#frag` (NOT comment), python `x=1#c` (comment); `0b102` (binary rejects `2` — trailing digits fail closed to plain), `0o18`, `1e10_000` (separator handled consistently, malformed fails closed to plain). Confirm they fail.
- [x] 3.2 Add `commentNeedsWordBoundary` to `Grammar` (`languages.ts`: true for shell/yaml/toml-style `#` grammars, false for python) and gate the line-comment match in `scan()` on `i === 0 || isWhitespace(prev)`.
- [x] 3.3 Replace shared `isHexOrSep` with radix-specific digit predicates in `readNumber` and carry the separator rule through the exponent path; malformed candidates fail closed to plain. Reassembly invariant tests stay green (lossless).
- [x] 3.4 One-line tidy: fix the imprecise node-count comment in `code-view.test.tsx` ("tokenized the whole file" wording — off-screen tokenization creates no DOM nodes).
- [ ] 3.5 Close #92 recording: items 1–2 shipped, item 3 (regex literals) deliberately not built per the issue's own risk analysis, superseded wholesale by `@pierre/diffs` adoption.

## 4. #316 — one per-review turn ceiling

- [x] 4.1 RED: add a main-process test beside `apps/desktop/src/main/index.ts` driving BOTH flows (canvases, then flagged) for one review with a recording fake adapter; assert the hypothesis turn ran ONCE and total invocations debit one shared ceiling. Confirm it fails (two hypothesis turns today).
- [x] 4.2 Implement the per-review intelligence session per design: `Map` keyed `(reviewId, activePatchsetId)` holding `{ budget, hypothesis: Promise }`; both flows draw budget and hypothesis from it; ceiling created once via `reviewInvocationCeiling`.
- [x] 4.3 Test: a reattach (new active patchset) re-derives the hypothesis and resets the ceiling; concurrent flow entry awaits the in-flight hypothesis promise (no double spend).
- [ ] 4.4 Close #316 with the shipped single-ceiling summary.

## 5. #223 — scope-honest miss copy, then close

- [x] 5.1 RED: adjust the expectation in `symbol-inspector.dom.test.tsx` for the no-definition copy to name the committed review range; confirm it fails.
- [x] 5.2 Update the copy at `packages/ui/src/components/symbol-inspector.tsx:153` to say the lookup covers the committed review range (uncommitted local edits are outside it).
- [ ] 5.3 Close #223 with evidence: head-pin shipped (`symbol-lookup-live.ts:46`), working-tree overlay deliberately not built (committed range is the right review scope; no demand; reopen on real demand).

## 6. #75 — close with evidence

- [ ] 6.1 Close #75 with the grep evidence: `documentRejected` has zero occurrences in `packages/`, `apps/`, `docs/src` — no producer, no ledger, no consumer; amendment already struck the zero-writes criterion. Reopen when a `dsl.documentRejected` producer ships.

## 7. Docs + gate

- [ ] 7.1 Update `docs/src/content/docs/developing/reference/delivery-order.md`: mark wave 11's sweep delivered with the per-issue outcomes (four fixes, two evidence closes), leaving #85 as the open closing milestone.
- [ ] 7.2 `pnpm check` green before push (includes a positive control: the red-first tests above each failed before their fix).
