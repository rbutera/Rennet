# Tasks — product-debt-sweep

One branch, five debts. Red-first positive controls wherever code changes; close-with-evidence where nothing remains.

## 1. #221 — delete the Claims lens

- [ ] 1.1 RED: add failing tests pinning the target state — `CANVAS_ANGLES` has five entries with no `claims`; `rotateLens` cycles spec → sequence → decisions → noise → flagged; a chunk declaring `claims` rejects with V104; the lens switcher renders four selectable canvases and no Claims entry.
- [ ] 1.2 Remove `claims` from `CanvasAngle`, `CANVAS_ANGLES`, `ChunkAngle` (`packages/types/src/index.ts:896,1078,1081-1089`) and `"claim"` from `RspDocType` (`:418`).
- [ ] 1.3 Remove `claims` from `CHUNK_ASSIGNABLE_ANGLES` (`packages/protocol/src/bodies.ts:29`) and `"claim"` from the docType list (`packages/protocol/src/rsp.ts:71`); update the V104 comment and any protocol tests enumerating the sets.
- [ ] 1.4 Remove the `claim: "claims"` routing from `DOC_TYPE_ANGLE` (`packages/core/src/canvas.ts:55`).
- [ ] 1.5 Add the retired-angle normalization on the persistence read path: strip retired chunk-angle values (named constant, currently `["claims"]`) before validation, with a test that a persisted decomposition doc carrying a `claims` chunk angle still loads and the review still opens (design.md decision 2).
- [ ] 1.6 Delete the claims surfaces in `packages/ui/src`: switcher label (`components/lens.tsx:9`), flat-canvas copy and empty state (`components/flat.tsx:10-15`), fixtures (`canvas/fixtures.ts:170,205`), stale doc-angle comments (`canvas/logic.ts:129,430`), and every test enumerating the old six-angle set.
- [ ] 1.7 Confirm the 1.1 tests now pass and `pnpm check` is green across all packages (the type-union shrink is the sweep: the compiler names every remaining reference).

## 2. #88 — provenance reflects the executor (three sites)

- [ ] 2.1 RED: add a failing test driving `createCodexRunTurn` through `runOrderingPass` (or `runFindingAngle`) asserting the admitted doc's provenance records `route: "utility"`, `tier: "light"`, and the port's per-call capability snapshot — today it records `agentic`/`heavy`/seed capability.
- [ ] 2.2 Add the optional executor-provenance facts (route, tier, capability) to the `emitted` variant of `HarnessTurnResult` (`packages/core/src/harness-run-turn.ts:27`); fill them in `createCodexRunTurn` from the port's honest provenance; leave the Claude turn absent.
- [ ] 2.3 Stamp from the turn's executor facts when present, seed defaults when absent, in all three `buildProvenance` sites: `angle-generation.ts:224-235`, `ordering-pass.ts:237-248`, `finding-generation.ts:328-346`.
- [ ] 2.4 Positive control: a Claude-turn test asserting provenance is unchanged (`agentic`/`heavy`, seed capability) so the fallback path is proven, not assumed.
- [ ] 2.5 Confirm the 2.1 test passes; close #88 in the PR body with the test as evidence.

## 3. #239 — raw markdown one keystroke away

- [ ] 3.1 RED: add a failing DOM test — with the structured OpenSpec view rendered, the raw-view keystroke shows the visible artifact's verbatim raw markdown; the same keystroke returns the structured view; structured is the default on fresh render.
- [ ] 3.2 Carry the raw artifact text alongside the parsed model through the `openspec.change` command result (additive field on the payload, sourced from the artifacts the adapter already reads off disk).
- [ ] 3.3 Add the raw/structured toggle to `packages/ui/src/components/openspec.tsx`: one boolean of view state, keystroke registered through the existing keybinding seam (pick an unclaimed key), raw text rendered verbatim.
- [ ] 3.4 Confirm the 3.1 test passes; update the `openspec.tsx` header comment (structured-first, raw escape hatch one keystroke away).

## 4. #158 — tell the truth about flagged spend, settle eager

- [ ] 4.1 Rewrite the stale comment at `packages/ui/src/app.tsx:890`: the flagged fetch runs the full budget-ceilinged hypothesis + dual + verify pipeline on review open (eager by decision — design.md decision 4). Leave the honest deterministic-fetch comments at `:947` and `:1006` alone.
- [ ] 4.2 Close #158 with evidence: link the audit comment (3 of 4 edges already fixed on main), the comment fix, and the recorded eager decision.

## 5. #71 — close with evidence

- [ ] 5.1 Close #71 citing the live evidence: anchors landed in #321 (`progress-feed.tsx:45-52`, `progress-feed-fold.ts:104,132`), one narration organ with no near-copies (`ProgressFeed`/`deriveProgressView`, sole feed implementation; `narration.tsx` is the distinct #70 zoom-ladder organ), MVP honest-pending acceptance holds (`project-processing.tsx`). Note that refresh/capture consumers are future feature work, not remaining debt.

## 6. Docs and closeout (same change — definition of done)

- [ ] 6.1 Update `docs/src/content/docs/developing/concepts/canvas-model.md` (`:34`, `:148`): the claims canvas is removed, five angles, Decisions owns the ground; describe the retired-angle normalization for old reviews.
- [ ] 6.2 Sweep the docsite for any other page naming the Claims lens or the swept behaviors (`grep -ri "claims" docs/src/content/docs`) and correct what reads wrong after this change.
- [ ] 6.3 Mark the delivery-order wave-5 entry done (`docs/src/content/docs/developing/reference/delivery-order.md`), matching the struck-through style of waves 1–3.
- [ ] 6.4 `pnpm check` green (full gate, with the red-first tests from 1.1/2.1/3.1 as the positive controls); close #221, #239, #88, #158, #71 in the PR.
