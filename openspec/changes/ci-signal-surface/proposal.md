## Why

A reviewer reading a PR in Rennet today sees nothing of the change's CI. The home-surface smart list already carries a coarse per-PR `ci` facet (`smartListCi`, mapped from GitHub's `statusCheckRollup` in `project-pr-source.ts`), but the review surface itself — where the reviewer actually decides — is CI-blind. Meanwhile a failing check is often the single strongest piece of evidence a review can hold: the change already broke something, and a machine reproduced it. Issue #182 (the intelligence-bar analysis, the Florence + /review-pr bar) asks for that evidence to be pulled in, classified as environmental-vs-change-caused, and surfaced as a review signal that NEVER blocks the review — mirroring the /review-pr "CI never blocks" rule.

The classification is the intelligence, and its failure mode is the dangerous part: a failure wrongly labelled "environmental" hides a real break behind a shrug. So the floor is honesty, not cleverness — when Rennet cannot attribute a failure, it says UNCLASSIFIED and tells the human to look, exactly the anti-rubber-stamp posture of the risk cross-check (#181), with the conservatism pointed the other way (there, false-confirmed hides; here, false-environmental hides).

Rule Zero governs the whole shape: this is a signal the reviewer reads, never a check they must pass. No CI state gates review, sign, or publish; a CI fetch that fails degrades to an honest "CI status unavailable" line and the review proceeds byte-identically.

## What Changes

- **A CI read on the forge seam.** `ForgePort` gains `fetchCiStatus(ref, headOid)` — per-check results for the reviewed PR's PINNED head OID (the patchset already pins `headOid`; checks attach to the commit, so the signal binds to the reviewed code even if the branch has since moved). `GitHubForgeAdapter` implements it via GraphQL over the commit's `statusCheckRollup.contexts` (both `CheckRun` and legacy `StatusContext`), behind the same injected `http` with `X-GitHub-SSO` parsed as everywhere else. Forge-neutral nouns only; no GitHub vocabulary leaks past the adapter.
- **A deterministic classifier with an honest floor.** A pure, $0, model-free function in `core` classifies each failing check: a versioned pattern table of infrastructure signatures (runner lost, timeout waiting, disk space, rate limit, network errors) yields `environmental`; real token/path overlap between the check's name + failure summary and the changeset's changed paths yields `change-caused`; everything else is `unclassified` — surfaced, never guessed away. A deterministic `change-caused` can never be demoted by any later stage (the ratchet points toward visibility).
- **An optional light-model refinement seat.** A new Model Council job (`ci-failure-classification`, light tier — resolving to the Codex light seat when installed, per Table 1) may refine ONLY `unclassified` failures in one batched turn. It draws from the SAME shared review invocation budget — it meters and reports, and on refusal or absence the deterministic verdicts simply stand. It never refuses the review and never overrides a deterministic `change-caused`.
- **Change-caused failures become findings.** Each `change-caused` failure is folded into the Flagged lens as an additive `FindingElement`: anchor = an offered hunk in the implicated changed file (a failure whose anchor cannot resolve stays panel-only — never a hallucinated anchor), evidence = the CI failure summary excerpt, verification chip = `reproduced` with that CI evidence (CI *is* the reproduction; no model turn is spent re-verifying a machine fact).
- **Environmental and unclassified failures become an FYI.** A new `ciSignal` field rides the `FlaggedReview` wire additively (both the `ok` and `failed` branches — the CI facts do not depend on the model runner), carrying every classified failure plus the overall state. The Flagged lens renders a clearly-labelled, collapsible (never hidden-by-default) CI signal panel: environmental failures as "infra, not this change", unclassified as "could not attribute — check yourself", plus the honest positive ("all checks passing") and the honest degradations ("no checks reported", "CI status unavailable — <reason>").
- **Never blocks, structurally.** The fetch + classify path is wrapped so no throw escapes: any failure resolves to `ciSignal: { status: "unavailable", reason }`. No dispatch handler, sign affordance, or publish path reads the CI state to decide anything. Tests prove publish behaviour is byte-identical under passing, failing, and unavailable CI.

## Capabilities

### New Capabilities

- `ci-signal-surface`: the non-blocking CI review signal — pinned-head CI fetch on the forge seam, deterministic env-vs-change classification with an honest UNCLASSIFIED floor, optional budget-metered model refinement, change-caused failures folded into the Flagged lens as evidence-backed findings, environmental/unclassified surfaced as a labelled FYI, and the structural never-blocks guarantee.

### Modified Capabilities

<!-- None. The `ciSignal` field is additive optional on the FlaggedReview wire (existing snapshots and fixtures validate unchanged), and no existing capability's requirements change. -->

## Impact

- **`packages/types`** — new `CiFailureVerdict`, `CiFailure`, `CiSignal` types.
- **`packages/core`** — `forge-port.ts` gains `fetchCiStatus` (+ neutral `ForgeCheckRun`/`ForgeCiStatus` nouns); new `ci-classification.ts` (pure classifier + finding fold helper); `model-council.ts` catalogue gains the `ci-failure-classification` light-tier job (a table edit, per the council doctrine).
- **`packages/protocol`** — `ciSignalSchema` + additive optional `ciSignal` on both `flaggedReviewSchema` branches. This field MUST be declared or the `flagged.review` command boundary strips it silently (the documented Rule-80 failure class the verification chip and crossChecks comments both name); a strip-proof test guards it.
- **`packages/instructions`** — `CI_CLASSIFICATION_CONTRACT`, the refinement seat's prompt contract.
- **`packages/adapters`** — `GitHubForgeAdapter.fetchCiStatus` (GraphQL, injected `http`, SSO parsed); test fakes implementing `ForgePort` gain the method; `flagged-fixture.ts` gains `ciSignal` examples.
- **`packages/ui`** — the `canvas/flagged.ts` fold carries `ciSignal`; `components/flagged.tsx` renders the CI signal panel beside the existing index (reusing the lens — no new lens is built).
- **`apps/desktop/src/main`** — `runFlaggedReviewWithContextFeed` (in `index.ts`) composes fetch → classify → refine → fold, keyed off `review.postTarget` (present exactly on non-retrospective PR reviews); local working-tree reviews carry no `ciSignal` at all (the pre-change shape).
- **Fixtures / dogfood** — synthetic check payloads in tests via the injected `http`; live dogfood only against Rennet's own repository CI. Never a client repository's CI (fixed boundary).

## Out of scope (deferred, named)

- **Re-running CI** — no re-trigger affordance of any kind.
- **Deep log parsing** — classification reads the check name + failure summary/annotation excerpt the forge already serves, never downloads or parses full job logs.
- **verify-ui (#183)** — a separate change.
- **Any CI gate on sign/publish** — permanently out, Rule Zero.
- **Retrospective PR reviews** — they omit `postTarget` today, so they carry no CI signal; threading a read-only PR ref onto retrospective reviews is a named follow-up, not smuggled in here.
- **Base-branch differential runs** ("did this check also fail on main?") — a stronger environmental signal, deferred until the deterministic table proves insufficient.
