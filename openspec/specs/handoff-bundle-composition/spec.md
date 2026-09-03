# Handoff bundle composition specification

## Purpose
Define how Rennet groups disposition-derived asks into a verifiable coding-agent prompt, previews the exact work order, runs it, and traces each ask into the successor review.
## Requirements
### Requirement: Every ask carries a stable id and a partition is a TOTAL COVER of those ids

`asksFromBundle` SHALL stamp each mechanical task with a stable id equal to its ordinal in the bundle's deterministic order, so the same disposition set always yields the same ids. `buildComposePrompt` SHALL give the model the asks with their ids and require only an ordered partition of groups. Each group SHALL cite ids and carry a one-line title. The model SHALL NOT return an ask body. `validateComposition` SHALL require the partition to cover every ask id exactly once. It SHALL reject a missing, duplicated, unknown, or empty group.

#### Scenario: a valid total-cover partition is accepted

- **WHEN** a partition cites every ask id exactly once across its groups
- **THEN** `validateComposition` returns `{ ok: true }`

#### Scenario: a dropped, duplicated, or invented id is rejected

- **WHEN** a partition omits an id, cites an id twice, or cites an id no ask has
- **THEN** `validateComposition` returns `{ ok: false }` with a reason naming the fault, and the composer falls closed to the mechanical floor

### Requirement: Bodies are reconstructed verbatim by id; the model authors no executable text

On a valid partition, the composer SHALL reconstruct each group's asks from the trusted input by id. The executable prompt SHALL carry every original instruction body byte-for-byte. Before `composeHandoffBundle` returns `composed:true`, it SHALL assert that the rendered prompt contains every non-empty instruction body verbatim. A failed assertion SHALL return the mechanical floor.

#### Scenario: a reversed/merged composition preserves every body verbatim

- **WHEN** the model reorders and merges the asks into a valid partition
- **THEN** every reviewer instruction body appears in `ComposedHandoffBundle.prompt` exactly as written, and no body is dropped or rewritten

### Requirement: The model's title is preview-only and never enters the executable prompt

The per-group `title` SHALL be preview-only metadata. `renderComposedPrompt` SHALL derive each task's executable heading from the trusted ask paths and SHALL NOT insert the model's title into the coding-agent prompt.

#### Scenario: the executable prompt carries mechanical headings, not the model title

- **WHEN** a composed bundle is rendered to its executable prompt
- **THEN** each task heading is the distinct ask paths of that task, and the model's title string does not appear in the prompt

### Requirement: Any doubt falls closed to the mechanical floor

`composeHandoffBundle` SHALL return the mechanical pass-through floor on every failure branch. `mechanicalComposition` creates one task per ask, performs no merging, sets `composed:false`, and leaves titles empty. The same floor applies when the port is unavailable, returns `failed`, throws, returns an invalid partition, or fails the body-survival assertion. The floor SHALL contain every ask and no invented ask.

#### Scenario: an unavailable/failed/throwing port yields the floor

- **WHEN** the compose port is unavailable, returns `failed`, or throws
- **THEN** `composeHandoffBundle` returns a `composed:false` bundle with one task per ask in mechanical order, losing nothing

### Requirement: The traceMap maps every ask id to its task index exactly once

`ComposedHandoffBundle.traceMap` SHALL map every input ask id to one task index. When `review.handoff.run` captures the successor patchset, it SHALL pass the verified bundle's id-stamped asks, anchors, `traceMap`, and preview titles into capture. The successor's delta account can then attribute each staged ask to the composed task that carried it. Only handoff runs attach this trace. Other capture paths carry no ask trace, and capture does not depend on one.

#### Scenario: every id is traced to exactly one task index

- **WHEN** a composed bundle (floor or authored) is assembled
- **THEN** `traceMap` has an entry for every ask id, each pointing at its task's index, with no id missing or duplicated

#### Scenario: the run hands the ask trace to the successor capture

- **WHEN** a handoff run of a verified composed bundle completes and captures the successor patchset
- **THEN** the capture receives the bundle's ask trace, and the successor review's delta account attributes its asks through the traceMap

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

### Requirement: The mechanical floor remains runnable

A `composed:false` mechanical-floor bundle SHALL remain runnable when composition returned it. The handler SHALL refuse only a bundle that fails verification or names a stale patchset. It SHALL NOT refuse the bundle because it uses the mechanical floor.

#### Scenario: a legitimately-composed floor runs

- **WHEN** compose returned the mechanical floor (no composer wired) and that floor is run against its active patchset
- **THEN** the run executes it and captures the delta, exactly as it would a `composed:true` bundle

### Requirement: The app previews the composed bundle accurately

A pure `handoffPreview` view model in `layer:ui` SHALL render the `ComposedHandoffBundle` before the run. It SHALL show the ordered tasks, each task's asks with path, anchor, and verbatim body, the preview-only title, and the `composed` flag. The preview SHALL read the same ordered `tasks` that the run executes. A `composed:false` floor SHALL render as an un-composed list without model-authored titles.

An own-branch review with actionable dispositions SHALL offer a handoff preview that obtains its bundle from `review.handoff.compose`. The renderer SHALL NOT synthesize, reorder, or mutate the bundle for display.

#### Scenario: the previewed order equals the executed order

- **WHEN** a composed bundle is previewed
- **THEN** the previewed task order equals the order carried into `review.handoff.run` (the order of `bundle.prompt`)

#### Scenario: the floor is shown honestly as un-composed

- **WHEN** a `composed:false` mechanical-floor bundle is previewed
- **THEN** the preview surfaces `composed:false` and shows no authored titles

#### Scenario: the handoff preview is reachable from an own-branch review

- **WHEN** an own-branch review has at least one disposition that produces a handoff ask
- **THEN** the reviewer can open an in-app preview of the bundle returned by `review.handoff.compose` for that review

### Requirement: The run is triggered in-app with the exact previewed bundle

The renderer SHALL invoke `review.handoff.run` with the exact `ComposedHandoffBundle` it previewed, with the same object and digest. Between preview and run, the renderer SHALL NOT recompose, edit, or substitute the bundle. Changing dispositions and composing again SHALL replace the previewed bundle before a run.

#### Scenario: the run receives the previewed bundle

- **WHEN** the reviewer triggers the run from the handoff preview
- **THEN** `review.handoff.run` receives the same bundle instance the preview rendered, and the main process verifies it by digest

#### Scenario: recomposing replaces the preview before the run

- **WHEN** dispositions change after a bundle was composed and the reviewer returns to the handoff preview
- **THEN** the preview shows a newly composed bundle and any subsequent run executes that bundle, not the stale one

### Requirement: The run outcome is surfaced truthfully

The renderer SHALL surface the `review.handoff.run` outcome exactly as the command reports it: a success shows the run's result state, a refusal (tampered or stale bundle) is shown as a refusal with its reason, and a failure is shown as an error. While a run is in flight the surface SHALL show a pending state. The renderer SHALL NOT display a success state for any non-success outcome and SHALL NOT claim a run happened when the command was never invoked.

#### Scenario: a refusal is shown as a refusal

- **WHEN** `review.handoff.run` returns a refused outcome
- **THEN** the surface reports the refusal and its reason, and shows no success state

#### Scenario: a pending run is visible

- **WHEN** a run has been triggered and has not yet returned
- **THEN** the surface shows a pending state until the outcome arrives

