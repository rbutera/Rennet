# Tasks — Review Intelligence Core

This change is DESIGN ONLY. The tasks below scope the eventual build; none are implemented here. They are ordered by dependency (types → protocol → instructions → core → adapters → ui → pipeline) so the boundary graph stays acyclic.

## 0. Rai decisions (gate the build)

- [ ] 0.1 Confirm the hypothesis-first UX: reading frame BEFORE the lenses (soft gate) vs. collapsible panel alongside
- [ ] 0.2 Confirm always-on vs opt-in: hypothesis always-on; dual-model + verification behind a "deep review" toggle (or a different split)
- [ ] 0.3 Confirm dual-model scope: Flagged lens only vs. all three lenses
- [ ] 0.4 Confirm the verification cap `maxVerifications`, the inconclusive policy (surface-with-caveat vs. drop), and the non-obvious classifier rule set
- [ ] 0.5 Confirm the total per-review turn ceiling (and a "quick review" lower value)
- [ ] 0.6 Confirm the genuine-prior decision: hypothesis sees intent + structure + repo context, NOT full hunk bodies

## 1. Shared types (types)

- [ ] 1.1 Add `ReviewIntent` (prTitle/prBody/spec), widening the live `DecisionIntent` seam
- [ ] 1.2 Add `ReviewHypothesisBody` + `HypothesisRisk` (riskId, statement, severity, disconfirmer) and the `ReviewHypothesis` envelope alias
- [ ] 1.3 Add `RiskCrossCheck` (riskId, status confirmed|open, findingIds)
- [ ] 1.4 Add `FindingVerification` (verdict reproduced|refuted|inconclusive, evidence) and the optional `FindingElement.verification`
- [ ] 1.5 Add the dual-model result shapes (per-seat result pair + reconcile output), reusing `FindingAgreement`/`FindingModelAnswer`

## 2. Protocol (rsp-validator)

- [ ] 2.1 Add `review.hypothesis` to `RSP_DOC_TYPES` and `DOC_TYPE_REGISTRY` (atomic)
- [ ] 2.2 Add the `review.hypothesis` body schema + rules in `bodies.ts` (domain non-empty, scope in/out, design, risks bounded 5–10, per-risk severity vocabulary + non-empty disconfirmer); dispatch from `validateDocument`
- [ ] 2.3 Widen the `finding` body schema to accept the optional `verification` field; keep itemwise admission + grounding unchanged
- [ ] 2.4 Add `bodyJsonSchema` projections for the new/changed bodies (structured-output constraint)

## 3. Prompt contracts (instructions)

- [ ] 3.1 Author `REVIEW_HYPOTHESIS_CONTRACT` (seven-slot; EMIT `review.hypothesis`; ORDERING = logical/first-principles; FAILURE VALVE = honest-null), register in `CONTRACTS`
- [ ] 3.2 Author `FINDING_VERIFICATION_CONTRACT` (reproduce-or-refute; verdict + one-line evidence; refuse to guess)
- [ ] 3.3 Amend the three lens contracts' instruction slots (versioned) to consume the hypothesis layer as disconfirmation criteria
- [ ] 3.4 Ensure `assemblePrompt` renders the hypothesis as a labelled layer after base, before payload, base never truncated

## 4. Core intelligence modules (core, node-free)

- [ ] 4.1 `hypothesis-generation.ts` → `runHypothesisPass` (manifest + intent + repoContext + structure → admitted `review.hypothesis`, retry, honest `failed`); a compact `HypothesisRepoContext` projection built from `ProjectMap`/`FileContext`
- [ ] 4.2 Add optional `hypothesis` input to `runFindingAngle`/`runDecisionAngle`/`runNoiseAngle` and render it as the disconfirmation layer
- [ ] 4.3 `risk-crosscheck.ts` → `crossCheckRisks(hypothesis, findings)` (deterministic; predicted-and-found vs predicted-but-unflagged)
- [ ] 4.4 `finding-reconcile.ts` → `reconcileFindings(seatA, seatB, labels)` (concur match / solo → disagree / conflict → disagree; never a merged summary)
- [ ] 4.5 `finding-verification.ts` → `classifyNonObvious` + `runFindingVerification` (fresh session, real file content, verdict + evidence; drop/surface/caveat; cap + batching)

## 5. Adapters (store + model I/O)

- [ ] 5.1 Second seat executor for dual-model via the existing `createCodexRunTurn` port; provider→harness follows the resolved model
- [ ] 5.2 Feed `runHypothesisPass` the ProjectSnapshot projection through `ProjectContextReader`/`context.map`; keep `core` node-free
- [ ] 5.3 Feed `runFindingVerification` real file content through `context.file`; a fresh session per verification (default a different seat)

## 6. Pipeline wiring (core)

- [ ] 6.1 Extend `ReviewPipelineInput`/`Result` with hypothesis, cross-checks, dual-model config, and verification config
- [ ] 6.2 Sequence in `buildReviewCanvases`: hypothesis pass → dual-model lens runs (`resolveDualSeat`) → reconcile → verification → cross-check, all drawing from the ONE shared `InvocationBudget`
- [ ] 6.3 A per-review `ReviewIntelligenceBudget` over one `createInvocationBudget` counter (sub-ceilings for hypothesis/dual/verification); fail-closed on absence
- [ ] 6.4 Honest degradation paths: no hypothesis, single-provider, unverified-caveat — each on a budget refusal or a missing provider

## 7. Reading surface (ui, host-free)

- [ ] 7.1 `canvas/hypothesis.ts` → `buildHypothesisFrame(hypothesis, crossChecks)` (domain/scope/design/risks + confirmed|open + jump anchors)
- [ ] 7.2 `components/hypothesis.tsx` per the confirmed UX (frame vs panel)
- [ ] 7.3 Reuse `buildFlaggedIndex` for disagreement + render the verification evidence chip at the finding's anchor

## 8. Tests + gates

- [ ] 8.1 Hermetic FakeSession suites: hypothesis (admit/reject-retry/failed), reconcile (concur/solo/conflict/no-synthesis), cross-check (found/open), classifier (both directions), verification (reproduced/refuted/inconclusive)
- [ ] 8.2 Protocol: one fixture per new `review.hypothesis` rule both directions; `finding` with `verification` admits; grounding/anchor guarantees stay green
- [ ] 8.3 Red-then-green invariants: reconcile never merges; a refuted finding never reaches the index; an absent budget refuses every new-stage turn
- [ ] 8.4 UI: `buildHypothesisFrame` host-free tests; Flagged disagreement + chip through the existing DOM tests
- [ ] 8.5 Gated real-turn E2E (`RENNET_LIVE_CLAUDE` + a Codex seat) for one tiny dual-model+verified review; excluded from the default gate
- [ ] 8.6 Full `pnpm check` green (format, boundaries, licenses, lint, typecheck, test, build); no new dependency arrows
