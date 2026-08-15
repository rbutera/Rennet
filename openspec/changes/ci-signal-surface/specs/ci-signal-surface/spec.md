## ADDED Requirements

### Requirement: CI status is fetched for the reviewed head, on the forge seam

The system SHALL fetch per-check CI results for a PR review through the forge-neutral `ForgePort` (`fetchCiStatus(ref, headOid, signal?)`), keyed by the review's PINNED head OID (`postTarget.headOid`), never by branch name. The fetch SHALL occur only for reviews that carry a `postTarget` (non-retrospective PR reviews); a local working-tree review and a retrospective review SHALL carry no CI signal at all (the pre-change wire shape). SSO `partial-results`, GraphQL partial errors, and a paginated first-100 result SHALL surface as an `incomplete` marker, never as a complete-looking check set.

#### Scenario: The signal binds to the reviewed commit

- **WHEN** a PR review's branch has received a newer push since the review pinned its head OID
- **THEN** the CI signal reports the checks of the PINNED head — the code actually under review — not the newer head's

#### Scenario: A local review carries no CI signal

- **WHEN** a working-tree review (no `postTarget`) runs the flagged review
- **THEN** the delivered `FlaggedReview` has no `ciSignal` field, byte-identical to the pre-change shape

#### Scenario: A truncated check set is never complete

- **WHEN** the CI fetch returns with SSO `partial-results`
- **THEN** the signal carries `incomplete: true` and the surface renders the partial-results caveat

### Requirement: Deterministic classification with an honest UNCLASSIFIED floor

The system SHALL classify each failing check deterministically ($0, no model turn): a real token/path overlap with changed paths SHALL win as `change-caused`; `environmental` SHALL require a narrow, versioned, infrastructure-contextualised machinery signature; and everything else SHALL be `unclassified`. Bare application error codes and domain-oriented check names SHALL NOT prove infrastructure. Uncertainty SHALL NEVER resolve to `environmental`.

#### Scenario: An infra signature is environmental

- **WHEN** a check fails with "The runner has lost communication with the server"
- **THEN** the failure is classified `environmental` and surfaces as an FYI, not a finding

#### Scenario: Path overlap is change-caused

- **WHEN** the changeset touches `packages/core/src/pipeline.ts` and the failing check's summary names `pipeline.ts` (or the failing target is `core:test`)
- **THEN** the failure is classified `change-caused`

#### Scenario: Uncertainty is visible, never hidden

- **WHEN** a check fails with a summary matching neither the infrastructure table nor any changed path
- **THEN** the failure is `unclassified` — surfaced as an FYI that says attribution is unknown — and is NOT labelled `environmental`

### Requirement: Change-caused failures become evidence-backed findings

The system SHALL fold each `change-caused` CI failure into the Flagged lens as an additive finding: a deterministically minted `findingId`, an anchor resolved against the OFFERED hunk manifest in an implicated changed file, severity `high`, honest single-judge agreement (`concur 1/1`), and a verification chip `reproduced` whose evidence is the CI failure summary excerpt — CI itself is the reproduction, and the verification pass SHALL NOT spend a model turn re-verifying it. A change-caused failure whose implicated paths resolve to no offered hunk SHALL remain in the signal panel only — the system SHALL never emit a finding with an unresolvable anchor.

Stable forge check identity SHALL distinguish same-named checks in finding IDs and panel rows. The signal SHALL carry whether a change-caused failure actually folded; only placed failures may be omitted from the panel body.

#### Scenario: A change-caused failure is a finding with CI evidence

- **WHEN** a change-caused CI failure implicates a changed file present in the offered hunk manifest
- **THEN** the flagged review gains a finding anchored in that file, carrying the CI excerpt as `reproduced` verification evidence

#### Scenario: No hallucinated anchors from the deterministic side

- **WHEN** a change-caused failure implicates only paths with no offered hunk
- **THEN** no finding is emitted for it; the failure still appears, with its verdict, in the CI signal

### Requirement: Environmental and unclassified failures surface as a non-finding FYI

The system SHALL deliver every classified failure on a `ciSignal` field riding the `FlaggedReview` wire additively (on BOTH the `ok` and `failed` branches), declared in the protocol Zod schema so the command boundary cannot silently strip it. The surface SHALL render environmental and unclassified failures as a clearly-labelled signal panel — collapsible as noise, expanded by default, never auto-hidden while failures exist — and SHALL keep "all checks passing", "no checks reported", and "CI status unavailable" as three distinct, non-conflatable states.

#### Scenario: The wire field survives the boundary

- **WHEN** an `ok` flagged review with a populated `ciSignal` crosses the `flagged.review` command boundary
- **THEN** the field arrives byte-identical in the renderer — proven by a strip-proof round-trip test that fires if the schema drops the declaration

#### Scenario: A failed model review still carries the FYI

- **WHEN** the model finding runner fails but the CI fetch succeeded with a red check
- **THEN** the `failed` flagged review still carries `ciSignal`, and the panel renders beside the failure message

#### Scenario: Three nothings, three sentences

- **WHEN** the signal is respectively all-passing, no-checks-reported, and unavailable
- **THEN** the panel renders three different messages — passing is never implied from "no checks", and "unavailable" is never rendered as an absence

### Requirement: The CI signal never blocks anything

The CI signal SHALL be purely informational. No CI state SHALL gate, delay, or add any step to review, sign, or publish. Fetch and refinement SHALL have separate abortable deadlines: a thrown or hung fetch degrades to `unavailable`; a thrown or hung refinement retains deterministic verdicts. An incomplete, truncated, empty, or neutral-only check set SHALL never be labelled passing.

#### Scenario: A dead forge degrades honestly

- **WHEN** `fetchCiStatus` throws (network down, token invalid)
- **THEN** the flagged review completes with `ciSignal.status = "unavailable"` and its findings exactly as the model seats produced them

#### Scenario: Publish is invariant under CI state

- **WHEN** the same review is published under CI passing, CI failing, and CI unavailable
- **THEN** the publish dispatch behaviour is byte-identical in all three — proven by an invariance test that fires if any publish path consults `ciSignal`

### Requirement: Model refinement meters on the shared budget and never refuses the review

When a light-model refinement seat is available (the `ci-failure-classification` council job), the system SHALL refine ONLY `unclassified` failures to `change-caused`, or leave them `unclassified`, in one batched turn drawing from the SAME shared per-review invocation budget. A model-returned `environmental` SHALL never be adopted. On refusal, absence, timeout, or invalid output, deterministic verdicts SHALL stand and the review SHALL complete.

#### Scenario: Budget refusal degrades the refinement, not the signal

- **WHEN** the shared invocation budget is exhausted before the refinement turn
- **THEN** the turn is refused, every failure keeps its deterministic verdict, and the review completes with the full CI signal

#### Scenario: The ratchet holds against the model

- **WHEN** the refinement turn returns `environmental` for a failure the deterministic classifier marked `change-caused`
- **THEN** the deterministic `change-caused` verdict stands

### Requirement: Fixtures and dogfood stay inside the boundary

All CI-signal tests SHALL run against synthetic check payloads through the injected HTTP seam — no network in tests. Live dogfood SHALL use only Rennet's own repository CI. The system SHALL never read a client repository's CI, code, or infrastructure for development, fixtures, or calibration.

#### Scenario: Tests never touch a real forge

- **WHEN** the adapter and classifier test suites run
- **THEN** every CI payload is synthetic, served through the injected `HttpFetch`, with no network egress
