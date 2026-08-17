# Design: verify-ui (#183)

## Context

Everything this change needs already exists as a pattern in the codebase; the design is deliberately a fourth verse of an existing song, not a new architecture.

- **Fresh capable verification turn**: `packages/adapters/src/finding-verification-backend.ts` — `createVerificationTurn` opens a new session with the full toolset (shell included, #259), output-constrains it to a schema, and observes `exec` tool calls as independent proof-of-run (paired/ambiguous handling, #268). `coverage-turn-backend.ts` already copies this pattern verbatim; verify-ui is the third copy.
- **Pure core orchestration with injected I/O**: `packages/core/src/finding-verification.ts` — deterministic gate + pure orchestration in core, model and file I/O injected. Same split here.
- **Deterministic versioned classifier**: `classifyNonObvious` / `NON_OBVIOUS_CLASSIFIER_VERSION` — verify-ui's UI-surface classifier follows it.
- **Design intent**: `packages/core/src/patchset-intent.ts` (`patchsetIntentToReviewIntent`) already projects the frozen capture (PR title/body + spec snapshots) for the hypothesis and Decisions passes. Verify-ui consumes the same projection; nothing new is captured.
- **Budget**: `packages/core/src/review-intelligence-budget.ts` — `ReviewIntelligenceBudget` gains `uiVerification: { maxTurns: 1 }`, and the pass draws on the same shared grant the other passes use.
- **Pipeline slot**: `packages/core/src/pipeline.ts` runs finding verification inside the deep-review branch (line ~602); verify-ui runs right after it, before docs are admitted to canvases.
- **Findings machinery**: pipeline already appends a synthesized `finding` doc to `admittedDocs`; verify-ui appends a second one. `FindingElement` (types/index.ts ~1260) is reused unchanged — `verification` chip included.

## Goals / Non-Goals

**Goals**: close the "mount the rendered surface" blind spot for UI-touching changesets; a11y and intent-mismatch observations as dispositionable flags; screenshots the human can see; honest disclosure at every degradation point.

**Non-goals**: pixel diffing, golden screenshots, Figma/design-file ingestion, bundling any rendering or a11y runtime, per-hunk turns, any gate, testing Rennet's own UI (the `packages/ui` DOM suites already do that and are unrelated to this feature).

## Decisions

### 1. One turn per review, not per hunk

The issue says "for hunks that touch UI"; the unit of mounting is a *surface*, not a hunk, and mounting is the expensive step (install, build, serve). One fresh session gets the full list of changed UI files with their hunks and reports per-file-anchored observations. The per-finding verification cap already demonstrated why turn count is the cost ceiling; here the ceiling is 1 (`uiVerification.maxTurns`, default 1 — a knob so the settings registry can raise it later, not a promise to).

### 2. The turn uses what the project affords; absence is a disclosure, not a failure

Rennet cannot know how an arbitrary project renders. The prompt directs the agent, in preference order: existing component/DOM tests it can extend to render the changed component; storybook; the project's dev server plus any installed browser automation (playwright et al.); as a floor, a static markup/DOM review *labelled as static* (no screenshot claimed). A turn that mounts nothing returns the could-not-mount inconclusive with what it attempted. The asymmetry is the same Rule 75/81ak rule finding-verification encodes: could-not-check beats a false clear.

### 3. Observations are findings; the status is a separate additive field

Two outputs, two homes:

- **Observations** (a11y violation, intent mismatch, visual defect) map to `FindingElement`s — anchor = the implicated file (line when the turn can name one), severity mapped from the schema's impact level, `agreement: { kind: "concur", agree: 1, total: 1 }`, `verification: { verdict, evidence }` (`reproduced` when backed by an observed exec + screenshot, `inconclusive` for static-review observations). Appended as one `finding` doc to `admittedDocs`, so lens/disposition/publish/delta-carry are all inherited. No new disposition surface.
- **Status** (`UiVerification` in `@rennet/types`): `{ status: "ran"; screenshots: UiScreenshot[]; observationCount: number; mounted: boolean } | { status: "not-ui" } | { status: "unavailable"; reason: string }` — additive optional on the pipeline result / persisted review snapshot, hand-written Zod in `protocol`. `UiScreenshot` is `{ path: string; label: string }` with `path` relative to the review's evidence directory (portable across `review.load` and machine moves of the store).

### 4. Screenshots persist under the review's store directory

The turn is told to write PNGs into `<review persistence root>/ui-evidence/`; the adapter resolves and creates the directory and passes its absolute path into the prompt. Persistence is free — the directory lives with the review the file-project-store already owns. `.rennet/` stays ignored and unstaged, per the fixed boundary.

### 5. Renderer display via one small read command

A new protocol command `review.uiEvidence` (`{ reviewId, path } → { dataUrl }` or a not-found result) reads a screenshot from the review's evidence directory and returns it base64-encoded; the Flagged lens strip renders `<img src={dataUrl}>` thumbnails. Path resolution is confined to the evidence directory (a path that escapes it is a not-found, which is correctness of the read, not a consent gate). A missing file renders the plain missing-evidence note the spec requires. No `file://` scheme games, no new webPreferences.

### 6. Pipeline wiring and degradation ladder

In `pipeline.ts`, deep-review branch, after finding verification:

1. Classifier over `input.patchset.files` (`UI_SURFACE_CLASSIFIER_VERSION = 1`: extensions `.tsx .jsx .vue .svelte .html .css .scss .less`, plus `.ts`/`.js` under a `renderer/`, `components/`, or `ui/` path segment). No match → status `not-ui`, done.
2. No `uiVerificationConfig` injected (harness absent) → status `unavailable: "verifier unavailable"`, mirroring `markVerificationUnavailable`.
3. Budget grant refused → status `unavailable: "invocation budget exhausted"`.
4. Turn runs → parse schema output; malformed/failed turn → `unavailable` with the turn's reason (never a fabricated clear); ok → findings appended + status `ran`.

Quick review tier: the pass simply does not run and the field is absent — same as every other deep-tier pass.

### 7. What keeps the guard honest (red-first controls)

- A pipeline test with a UI-file patchset and a stub turn asserts the verify-ui finding doc **and** the `ran` status appear — this test fails if the pass is unplugged (the guard-deletion control).
- The transport field-fidelity test asserts `uiVerification` survives IPC (the known silent-strip bug class).
- A DOM test asserts a review without the field renders exactly as today (additive proof), and one asserts a `sign` still resolves with unresolved verify-ui findings present (Rule Zero control).

## Risks / Trade-offs

- **The turn's success is project-dependent.** Accepted: that is the honest shape of the feature. The degradation ladder discloses instead of pretending; the static-review floor still catches markup-level a11y issues.
- **One turn may be thin for a large UI changeset.** Accepted for v1; the cap is a budget knob, and per-finding verification still runs on whatever the flagged lens raised.
- **Screenshot size.** Thumbnails read on demand per image via `review.uiEvidence`, never inlined into the review snapshot, so persisted state and IPC payloads stay small.

## Open Questions

None blocking. Whether the classifier's directory heuristics need per-project tuning is a settings-registry question for after #28 lands, and the knob shape (`uiVerification.maxTurns`) is already compatible with it.
