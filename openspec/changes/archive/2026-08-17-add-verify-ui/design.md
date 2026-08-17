# Design: verify-ui (#183)

## Context

Everything this change needs already exists as a pattern in the codebase; the design is deliberately a fourth verse of an existing song, not a new architecture.

- **Fresh capable verification turn**: `packages/adapters/src/finding-verification-backend.ts` — `createVerificationTurn` opens a new session with the full toolset (shell included, #259), output-constrains it to a schema, and observes `exec` tool calls as independent proof-of-run (paired/ambiguous handling, #268). `coverage-turn-backend.ts` already copies this pattern verbatim; verify-ui is the third copy.
- **Pure core orchestration with injected I/O**: `packages/core/src/finding-verification.ts` — deterministic gate + pure orchestration in core, model and file I/O injected. Same split here.
- **Deterministic versioned classifier**: `classifyNonObvious` / `NON_OBVIOUS_CLASSIFIER_VERSION` — verify-ui's UI-surface classifier follows it.
- **Design intent**: `packages/core/src/patchset-intent.ts` (`patchsetIntentToReviewIntent`) already projects the frozen capture (PR title/body + spec snapshots) for the hypothesis and Decisions passes. Verify-ui consumes the same projection; nothing new is captured.
- **Budget**: `packages/core/src/review-intelligence-budget.ts` — `ReviewIntelligenceBudget` gains `uiVerification: { maxTurns: 1 }`, and the pass draws on the same shared grant the other passes use.
- **Live Flagged slot**: `apps/desktop/src/main/index.ts` owns `runFlaggedReviewWithContextFeed`; after finding verification, risk cross-check, CI, and blocking-state stamping it classifies the patchset, stamps the immediate verify-ui state, and schedules the slow pass on the existing late-enrichment channel.
- **Findings machinery**: `apps/desktop/src/main/flagged-ui-verification.ts` exposes `applyUiVerification`, which appends verify-ui observations to the same `FlaggedReview.findings` array and stamps the status. `FindingElement` is reused unchanged — `verification` chip included.

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
- **Status** (`UiVerification` in `@rennet/types`): pending / ran / not-ui / unavailable, each carrying `classifierVersion`; `ran` adds screenshots, observation count, and the reconciled `mounted` fact. It is additive optional on the successful (`ok`) `FlaggedReview` branch with hand-written Zod in `protocol`. `UiScreenshot` is `{ path, label }`, where `path` includes the completed patchset/run namespace relative to the review evidence directory.

Verify-ui is scoped to `ok` results: the failed branch carries no findings, so it gains no verify-ui schema field, status, or renderer test.

### 4. Screenshots use isolated patchset/run namespaces with bounded retention

The turn writes into `<userData>/ui-evidence/<review-key>/<patchset-key>/<run-key>/`. Only the namespace bound to the completed enrichment is exposed in screenshot references, so a slow stale patchset or superseded run cannot overwrite the bytes a newer result renders. When the newest run for a patchset completes, it deletes superseded sibling runs; opportunistic pruning retains at most four completed patchset namespaces per review while protecting active runs. `.rennet/` stays ignored and unstaged.

Persisting a verify-ui manifest/status with the review is deliberately declined, following the wave-7 transient-state precedent. `FlaggedReview` is transient: CI signal and `blockingStates` have the same lifecycle, and the recorded #158 MVP settle eagerly reruns the review on open. Screenshot files persist per run until bounded retention prunes them, but reopening recomputes the status and current references instead of remounting a prior run. Reusing an old namespace would require durable metadata to identify and certify it, so it is not a cheap reuse and no persistence layer is introduced. Making only verify-ui durable would create a conflicting lifecycle and stale evidence/status beside freshly recomputed findings. Namespacing plus retention fixes the real concern — stale overwrites and unbounded screenshot growth.

### 5. Renderer display via one small read command

A new protocol command `review.uiEvidence` reads one screenshot and returns a byte-bounded data URL, `not-found`, or `oversized`. The adapter realpath-canonicalizes the review directory and resolved file, requires a regular file whose real path stays beneath that directory, stats before reading, and caps a screenshot at 8 MiB. The core retains at most 12 screenshot references per run. A missing, escaping, symlinked-out, or oversized file degrades honestly; no `file://` scheme games and no new webPreferences.

### 6. Live late-enrichment wiring and degradation ladder

In `runFlaggedReviewWithContextFeed`, after the immediate Flagged review is otherwise complete:

1. Classifier over the active patchset files. No match → immediate `not-ui`, no turn.
2. UI-touching deep review with no adapter → immediate `unavailable("verifier unavailable")`.
3. UI-touching deep review with an adapter → immediate `pending` plus `lateEnrichmentScheduled: true`; `flagged.review` returns without awaiting the turn.
4. `composeFlaggedLateEnrichment` starts verify-ui independently of adjudication, composes the eventual result with `applyUiVerification`, and clears the transient schedule bit. The renderer polls whenever the response says enrichment was scheduled, including all-concur and zero-row reviews.
5. The required shared budget refuses excess spend as `unavailable`. A structured mount is certified only when its method agrees with a successful mount-relevant observed exec and at least one confined screenshot actually exists; every mismatch degrades to a labelled static review. Observations are accepted only for classified UI files and anchor to the containing or nearest reported-line hunk.

Quick review tier: the pass simply does not run and the field is absent — same as every other deep-tier pass.

### 7. What keeps the guard honest (red-first controls)

- An injectable late-enrichment composer test drives a deferred verify-ui result: the all-concur immediate review resolves first with its schedule signal, then the completed observations/status reach the renderer through the late channel.
- The transport field-fidelity test asserts `uiVerification` survives IPC (the known silent-strip bug class).
- DOM tests assert a review without the field renders exactly as today, pending/unavailable empty results never claim a full all-clear, and the real sign-resolution plus publish command paths proceed identically for pending and unavailable verify-ui states (Rule Zero control).

## Risks / Trade-offs

- **The turn's success is project-dependent.** Accepted: that is the honest shape of the feature. The degradation ladder discloses instead of pretending; the static-review floor still catches markup-level a11y issues.
- **One turn may be thin for a large UI changeset.** Accepted for v1; the cap is a budget knob, and per-finding verification still runs on whatever the flagged lens raised.
- **Screenshot size and growth.** Reads are capped at 8 MiB, data URLs have a protocol maximum, each run keeps at most 12 references, and retention keeps at most four completed patchset namespaces per review.

## Open Questions

None blocking. Whether the classifier's directory heuristics need per-project tuning is a settings-registry question for after #28 lands, and the knob shape (`uiVerification.maxTurns`) is already compatible with it.
