# B2 — Canvas deletion cutover: the #459 census executed delete-first (#489)

## Why

The partition-canvas model is rot the Board replaces (#459, resolved 2026-08-23: clean cutover, no coexistence). Decision Q3 on the plan ticket made the cutover **delete-first**: B2 executes the deletion census wholesale, `main` stays gate-green (compiles, tests pass), and the product is deliberately mid-rebuild until Track C restores the surface. Two packages die (`instructions`), one is renamed (`lens-instructions` → `prompts`), none are born. The `delta-account` → `successor-account` rename (#457) is folded in.

**The mandatory reconciliation (engine asset risk 5):** #459's KEEP list is stale where #464 overrode it (dec. 2 — drafters replace generators). The model-backed generation passes die: `angle-generation`, `finding-generation`, `decision-generation`, `hypothesis-generation`, `finding-adjudication`, `adjudication-corpus`, `ui-verification`, `ordering-pass`, `rollup-narration`. The deterministic producers survive, to be re-homed by B5's `buildDeltaPacket()`: `element-diffs`, collation/counterpart, `blast-radius`, openspec parse (`openspec-change`), noise pre-classify (`noise-generation`'s rule layer), `finding-reconcile`. The verdict tables below list every affected file **before anything is deleted**; the positive control diffs this list against what git actually deleted.

## What Changes

- **`packages/protocol`** loses its `canvas.*` surface: the canvas schema block and per-angle `canvases` record, the `review.canvases` command, all six `canvas.*` commands and their bodies, and the Canvas state model block that B1 moved into `domain.ts` (`Canvas`, the four layer types, `CanvasAngle`/`CANVAS_ANGLES`, `AnalysisElement`/`AnalysisCohort`, `Proposal*`, `BlastRadiusPaint`, `CanvasChangeNotification`, `Disposition`/`DispositionType`/`DispositionLayer` — Disposition dissolves per #459, Rule Zero).
- **`packages/core`** loses the projector (`canvas.ts`), `canvas-ops`, `canvas-change-feed`, the nine model-backed generation passes, and the canvasOps orchestrator machinery that exists only to serve them (`orchestrator-primer`, `orchestrator-session`, `context-update-stream`, `dual-finding-review`). The deterministic producers survive with dead references trimmed. `delta-account.ts` → `successor-account.ts`.
- **`packages/adapters`** loses `canvas-ops-*`, the backends of dead passes (`adjudication-backend`, `adjudication-calibration`, `ui-verification-backend`), the orchestrator turn/session seams, and the canvas lens fixtures.
- **`packages/server`** keeps its shape but is trimmed: `buildCanvases*`, the `review.canvases` handler, canvasOps@2 wiring, and dead-pass calls come out of `create-server.ts` / `dispatch.ts` / `orchestrator.ts`. `projection.ts` is untouched (census: unrelated path-privacy projector).
- **`packages/app-ui`** — `src/canvas/*` is reduced to the Q17 keepers (`registrar`, `read-state`, `symbol`) plus the two #464 deterministic survivors that have no other home (`collation`, `counterpart`); the canvas-era workspace surface (workspace, lens, flat, the per-angle renderers, conversation/authoring/publish hosts, `collation-draft-canvas.tsx`) and its DOM tests die; `app.tsx`/`shell.tsx`/the review-workspace route are trimmed to a stub so the app still launches.
- **`apps/mobile`** — the canvas route is stubbed (mobile-on-boards is a separate future effort, Q10); `canvas-rows` dies.
- **`packages/instructions` is deleted**; `packages/lens-instructions` is renamed **`packages/prompts`** and absorbs the surviving instruction exports (verification/CI contracts, prompt-layer assembly). The boundary law moves with it: the `layer:lens-instructions` eslint tag and `check-boundaries.mjs` entry become `layer:prompts` / `@rennet/prompts` (gaining a `protocol` edge for the absorbed contracts); `layer:instructions` is removed everywhere; CLAUDE.md's package-boundary paragraph is rewritten to match.
- **Docs in the same change**: `canvas-model.md` deleted (its Board replacement is #490's scope — coordinated, not skipped), the packet-listed and grep-found pages updated, `delta-rereview-and-lineage.md` carries the successor-account rename.

**Explicitly out of scope** (packet): building anything new; the protocol folder restructure and `LensBoard` shape (B3); the delta-packet re-home of the surviving producers (B5); the lens pipeline itself (B8); mobile board rebuild.

**Amendment rule for the verdict tables:** the positive control requires the tables to match what git deleted. If execution finds a verdict unimplementable (a KEEP file inseparable from dead code, or vice versa), the implementer amends the table *in the same commit as the deviation* with a one-line reason, so the control diff stays meaningful and the wave review sees every deviation.

## The reconciliation — file verdicts

Verdicts: **DELETE**, **KEEP** (untouched), **KEEP (trim)** — survives with references to deleted code removed, no new behavior, **STUB**, **RENAME**. Tier: *(census)* = named by #459/#464/the packet; *(cascade)* = forced caller, removed or trimmed so `main` stays green.

### packages/protocol/src

| File | Verdict |
|---|---|
| `index.ts` | KEEP (trim) *(census)* — delete `canvasSchema` + the five-angle `canvases` record (~316–345), `review.canvases`, the six `canvas.*` commands (~2905–2971), and the `Canvas` inferred-type exports |
| `domain.ts` | KEEP (trim) *(census)* — delete the Canvas state model block (from ~834): `CanvasAngle`, `CANVAS_ANGLES`, the four layer types, `AnalysisElement`/`AnalysisCohort`, `Proposal*`, `BlastRadiusPaint`, `CanvasChangeNotification`, `Disposition`/`DispositionType`/`DispositionLayer`. Anchor/patchset types (`AnchorSide`, `AnchorSpan`, `ParsedAnchor`, `RenderedHunkOccurrence`) stay — they serve the keepers and findings |
| `bodies.ts` | KEEP (trim) *(census)* — drop the `canvas.*` command bodies |
| `canvas-commands.test.ts` | DELETE *(census)* |
| `review-canvases.test.ts` | DELETE *(census)* |
| `session.ts`, `session.test.ts`, `rsp.ts`, `index.test.ts` | KEEP (trim) *(cascade)* — drop canvas/dead-pass references; RSP validators used by surviving `noise-generation`/`finding-verification` stay |

### packages/core/src

| File | Verdict |
|---|---|
| `canvas.ts`, `canvas.test.ts` | DELETE *(census)* |
| `canvas-ops.ts`, `canvas-ops.test.ts` | DELETE *(census)* |
| `canvas-change-feed.ts`, `canvas-change-feed.test.ts` | DELETE *(census)* |
| `angle-generation.ts`, `angle-generation.test.ts` | DELETE *(census, #464 model-backed)* |
| `finding-generation.ts`, `finding-generation.test.ts` | DELETE *(census, #464)* |
| `decision-generation.ts`, `decision-generation.test.ts` | DELETE *(census, #464)* |
| `hypothesis-generation.ts`, `hypothesis-generation.test.ts` | DELETE *(census, #464)* |
| `finding-adjudication.ts`, `finding-adjudication.test.ts` | DELETE *(census, #464)* |
| `adjudication-corpus.ts`, `adjudication-corpus.test.ts` | DELETE *(census, #464)* |
| `ui-verification.ts`, `ui-verification.test.ts` | DELETE *(census, #464)* |
| `ordering-pass.ts`, `ordering-pass.test.ts` | DELETE *(census, #464)* |
| `rollup-narration.ts`, `rollup-narration.test.ts` | DELETE *(census, #464)* |
| `orchestrator-primer.ts`, `orchestrator-primer.test.ts` | DELETE *(cascade — exists only for canvasOps@2)* |
| `orchestrator-session.ts`, `orchestrator-session.test.ts` | DELETE *(cascade — same)* |
| `context-update-stream.ts`, `context-update-stream.test.ts` | DELETE *(cascade — canvas change-feed consumer)* |
| `dual-finding-review.ts`, `dual-finding-review.test.ts` | DELETE *(cascade — wraps dead `runFindingAngle`; B8's drafters replace it)* |
| `convention-injection.test.ts`, `hypothesis-injection.test.ts`, `budget-gate.test.ts`, `pipeline-hypothesis.test.ts`, `pipeline-review-intelligence.test.ts`, `finding-verification-composition.test.ts` | DELETE *(cascade — test dead passes through dead runners)* |
| `element-diffs.ts`, `element-diffs.test.ts` | KEEP (trim) *(census survivor — deterministic producer; inline `compareCodeUnits` from the dying `canvas.ts`, re-type off deleted protocol types)* |
| `blast-radius.ts`, `blast-radius.test.ts` | KEEP *(census survivor)* |
| `openspec-change.ts`, `openspec-change.test.ts` | KEEP *(census survivor — openspec parse)* |
| `finding-reconcile.ts`, `finding-reconcile.test.ts` | KEEP *(census survivor)* |
| `noise-generation.ts`, `noise-generation.test.ts` | KEEP (trim) *(census survivor — noise pre-classify; test drops its dead `angle-generation` imports)* |
| `pipeline.ts`, `pipeline.test.ts` | KEEP (trim) *(cascade — the generation/placement phases and `buildCanvas` call come out; the deterministic spine stays for `review-backend`)* |
| `dual-seat.ts`, `dual-seat.test.ts` | KEEP (trim) *(#464 names `resolveDualSeat` as the council path; drop `finding-generation` imports)* |
| `review-backend.ts`, `review-backend.test.ts` | KEEP (trim) *(cascade — drop canvas-ops/canvas types)* |
| `index.ts` | KEEP (trim) — drop dead re-exports |
| `delta-account.ts`, `delta-account.test.ts` | RENAME → `successor-account.ts` / `successor-account.test.ts` *(census, #457, cluster 7)* |

**Cluster-4 execution amendments (forced deviations, recorded per the deletion-authority rule; the positive control diffs THIS list vs `git`):**

- `ui-verification.ts`: DELETE → **KEEP (trim)**. Its deterministic `classifyUiSurface` / `UI_SURFACE_CLASSIFIER_VERSION` / `RunUiVerificationResult` are read LIVE by `create-server`'s flagged path (the $0 immediate UI-surface status); only the model verify-ui turn (`runUiVerification`) is deleted. `ui-verification.test.ts` still DELETED (it tested the model turn).
- `angle-generation.ts`: DELETE stands, but its deterministic `buildOfferedManifest` (read live by `create-server`'s flagged finding path + noise) is **rehomed to a new `offered-manifest.ts`** rather than lost.
- `review-backend.ts`, `review-backend.test.ts`: KEEP (trim) → **DELETE**. `reviewBackendCore`'s entire surface is the canvas/diff/run accessors, which are dead after the projection deletion — the live backend (symbolLookup / context.ask) consumes only the context/symbol/ask slices. Forced by the `canvas-ops.ts` DELETE: the `CanvasOpsBackend` port is re-typed to `LiveReviewContextBackend` (adapters `live-review-backend.ts`) + a minimal `SymbolLookupBackend` (server `symbol-lookup-live.ts`).
- `element-diffs.ts`: the table said "inline `compareCodeUnits`"; the actual dying-`canvas.ts` dependency is `AdmittedDocument` + `isProposalBody` (element-diffs uses a local `compare`, never `compareCodeUnits`). Those two were inlined.
- New file: `packages/core/src/offered-manifest.ts` (holds `buildOfferedManifest`).
- Cascade DELETEs (untabled survivors that could not be trimmed without inventing behaviour): `packages/server/src/review-pipeline-input.ts` + `.test.ts` (orphaned once the model-seat pipeline input died); `packages/adapters/src/finding-verification-cost.real.test.ts`, `cost-baseline.real.test.ts`, `dual-review-cost.real.test.ts`, `integration/real-decomposition.integration.test.ts` (drove the deleted finding/decomposition passes).
- `create-server.ts` (KEEP-trim, server table): the `runDualFindingReview` finding-generation call in `runFlaggedReviewWithContextFeed` trimmed out (dead pass; B8's drafters replace it) → the flagged lens degrades to no findings, while the deterministic CI signal / blocking states / UI classifier still stamp.

### packages/adapters/src

| File | Verdict |
|---|---|
| `canvas-ops-external.ts`, `canvas-ops-external.test.ts` | DELETE *(census)* |
| `canvas-ops-server.ts`, `canvas-ops-server.test.ts` | DELETE *(census)* |
| `canvas-ops-test-backend.ts`, `canvas-ops-wired.test.ts` | DELETE *(census)* |
| `adjudication-backend.ts`, `adjudication-calibration.ts`, `adjudication-calibration.test.ts`, `adjudication-calibration.real.test.ts`, `adjudication-calibration.json` | DELETE *(cascade — backend of dead `finding-adjudication`)* |
| `ui-verification-backend.ts`, `ui-verification-backend.test.ts` | DELETE *(cascade — backend of dead `ui-verification`)* |
| `orchestrator-turn.ts`, `orchestrator-turn.test.ts`, `orchestrator-session-server.ts`, `orchestrator-session-server.test.ts`, `orchestrator-live.real.test.ts`, `orchestrator-codex-live.real.test.ts` | DELETE *(cascade — canvasOps@2 orchestrator seams; B4/B9 rebuild on whiteboard tools)* |
| `decisions-fixture.ts`, `decisions-fixture.test.ts`, `flagged-fixture.ts`, `noise-fixture.ts`, `noise-fixture.test.ts` | DELETE *(cascade — fixture feeds for the canvas build path)* |
| `review-ask-fixture.ts`, `review-ask-fixture.test.ts` | KEEP *(ask flow survives)* |
| `index.ts`, `codex-wsl-live.real.test.ts` | KEEP (trim) — drop dead re-exports/references |
| `ci-refinement-backend.ts`, `convention-catalogue-reader.ts` | KEEP — instruction imports re-point to `@rennet/prompts` |

### packages/server/src

| File | Verdict |
|---|---|
| `create-server.ts` | KEEP (trim) *(census REWORK)* — `buildCanvasesForReview*`, the `review.canvases` delivery, canvasOps@2 wiring, dead-pass calls out |
| `dispatch.ts`, `dispatch.test.ts` | KEEP (trim) *(census REWORK)* — drop `buildCanvases` from the seam |
| `orchestrator.ts`, `orchestrator.test.ts` | DELETE *(cascade — server seam for the canvasOps orchestrator loop)* |
| `review-intelligence-session.ts`, `review-intelligence-session.test.ts` | KEEP (trim) *(cascade — hypothesis phase out; the surviving ask flow stays)* |
| `review-ask-live.ts`, `review-ask-live.test.ts`, `live-review-backend.test.ts`, `delta-digest-live.ts`, `delta-digest-live.test.ts`, `projection.test.ts` | KEEP (trim) — dead references only |
| `projection.ts` | KEEP *(census: unrelated path-privacy projector)* |

### packages/app-ui/src/canvas (44 files)

| File | Verdict |
|---|---|
| `registrar.ts`, `registrar.test.ts` | KEEP *(Q17)* |
| `read-state.ts`, `read-state.test.ts` | KEEP (trim) *(Q17; `Disposition` import dies — trim to a local shape)* |
| `symbol.ts`, `symbol.test.ts` | KEEP *(Q17)* |
| `collation.ts`, `collation.test.ts` | KEEP (trim) *(#464 deterministic survivor, only implementation in the repo, B5 input; inline the `DispositionType`/`DispositionBatch`/`anchorPathKey` shapes it needs from its dying siblings)* |
| `counterpart.ts`, `counterpart.test.ts` | KEEP (trim) *(#464 deterministic survivor, B5 input; replace `Canvas`/`CanvasAngle`/`CANVAS_ANGLES` with a local five-value lens union pending B3)* |
| `ask.ts`, `ask.test.ts`, `authoring.ts`, `authoring.test.ts`, `conversation.ts`, `conversation.test.ts`, `conversation-durability.test.ts`, `destination.ts`, `destination.test.ts`, `feed.ts`, `feed.test.ts`, `fixtures.ts`, `flagged.ts`, `flagged.test.ts`, `flagged-ui-verification.test.ts`, `flagged-verification.test.ts`, `hypothesis.ts`, `hypothesis.test.ts`, `load.ts`, `load.test.ts`, `logic.ts`, `logic.test.ts`, `narration-logic.test.ts`, `noise.ts`, `noise.test.ts`, `openspec.ts`, `openspec.test.ts`, `openspec.fixture.ts`, `publish.ts`, `publish.test.ts`, `staging.ts`, `staging.test.ts`, `store.ts`, `store.test.ts` | DELETE *(census — the other canvas modules; 34 files)* |

### packages/app-ui/src — components, app shell, tests

DELETE *(census: workspace, lens, flat, per-angle renderers + related index exports; cascade: hosts built on dying canvas modules)* — components: `workspace.tsx`, `lens.tsx`, `flat.tsx`, `batch-view.tsx`, `decisions.tsx`, `disposition.tsx`, `disposition-cluster.tsx`, `flagged.tsx`, `hypothesis.tsx`, `l3.tsx`, `mark-index.tsx`, `narration.tsx`, `noise.tsx`, `openspec.tsx`, `orphan-tray.tsx`, `granularity-author.tsx`, `ask.tsx`, `conversation-cluster.tsx`, `conversation-host.tsx`, `conversation-panel.tsx`, `collation-draft-canvas.tsx`, `destination-frame.tsx`, `publish-sheet.tsx`, `handoff-paper.tsx` (24 files).

DELETE — their component tests: `ask.dom.test.tsx`, `batch-view.dom.test.tsx`, `blast-not-assessed.dom.test.tsx`, `collation-draft-canvas.dom.test.tsx`, `collation-lanes.dom.test.tsx`, `conversation-cluster.dom.test.tsx`, `conversation-host.dom.test.tsx`, `conversation-host.reattach.dom.test.tsx`, `conversation-host.reattach-render.dom.test.tsx`, `conversation-host.streaming.dom.test.tsx`, `conversation-panel.dom.test.tsx`, `conversation-panel.css.test.tsx`, `decisions.dom.test.tsx`, `disposition-cluster.dom.test.tsx`, `flagged.dom.test.tsx`, `flagged-ui-verification.dom.test.tsx`, `noise.dom.test.tsx`, `openspec.dom.test.tsx`, `openspec-workspace.dom.test.tsx`, `pr-body-composer.dom.test.tsx`, `publish-hold-progress.dom.test.tsx`, `publish-safety.dom.test.tsx`, `publish-variants.dom.test.tsx`, `workspace-mark-orphan.dom.test.tsx`, `workspace-symbol.dom.test.tsx`, `workspace.blast.dom.test.tsx`, `workspace.navigation.dom.test.tsx`, `app-review-heart-align.dom.test.tsx`, `app-review-heart-reflow.css.test.ts`, `authoring-surface.test.tsx`, `code-view.anchor.dom.test.tsx`, `code-view.discuss.dom.test.tsx`, `code-view.test.tsx`, `code-visibility.test.tsx`, `components.test.tsx`, `destination.test.tsx`, `narration.test.tsx`, `handoff-paper.test.tsx` (38 files). **B2 amendment (+5, dying siblings the census missed):** `code-view-dispose.dom.test.tsx` (imports dying `DispositionType` + tests the CodeView header disposition cluster trimmed in 1.2), `flat.blast.dom.test.tsx` (imports `FlatCanvas` from deleted `./flat`), `lens.dom.test.tsx` (imports `LensSwitcher` from deleted `./lens`), `workspace.hypothesis.dom.test.tsx` + `workspace.scheme.dom.test.tsx` (import `CanvasWorkspace` from deleted `./workspace`) — 43 component tests total.

DELETE — app-level DOM tests driving the canvas workspace: `app.adjudication-enrichment`, `app.angle-rail`, `app.command-palette`, `app.context-manifest`, `app.conversation-cluster`, `app.decisions-failed`, `app.deixis`, `app.dual-transition`, `app.engine`, `app.handoff`, `app.keybindings`, `app.lens-failed`, `app.navigation`, `app.persist-privacy`, `app.pr-body-draft`, `app.pr-body-draft-regenerate`, `app.real-post`, `app.refine`, `app.regenerate-flagged`, `app.render-race`, `app.running-review`, `app.staging-publish` (all `.dom.test.tsx`; 22 files). **B2 amendment (+3, forced by the shell/route stub):** `app.test.tsx` (both blocks assert the deleted `ReviewWorkspace` diff-rendering — nothing survives to trim, and an empty vitest suite fails), `app.dom.test.tsx` (the sign→`publish.review` engine wire; imports the dying `./canvas/publish`), and `app.delta-account.dom.test.tsx` (asserts a delta-account hunk click focusing the `.diff-line` span in the Files diff view — that view is removed by the mandated route stub, so the assertion cannot pass). The successor-account **panel component** survives for later re-wiring; C7's rename now has no `app.delta-account.dom.test.tsx` to rename — track-b note.

KEEP: `coverage.tsx`, `symbol-inspector.tsx` (imports confined to Q17 keepers), `code-view.dom.test.tsx`, `code-view.symbol.dom.test.tsx`, `app.scheme.dom.test.tsx`, `app.update-ready.dom.test.tsx`, and everything not listed in this section.

KEEP (trim): `code-view.tsx` (drop `canvas/conversation` + `canvas/logic` wiring; the diff view C6 ports), `app.tsx`, `app/shell.tsx` (gutted to the navigation shell — front door / project detail / context map / settings / direct entry survive; the whole review surface, its canvas state/effects/handlers, and the `DeltaAccountPanel` chrome collapse to the stub route), `app/review-workspace-route.tsx` (STUB — route stays, renders a placeholder), `command/commands.ts`, `index.ts`. (`app.test.tsx` and `app.dom.test.tsx` moved to DELETE above — nothing trimmable survived.)

RENAME *(census, #457)*: `components/delta-account-panel.tsx` → `successor-account-panel.tsx`, `components/delta-account-panel.dom.test.tsx`, `app.delta-account.dom.test.tsx` renamed with it.

### apps/mobile

| File | Verdict |
|---|---|
| `app/daemon/[daemonId]/review/[reviewId]/canvas.tsx` | STUB *(census, Q10)* |
| `src/lib/canvas-rows.ts`, `src/lib/canvas-rows.test.ts` | DELETE *(census)* |

### apps/desktop/src

| File | Verdict |
|---|---|
| `persist-publish-privacy.test.ts` | DELETE *(B2 amendment, cluster 2 — untabled census miss)* — its whole invariant is `reviewCommentsPayload(reviewComments(publishedItems(draft)))`, the publish/staging outbound (`publish.ts`/`staging.ts`) deleted this cluster. Nothing survives to trim; an import of the dead functions cannot compile. The privacy proof re-homes with Track C's rebuilt publish surface |

### packages/instructions — DELETE *(census, whole package)*

All 7 source files (`index.ts`, `index.test.ts`, `ci-classification.test.ts`, `finding-adjudication.test.ts`, `finding-verification.test.ts`, `hypothesis.test.ts`, `ui-verification.test.ts`) plus `package.json`/`project.json`/tsconfig; the exports still imported by surviving code (`FINDING_VERIFICATION_CONTRACT` + verification prompt renderers, `CI_CLASSIFICATION_*`, `NOISE_CONTRACT`, decomposition contracts, `renderLayer`/prompt-layer assembly, `renderConventionLayer`, the `PromptContract` type) are **absorbed into `packages/prompts`** verbatim; the contracts of dead passes (`FINDING_CONTRACT`, `DECISION_CONTRACT`, `ORDERING_CONTRACT`, `ROLLUP_NARRATION_CONTRACT`, `REVIEW_HYPOTHESIS_CONTRACT`, `FINDING_ADJUDICATION_CONTRACT`, `UI_VERIFICATION_CONTRACT` + their renderers) die with them.

### packages/lens-instructions — RENAME → packages/prompts *(census)*

All files carried (`src/index.ts`, `src/index.test.ts`, `prompts/*.md`); `@rennet/lens-instructions` → `@rennet/prompts`, nx project `rennet-lens-instructions` → `rennet-prompts`; the B1-era boundary entries travel: eslint tag `layer:lens-instructions` → `layer:prompts` (gaining `layer:protocol` for the absorbed contracts), `check-boundaries.mjs` entry `@rennet/lens-instructions` → `@rennet/prompts` → `{@rennet/protocol}`; `core`/`adapters`/`server` gain the `prompts` edge that replaces `instructions`.

## Capabilities

### New Capabilities

<!-- None. Delete-first cutover; nothing is built. -->

### Modified Capabilities

<!-- Removed, not modified: the canvas review surface, the six `canvas.*` commands, `review.canvases`, and the model-backed generation passes are deleted ahead of the Board rebuild (B3–B8, C1–C14). The product is deliberately mid-rebuild; `main` stays gate-green. -->

## Impact

- **`packages/protocol`** — canvas surface and state model gone; anchors, patchset, findings, RSP survive.
- **`packages/core`** — nine passes + canvas machinery gone; deterministic producers survive trimmed; `successor-account` rename.
- **`packages/adapters`, `packages/server`** — canvas backends and orchestrator seams gone; server trimmed, still serving projects/reviews/asks.
- **`packages/app-ui`** — canvas workspace and its DOM tests gone; app launches with a stubbed review surface; five canvas modules survive for B5/C4–C6.
- **`apps/mobile`** — canvas route stubbed.
- **`packages/instructions`** — deleted; **`packages/lens-instructions`** → **`packages/prompts`** with survivors absorbed; boundary law (eslint, `check-boundaries.mjs`, CLAUDE.md) rewritten in lockstep.
- **Docs** — `canvas-model.md` deleted (#490 owns the Board replacement), `delta-rereview-and-lineage.md` renamed content, packet-listed + grep-found pages updated.
- **Verification** (packet): `pnpm check` green; `grep -ri "CanvasAngle\|canvas\." packages/ --include="*.ts"` shows no survivors outside the KEEP verdicts; positive control — the verdict tables above diffed against what git actually deleted, and they must match (with any amendment committed alongside its deviation).
