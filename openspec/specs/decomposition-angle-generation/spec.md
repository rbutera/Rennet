# decomposition-angle-generation Specification

## Purpose
TBD - created by archiving change build-decomposition-angle-generation. Update Purpose after archive.
## Requirements
### Requirement: The offered manifest is the deterministic hunk substrate an agent may cite
`buildOfferedManifest` SHALL derive, from a floor decomposition and its patchset, a manifest whose occurrences are exactly the decomposition's hunks (kind `hunk`), each carrying its added, deleted, and context line text so spans and quotes resolve. The manifest SHALL be the fingerprint the document's `inputDigest` is computed against.

#### Scenario: Every hunk becomes one offered occurrence
- **WHEN** a manifest is built from a decomposition with N hunks
- **THEN** it has exactly N occurrences of kind `hunk`, one per hunk id, and `computeInputDigest` over it is stable across two runs

### Requirement: The route plan refuses an over-budget decomposition before any model runs
`buildRoutePlan` SHALL return the ordered planned invocations for initial decomposition — one heavy skeleton call, one heavy proposal call, and light rationale calls batched at no more than ten chunks per call — and SHALL count harness invocations. When the count exceeds `maxHarnessInvocations` (default five), it SHALL return a refusal rather than a plan.

#### Scenario: A large decomposition stays within budget
- **WHEN** a plan is built for a decomposition with many chunks
- **THEN** the harness-invocation count does not exceed five and the plan is returned

#### Scenario: A seeded sixth invocation is refused
- **WHEN** a plan is built with a budget that the invocations exceed
- **THEN** the result is a refusal that names the count and the limit, and no plan is produced

### Requirement: The deterministic floor is the always-present decomposition fallback
`deterministicProposalBody` SHALL project a floor decomposition's chunks, edges, reading order, and residue into a `decomposition.proposal` body that the validator admits, so a terminal model failure leaves a valid, offline-produced decomposition rather than an empty surface.

#### Scenario: The floor projects to an admitted proposal
- **WHEN** a proposal body is built deterministically from a floor decomposition and validated
- **THEN** the document is admitted with no errors

### Requirement: Generation stamps the trustworthy envelope and retries a rejected body
`runDecompositionAngle` SHALL assemble the contract prompt, drive an injected harness session, and build the RSP envelope around the agent's emitted body — minting the `docId` and stamping provenance including `inputDigest` — before validating. On rejection it SHALL build a machine-readable `validation.report`, retry in the same session up to twice sharing the budget, and on terminal failure SHALL fall back to the deterministic floor body with a provenance route recording the fallback.

#### Scenario: A valid body is admitted on the first attempt
- **WHEN** the session emits a body that satisfies the schema and the rules
- **THEN** the run admits a document whose `docId` and `inputDigest` were stamped by the orchestration, not the agent

#### Scenario: A rejected body is retried then admitted
- **WHEN** the session emits an invalid body then a valid one
- **THEN** the first attempt produces a `validation.report` with the rejection codes and the second attempt is admitted

#### Scenario: Terminal failure falls back to the floor
- **WHEN** every attempt is rejected
- **THEN** the run returns the deterministic floor body, admitted, with a provenance route that records it as the fallback

