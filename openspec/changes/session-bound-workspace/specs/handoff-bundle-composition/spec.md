## MODIFIED Requirements

### Requirement: The run executes the composed bundle, bound by its digest

`review.handoff.run` SHALL execute the ordered, grouped, verbatim `prompt` produced by `review.handoff.compose`, in the session's bound workspace. It SHALL NOT rebuild a mechanical bundle from raw dispositions. The run input SHALL carry the `ComposedHandoffBundle`. Before running, `verifyComposedBundle` SHALL recompute its `digest` and `prompt` from its `tasks`, and the handler SHALL confirm that the bundle names the active patchset. The composed work order SHALL be written to the session's context directory and the turn's prompt SHALL name that file; the asks' bodies and their anchored diff context SHALL NOT be embedded in the turn's prompt text. A failed verification or patchset mismatch SHALL return `status: "refused"` without invoking the coding agent.

#### Scenario: a reversed composition reaches the write turn reversed

- **WHEN** the model reversed a two-ask bundle and the composed bundle is run
- **THEN** the work-order file the turn is pointed at carries the composed order, not the mechanical order

#### Scenario: a merged composition reaches the write turn as one task

- **WHEN** the model merged two asks into one group and the composed bundle is run
- **THEN** the work-order file carries a single task holding both asks' bodies

#### Scenario: a tampered or stale bundle is refused, never run

- **WHEN** a run is handed a bundle whose recomputed digest differs or whose patchset is not the active one
- **THEN** the run returns `status: "refused"` and no coding agent turn is started

#### Scenario: the turn runs where the session lives

- **WHEN** a composed bundle is run
- **THEN** the coding turn's working directory is the session's bound root and its commits land on the session's branch
