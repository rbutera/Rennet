# Product-debt sweep (wave 5)

## Why

Wave 5 of the delivery order (`docs/src/content/docs/developing/reference/delivery-order.md`) closes the last five open debts before Rennet is feature-complete as specced. Each was re-verified against live code on `main` (2026-08-16); two of the five turn out to be mostly or wholly shipped, and one is a deletion by Rai's recorded verdict.

## What Changes

One debt per section. Verdicts are grounded in live code, not the issues' original text.

### #158 remainder — stale "NO model spend" comment + the lazy-vs-eager settle

Verdict: **tiny real remainder (a comment fix plus a recorded decision), no behavior change.**

Evidence: 3 of 4 edges are fixed on `main` (see the issue's 2026-08-16 audit comment). What is left is exactly one lie in the source: the flagged effect's comment at `packages/ui/src/app.tsx:890` still says the `flagged.review` fetch "carries NO model spend", but the effect (`app.tsx:894-943`) now triggers the full budget-ceilinged hypothesis + dual + verify pipeline on every review open. The comments at `app.tsx:947` and `app.tsx:1006` describe genuinely deterministic fetches and stay.

The settle: **eager stays.** The auto-run on review open is the intended MVP behavior, budget-ceilinged by `createInvocationBudget`; a lazy on-lens-open trigger would be a capability withheld until a ceremony — the wrong direction under Rule Zero. The decision is recorded in `design.md`; the comment is rewritten to tell the truth. Closes #158.

### #71 — verify-or-close

Verdict: **close with evidence, no code.**

The issue's audit comment left two unverified claims; both hold on `main`:

1. Feed-line anchors: landed in PR #321 (merge `ce294c6`). `packages/ui/src/components/progress-feed.tsx:45-52` renders a landed block's head as a navigation-activating anchor when the fold produced one; `progress-feed-fold.ts:104,132` attaches artifact anchors from real pipeline events; anchor-less blocks are honestly inert (`progress-feed-fold.ts:33-35`).
2. One organ: there is exactly one narration-feed implementation — `ProgressFeed` + `deriveProgressView` (`progress-feed.tsx`, `progress-feed-fold.ts`) — consumed by `ProjectProcessing` (`project-processing.tsx:9-10,139`), rendered from the front door (`front-door.tsx:267`). No near-copy exists: `narration.tsx` is the #70 zoom-ladder narration (a different organ with a different job), and refresh/capture waits are short busy states (`app.tsx:1113-1130`), not competing feed implementations. Wiring more consumers is future feature work when those waits earn narration, not debt.

The MVP acceptance (never a bare spinner over a blank, honest pending) also holds — `project-processing.tsx` renders live narration during processing. The task is to close #71 citing this evidence.

### #239 — raw markdown one keystroke away

Verdict: **real remainder.** The structured viewer (`packages/ui/src/components/openspec.tsx`) has no view-raw escape hatch; the only trace is the design comment at `openspec.tsx:18` ("never a raw-markdown dump"). The parsed model the viewer receives (`OpenSpecChange`, `packages/types/src/index.ts:3292`) carries no raw text; the raw artifact text exists one layer down as the parser's input (`OpenSpecChangeArtifacts`, `packages/core/src/openspec-change.ts:63`).

The work: carry the raw artifact text alongside the parsed model through the `openspec.change` command result, and give the viewer a keystroke toggle that flips the structured view to the raw markdown of the visible artifact and back. Structured stays the default; raw is the escape hatch #33 promised. Closes #239.

### #88 — provenance re-stamping, three sites

Verdict: **real remainder, and partly a live lie already.** The three sites hard-stamp executor labels the executor did not earn:

- `packages/core/src/angle-generation.ts:224-235` (`buildProvenance`): `tier` is `"heavy"` for any non-deterministic route, stamped `"agentic"` at `:332`.
- `packages/core/src/ordering-pass.ts:237-248`, stamped at `:346`: same pattern.
- `packages/core/src/finding-generation.ts:335-336`: unconditional `tier: "heavy"`, `route: "agentic"`.

The finding site is not hypothetical: the dual-model finding pass already runs its Codex seat through `createCodexRunTurn` (`packages/core/src/dual-seat.ts:131-146`), and the pipeline routes codex-resolved seats the same way (`pipeline.ts:412-423`), so Codex-executed docs today record `route=agentic`/`tier=heavy` while the port's own honest provenance (`codex-utility-port.ts:235-259` — `tier:"light"`, `route:"utility"`, per-call `codexUtilityCapability(structuredOutputExercised)`) is built and then discarded. The `capability` snapshot is likewise re-stamped from the seed's default.

The fix (issue #88's own proposal): thread the port's provenance facts (route, tier, capability) back through the injected-turn result — a small additive contract change on `HarnessTurnResult` (`packages/core/src/harness-run-turn.ts:27-29`) — so the runner stamps what actually ran instead of the seed defaults. Model, harness, effort, and resolutionTrace are already honest and unchanged. Closes #88.

### #221 — drop the Claims lens (Rai's verdict, 2026-08-16)

Verdict: **deletion.** Decisions owns this ground (wireframe `08-decisions` canonical; #297 already removed the palette entry). Removal surface, verified live:

- `packages/types/src/index.ts:896` (`ChunkAngle`), `:1078` (`CanvasAngle`), `:1081-1089` (`CANVAS_ANGLES`), `:418` (`"claim"` in `RspDocType`).
- `packages/protocol/src/bodies.ts:29` (`CHUNK_ASSIGNABLE_ANGLES`) and `packages/protocol/src/rsp.ts:71` (`"claim"` docType list). The `claim` docType has **no producer** anywhere in `core` (fixtures only), so it goes with the lens rather than dangling with no canvas home.
- `packages/core/src/canvas.ts:55` (`claim: "claims"` routing).
- `packages/ui/src`: `components/lens.tsx:9` (switcher label), `components/flat.tsx:10-15` (flat-canvas copy + empty state), `canvas/logic.ts:129,430` (doc-angle comments), `canvas/fixtures.ts:170,205`, plus the tests that enumerate the lens set (`rotateLens` itself is set-driven, `canvas/logic.ts:243-252`, and needs no code change — the set shrinks under it).
- Specs of record: `openspec/specs/canvas-ui/spec.md:8` (six angles, five selectable) and `openspec/specs/rsp-validator/spec.md:44` (V104 closed set includes `claims`) — the removal is the spec delta.
- Docs: `docs/src/content/docs/developing/concepts/canvas-model.md:34,148` already call the surface retiring; they are updated to describe the five-angle reality, and the delivery-order wave-5 entry is marked done.

Legacy handling (design.md): persisted decomposition docs may carry `claims` chunk angles; the loader normalizes the retired value away on read so old reviews still open, while the validator rejects it in newly produced docs. Closes #221.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `canvas-ui`: the lens switcher drops the `claims` canvas (five angles, four selectable; blast-radius stays overlay-only), and the Spec angle gains the raw-markdown escape hatch (one keystroke between structured view and raw artifact text).
- `rsp-validator`: V104's closed chunk-angle set drops `claims` (becomes `sequence`, `decisions`, `blast-radius`); a chunk declaring `claims` rejects with V104.
- `comprehension-ordering-pass`: provenance route/tier reflect the executor that actually ran (Claude harness turn → `agentic`/`heavy`; Codex utility port → `utility`/`light`; fallback unchanged at `deterministic`), instead of an unconditional `agentic`.

## Impact

- `packages/types`: `CanvasAngle`/`ChunkAngle`/`CANVAS_ANGLES`/`RspDocType` shrink (**BREAKING** for persisted docs carrying `claims` chunk angles — mitigated by normalize-on-read, design.md).
- `packages/protocol`: `CHUNK_ASSIGNABLE_ANGLES`, docType list, validator V104 set.
- `packages/core`: `harness-run-turn.ts` (additive `HarnessTurnResult` executor facts), `codex-run-turn.ts`, `angle-generation.ts`, `ordering-pass.ts`, `finding-generation.ts`, `canvas.ts`, `openspec-change.ts` (raw text carry).
- `packages/ui`: lens set surfaces, flat canvas, fixtures, `openspec.tsx` (raw toggle), one comment in `app.tsx`.
- `packages/adapters` / `apps/desktop`: `openspec.change` result carries raw artifact text.
- Docs: `canvas-model.md`, `delivery-order.md` wave-5 entry; issues #158, #71, #239, #88, #221 close with evidence.
- No new dependencies. No gates: every change is honest labelling, deletion, or a capability (Rule Zero clean).
