## 1. Wire first: types + protocol (layer:types, layer:protocol)

- [ ] 1.1 In `packages/types`, add `CiFailureVerdict` (`"change-caused" | "environmental" | "unclassified"`), `CiFailure { checkName, verdict, evidence, implicatedPaths, detailsUrl?, classifiedBy }`, and the `CiSignal` union (`checked` with `overall`/`failures`/`headOid`/`incomplete`, `no-checks`, `unavailable`). Doc-comment the honest-floor semantics on the verdict type.
- [ ] 1.2 In `packages/protocol`, hand-write `ciFailureVerdictSchema`, `ciFailureSchema` (via `objectSchemaFor<CiFailure>()`), and `ciSignalSchema`, and add `ciSignal: ciSignalSchema.optional()` to BOTH `flaggedReviewSchema` branches with the Rule-80 "declare it or the boundary strips it" comment (mirror the #179/#181 comments). Round-trip tests for every `CiSignal` variant.
- [ ] 1.3 Strip-proof test: build an `ok` flagged review with a populated `ciSignal`, parse through `flaggedReviewSchema`, assert the field survives byte-identically; same for the `failed` branch. Red-proof: remove `ciSignal` from the schema and watch this test fire (the silent-strip failure class, proven not assumed).

## 2. Core: the deterministic classifier (layer:core, $0, no I/O)

- [ ] 2.1 Add `packages/core/src/ci-classification.ts` with `classifyCiFailures(checks, changedPaths)`: (1) the versioned environmental signature table (runner-lost, timed-out-waiting, disk space, rate limit, ECONNRESET/ETIMEDOUT/DNS, artifact-infra, concurrency-cancelled — machinery-only, a test-suite timeout does NOT qualify); (2) change-caused by real path/segment/stem/project-name token overlap (the conservative-overlap spirit of `risk-crosscheck.ts`, no stopword matches); (3) everything else `unclassified`. Unit-test each verdict class with realistic check names/summaries.
- [ ] 2.2 Pin the honest floor: a failure matching neither table nor overlap is `unclassified`, never `environmental`. Red-proof: default uncertain failures to `environmental` and watch the "uncertain is visible" test fire — this is the change's core honesty invariant.
- [ ] 2.3 Pin the ratchet: no input ordering or later transform demotes a deterministic `change-caused`. Test that the classifier's verdicts are stable under check reordering.
- [ ] 2.4 Add the finding fold helper `ciFindingsFor(failures, manifest, patchsetId)`: change-caused failures → `FindingElement`s with deterministic `findingId` from `(patchsetId, checkName)`, anchor resolved against the OFFERED hunk manifest, `severity: "high"`, `agreement: concur 1/1`, `verification: { verdict: "reproduced", evidence: "CI: …" }`. A failure with no resolvable offered-hunk anchor produces NO finding (panel-only). Red-proof: let an unresolvable anchor through and watch the hallucinated-location test fire.

## 3. The forge seam: `fetchCiStatus` (layer:core interface, layer:adapters impl)

- [ ] 3.1 In `packages/core/src/forge-port.ts`, add the forge-neutral `ForgeCheckRun { name, outcome, summary, detailsUrl? }` / `ForgeCiStatus { checks, sso }` nouns and the `fetchCiStatus(ref, headOid)` method on `ForgePort`. Update every in-repo `ForgePort` fake/double to implement it (a throwing default is fine where CI is untouched).
- [ ] 3.2 In `packages/adapters/src/github-forge.ts`, implement `fetchCiStatus` with one GraphQL query on `repository.object(oid) … statusCheckRollup.contexts` mapping BOTH `CheckRun` (status/conclusion → outcome) and legacy `StatusContext` (state → outcome) nodes; queued/in-progress/EXPECTED → `pending`, ERROR is a failure (the `mapCi` precedent). Parse `X-GitHub-SSO` on the response like every other call. Tests via injected `HttpFetch` with synthetic payloads only — no network, never a client repo's CI.
- [ ] 3.3 Test the honest edges: a commit with NO checks (null rollup / empty contexts) → empty `checks` (the caller's `no-checks` state, never implied-passing); an SSO `partial-results` response carries `sso` out so the caller can stamp `incomplete: true`.

## 4. Council + instructions: the optional refinement seat (layer:core, layer:instructions)

- [ ] 4.1 In `packages/core/src/model-council.ts`, add the `ci-failure-classification` job to the versioned catalogue (light tier, batched, not a session rider) and its rows in the three availability tables — a table edit per the council doctrine, resolving to the Codex light seat when both harnesses are installed.
- [ ] 4.2 In `packages/instructions`, add `CI_CLASSIFICATION_CONTRACT`: one batched turn over ONLY the `unclassified` failures (name + summary + changed-path list), returning per-failure verdicts. Schema-constrain the output; an invalid body is a failed turn, never a partial adoption.
- [ ] 4.3 Wire the refinement in core: refined verdicts stamp `classifiedBy: "model"`; a model may resolve `unclassified` → `change-caused`/`environmental` but NEVER touches a deterministic verdict. Red-proof: let the model demote a deterministic `change-caused` and watch the ratchet test fire.
- [ ] 4.4 Budget tests: the refinement turn draws from the shared review invocation budget and is REFUSED (deterministic verdicts stand, review completes) when the ceiling is exhausted — it meters and reports, never blocks. Test both the metered-spend and the refusal-degradation paths.

## 5. Main composition: fetch → classify → fold, never-throw (app:desktop)

- [ ] 5.1 In `apps/desktop/src/main/index.ts` `runFlaggedReviewWithContextFeed`, after the verification pass and risk cross-check: when `review.postTarget` is present, build the forge adapter from the existing auth ladder, `fetchCiStatus(postTarget → ref, postTarget.headOid)`, classify against the active patchset's changed paths, optionally refine, append `ciFindingsFor(...)` to the findings, and attach `ciSignal`. No `postTarget` → no `ciSignal` field at all (pre-change shape; local and retrospective reviews unchanged).
- [ ] 5.2 Wrap the entire CI block so NO throw escapes: network/auth/malformed-payload/timeout each resolve to `ciSignal: { status: "unavailable", reason }` with the model findings returned untouched. Red-proof: let `fetchCiStatus` throw through and watch the "CI failure never fails the review" test fire.
- [ ] 5.3 Attach `ciSignal` to the `failed` flagged branch too (a failed model review with red CI still carries the FYI), and confirm the verification pass never runs on CI-derived findings (they arrive pre-chipped, post-verification).
- [ ] 5.4 The never-blocks invariance proof: publish/sign dispatch behaviour is byte-identical under `ciSignal` passing, failing, and unavailable — no handler reads CI state. Red-proof: make `publish.review` consult `ciSignal` and watch the invariance test fire. (Rule Zero, as a test.)

## 6. UI: the CI signal panel on the Flagged lens (layer:ui)

- [ ] 6.1 Carry `ciSignal` through the fold in `packages/ui/src/canvas/flagged.ts` into the flagged index (types/protocol imports only — the ui boundary).
- [ ] 6.2 Add `CiSignalPanel` in `packages/ui/src/components/flagged.tsx` beside `DualBadge`, above the rows: environmental lines labelled "environmental (infra)", unclassified lines with the "Rennet could not attribute this — check it yourself" copy, the change-caused COUNT pointing at the finding rows (no duplication), the quiet all-passing line, the `incomplete` partial-results caveat, "no CI checks reported", and "CI status unavailable — <reason>". Collapsible, expanded by default, never auto-hidden while failures exist.
- [ ] 6.3 DOM tests: each state renders its DISTINCT sentence — passing, no-checks, unavailable, and absent (no panel) are four different surfaces, never conflated (the lens's "two nothings" law extended). Red-proof: collapse no-checks into the passing line and watch the distinctness test fire.
- [ ] 6.4 Update `packages/adapters/src/flagged-fixture.ts` with `ciSignal` examples covering the panel states, so the fixture path exercises the UI without a forge.

## 7. Gate, reconcile, hand off

- [ ] 7.1 Run the full gate `NX_DAEMON=false pnpm check`; confirm exit 0 with a positive control capable of failing (re-run one red-proof from 1.3/2.2/5.2 to prove the suite can fire). Reconcile the whole-suite test total against the pre-change baseline — verify the number, do not trust memory.
- [ ] 7.2 Commit per-group with descriptive messages, push, verify the push landed (`git rev-parse origin/<branch>` equals local HEAD). Report the tip, the counted whole-branch diff, the gate total, and the named deferrals (re-run CI, deep log parsing, #183 verify-ui, retrospective-review CI, base-branch differential). Do NOT self-review; the orchestrator owns the gate. On merge, archive this OpenSpec change on the real outcome.
