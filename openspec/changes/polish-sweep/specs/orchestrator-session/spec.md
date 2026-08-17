# orchestrator-session delta

## MODIFIED Requirements

### Requirement: The orchestrator boots with a lean map-not-container primer

The system SHALL assemble a deterministic, versioned primer for a fresh orchestrator session as a MAP of the review, not a container of it. The primer SHALL contain B1 review identity (workspace/repo, reviewId, patchsetId, lineage position, mode), B2 freshness verdicts (per-repo lines up to a deterministic cap, then a single rollup line carrying the count and aggregate fresh/stale verdicts of the remaining repos), B3 count-level canvas state (per-canvas lines up to a deterministic cap, then a single rollup line carrying the count and aggregate counts of the remaining canvases; counts only, never contents, and the decisions list SHALL NOT be inlined), B4 the protocol card, B5 a tool index derived from the live `canvasOps@2` surface (names + when-to-use one-liners, schemas deferred), and B6 the run-ledger headline. The assembled primer SHALL be ≤ 4 KB, and the ceiling SHALL hold for large multi-repo reviews by bounding B2/B3 — the fail-closed overrun error remains only as the backstop. Rolled-up repos and canvases SHALL remain reachable via the tool surface (map, not container).

#### Scenario: A fresh session answers orientation from the bootstrap without a tool call

- **WHEN** a fresh session boots with a primer for a review whose canvases carry dispositioned and undispositioned paths
- **THEN** the primer is ≤ 4 KB and its B3 section states, per canvas, the counts that answer "where are we" and "what have you not looked at yet" (unread / disposition-coverage), so the question is answerable from the primer text with no tool call

#### Scenario: Count-level state never inlines contents

- **WHEN** the primer's B3 canvas state is assembled for a review with many decisions
- **THEN** it carries the decision COUNT and never the decision bodies or titles — the decisions list is reachable via the tool surface, not inlined

#### Scenario: A large multi-repo review assembles under the ceiling without throwing

- **WHEN** a primer is assembled for a review with at least 10 repos and 20 canvases
- **THEN** assembly succeeds deterministically with a primer ≤ 4 KB whose B2 and B3 sections end in rollup lines naming how many repos/canvases were aggregated and their aggregate counts, and the same inputs produce identical bytes and digest
