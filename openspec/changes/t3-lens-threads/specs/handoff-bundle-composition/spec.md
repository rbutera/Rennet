## MODIFIED Requirements

### Requirement: The run executes the composed bundle, bound by its digest

`review.handoff.run` SHALL execute the ordered, grouped, verbatim `prompt` produced by `review.handoff.compose`. It SHALL NOT rebuild a mechanical bundle from raw dispositions. The run input SHALL carry the `ComposedHandoffBundle`. Before running, `verifyComposedBundle` SHALL recompute its `digest` and `prompt` from its `tasks`, and the handler SHALL confirm that the bundle names the active patchset. A failed verification or patchset mismatch SHALL return `status: "refused"` without invoking the coding agent. The run SHALL always execute as one turn on the review's T3 thread in full-access mode; there is no other engine to choose.

#### Scenario: a reversed composition reaches the write turn reversed

- **WHEN** the model reversed a two-ask bundle and the composed bundle is run
- **THEN** the write turn receives the composed prompt in the reversed order, not the mechanical order

#### Scenario: a merged composition reaches the write turn as one task

- **WHEN** the model merged two asks into one group and the composed bundle is run
- **THEN** the write turn receives a single-task prompt carrying both asks' bodies

#### Scenario: a tampered or stale bundle is refused, never run

- **WHEN** a run is handed a bundle whose prompt or a body was swapped after composition, or a bundle composed against a patchset that is no longer active
- **THEN** the handler returns `status: "refused"` and the write turn is never invoked

#### Scenario: the run is a T3 turn

- **WHEN** a verified bundle is run
- **THEN** one turn starts on the review's bound T3 thread with the composed prompt, and its settled diff is what the delta re-review is offered over
