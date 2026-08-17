# verify-ui for UI hunks: mount, screenshot, a11y (#183)

## Why

The first blind dogfood scored zero of six known defects, and the analysis traced five of the six misses to capabilities the review loop lacks: **mount the rendered surface, mutate and observe** (Rennet Review Blind Spots, 2026-08-12). The reproduce-or-refute verification pass (#179/#259) closed that gap for *code* claims — a fresh capable session that runs the tests. Nothing in the live pipeline can see a *pixel*: a changeset that breaks layout, contradicts the stated design intent, or ships an inaccessible control sails through every lens, because every lens reads text. Issue #183 (wave 10, independent deferred-tier item) asks for exactly this step: for changesets that touch UI, render the change, compare it against the design intent, and run an a11y check.

The survey behind this proposal confirmed the gap is real and narrow. Since the intelligence-bar analysis, the pipeline has grown hypothesis-first review, dual-model findings, per-finding verification with a working shell, CI classification, and risk cross-check — every other **LACK** row of the bar. `grep` finds no a11y, screenshot, or UI-mount capability anywhere in `packages/{types,protocol,core}` (2026-08-17). The DOM test suites in `packages/ui` test *Rennet's own* renderer; they do nothing for the *user's changeset under review*, which is what #183 is about.

## What Changes

- **A deterministic UI-surface classifier** (versioned, zero model spend) decides whether a changeset touches UI at all — by file path and extension, the same shape as `classifyNonObvious`. No UI files, no turn, no noise.
- **One verify-ui turn per review** (deep review tier only, consuming the shared invocation budget) opens a fresh capable harness session — the exact `createVerificationTurn` pattern, full toolset including shell, exec calls observed as proof-of-run — and asks it to mount the changed surface with whatever the project affords (existing component tests, storybook, a dev server, playwright if installed), capture screenshots into the review's evidence directory, run an a11y check with the tooling the project has, and compare what rendered against the review's design intent (the frozen `PatchsetIntent` projected through `patchsetIntentToReviewIntent` — PR title/body plus spec snapshots).
- **Observations land as ordinary findings.** Each verify-ui observation becomes a `FindingElement` (validated against the classified UI files, anchored to the containing or nearest reported-line hunk, severity-mapped, evidence chip attached). Desktop MAIN folds them into the live `FlaggedReview` with `applyUiVerification`, so the Flagged lens, span dispositions, collation draft, publish, and delta carry all work on them with zero new disposition machinery.
- **An honest additive status** (`pending` while the late pass runs / `ran` with screenshot paths / `not-ui` / `unavailable` with reason, carrying the classifier version) rides the successful (`ok`) `FlaggedReview` branch. Could-not-mount is disclosed as inconclusive, never silently dropped and never reported as an all-clear (the Rule 75/81ak asymmetry the verification pass already obeys). A failed base review has no findings surface, so verify-ui is scoped out there. The status never feeds any gate (Rule Zero).
- **The Flagged lens shows the evidence**: a small verify-ui strip with captured screenshots inline (read through a new evidence-image protocol command) when the pass ran, one honest line when it could not, and qualified empty copy while it is pending or unavailable. Evidence is transient like the Flagged review itself: every open eagerly reruns the review, while patchset/run namespaces and bounded retention prevent stale-turn overwrites and unbounded growth.

**Explicitly out of scope** (so nobody folds them in):

- A pixel-diff engine, golden-screenshot store, or design-file (Figma) integration. Design intent is the intent Rennet already captures — PR body and spec snapshots — nothing new is ingested.
- Bundling a browser, playwright, axe, or any rendering runtime with Rennet. The turn uses what the *user's project* affords and reports honestly when it affords nothing.
- Per-hunk turns. One turn per review covers the changeset's UI files; the per-finding verification cap pattern already showed why turn-count must be bounded.
- Any gate: verify-ui findings and status never block sign or publish.

## Capabilities

### New Capabilities

- `ui-verification`: the deterministic UI-surface classifier; the single budget-bounded verify-ui turn (mount, screenshot, a11y, intent comparison); observations folded into anchored findings with evidence chips; the honest pending/ran/not-ui/unavailable status and its could-not-mount asymmetry; bounded namespaced evidence and the confined evidence-image read; the Flagged-lens strip.

### Modified Capabilities

<!-- None. live-review-pipeline's promoted requirements govern canvas construction and
     are additively extended in behavior, not changed: an absent uiVerification field
     validates and renders exactly as today. The intelligence passes (hypothesis,
     dual-model, finding verification) were never promoted as their own capability
     specs; ui-verification follows finding-verification's architecture as precedent,
     not as a spec delta. -->

## Impact

- **`packages/types`** — additive `UiVerification` status type and the observation shape; `FindingElement` is reused unchanged.
- **`packages/protocol`** — Zod schema for the additive field (transport must not strip it — the IPC field-fidelity bug class); a small evidence-image read command for the renderer's screenshot display.
- **`packages/core`** — the versioned classifier; the pure `runUiVerification` orchestration (required shared budget, injected evidence inspection, method/exec/file reconciliation, honest degradation); `ReviewIntelligenceBudget` gains `uiVerification.maxTurns`.
- **`packages/adapters`** — `createUiVerificationTurn` mirroring `createVerificationTurn` (fresh capable session, output-schema-constrained, exec observation); canonical confined evidence inspection/read; patchset/run namespaces and bounded retention under app user data.
- **`packages/ui` + `apps/desktop`** — `runFlaggedReviewWithContextFeed` schedules the pass on the non-blocking late-enrichment channel; `applyUiVerification` composes the completed result; the transient schedule bit drives polling for all-concur and zero-row reviews; the Flagged-lens strip renders honest pending/unavailable/ran states.
- **Docs (same change)** — delivery-order wave-10 entry; the user-journey page's review-intelligence description gains the verify-ui step.
