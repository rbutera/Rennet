# handoff-bundle-composition

The M24 authoring step over the mechanical `HandoffBundle` (#18): it orders N terse anchored asks into ONE coherent work order for a coding harness in own-branch (handoff) mode, merges overlapping asks, and narrates each group — under a safety law that makes it structurally incapable of dropping or rewriting what the reviewer asked. This capability promotes the shipped composition core (`packages/core/src/handoff-compose.ts`, `d1b41e6`) to requirements of record and adds the two wirings that make it consequential: the run executes the composed bundle under its digest, and the paper previews it at journey stage 6. `model-council`'s existing routing entry for the handoff-bundle job (job M24, light tier) is referenced, not modified.

## ADDED Requirements

### Requirement: Every ask carries a stable id and a partition is a TOTAL COVER of those ids

`asksFromBundle` SHALL stamp each mechanical task with a stable id equal to its ordinal in the bundle's deterministic order, so the same disposition set always yields the same ids. The model turn (`buildComposePrompt`) SHALL be handed the asks WITH ids and constrained to return ONLY a partition — an ordered list of groups, each citing ids and carrying a one-line title — never a body. `validateComposition` SHALL require the partition to be a TOTAL COVER of the ask ids: it SHALL reject a dropped id, a duplicated id (within or across groups), an invented (unknown) id, and an empty group.

#### Scenario: a valid total-cover partition is accepted

- **WHEN** a partition cites every ask id exactly once across its groups
- **THEN** `validateComposition` returns `{ ok: true }`

#### Scenario: a dropped, duplicated, or invented id is rejected

- **WHEN** a partition omits an id, cites an id twice, or cites an id no ask has
- **THEN** `validateComposition` returns `{ ok: false }` with a reason naming the fault, and the composer falls closed to the mechanical floor

### Requirement: Bodies are reconstructed verbatim by id; the model authors no executable text

On a valid partition the composer SHALL reconstruct each group's member asks from the TRUSTED input by id — the model supplied only ids — so the executable prompt carries every original instruction body byte-for-byte unaltered. `composeHandoffBundle` SHALL, before returning `composed:true`, assert that every non-empty original instruction body is present verbatim in the rendered prompt, and fall closed to the mechanical floor if (impossibly) one is not.

#### Scenario: a reversed/merged composition preserves every body verbatim

- **WHEN** the model reorders and merges the asks into a valid partition
- **THEN** every reviewer instruction body appears in `ComposedHandoffBundle.prompt` exactly as written, and no body is dropped or rewritten

### Requirement: The model's title is PREVIEW-ONLY and never enters the executable prompt

The per-group `title` SHALL be preview-only metadata shown to the human on the paper. `renderComposedPrompt` SHALL derive each task's executable heading MECHANICALLY from the trusted ask paths and SHALL NOT insert the model's title into the prompt the coding agent executes. A partition that validates therefore cannot smuggle an invented instruction through the title field.

#### Scenario: the executable prompt carries mechanical headings, not the model title

- **WHEN** a composed bundle is rendered to its executable prompt
- **THEN** each task heading is the distinct ask paths of that task, and the model's title string does not appear in the prompt

### Requirement: Any doubt falls closed to the mechanical floor

`composeHandoffBundle` SHALL return the mechanical pass-through floor (`mechanicalComposition`, one task per ask, no merging, `composed:false`, empty titles) on every failure branch: the port is unavailable, the port returns `failed`, the port throws, the partition fails validation, or the body-survival assertion fails. The floor is always valid and always complete — no ask is dropped, none invented.

#### Scenario: an unavailable/failed/throwing port yields the floor

- **WHEN** the compose port is unavailable, returns `failed`, or throws
- **THEN** `composeHandoffBundle` returns a `composed:false` bundle with one task per ask in mechanical order, losing nothing

### Requirement: The traceMap maps every ask id to its task index exactly once

`ComposedHandoffBundle.traceMap` SHALL map every input ask id to the index of the task it landed in, with every id present exactly once. This is the forward hook issue #73 consumes for delta re-review map-back; this capability proves the hook is present and correct and consumes it nowhere.

#### Scenario: every id is traced to exactly one task index

- **WHEN** a composed bundle (floor or authored) is assembled
- **THEN** `traceMap` has an entry for every ask id, each pointing at its task's index, with no id missing or duplicated

### Requirement: The run executes the composed bundle, bound by its digest

`review.handoff.run` SHALL execute the exact composed bundle that `review.handoff.compose` produced — its ordered, grouped, verbatim `prompt` — and SHALL NOT rebuild a mechanical bundle from the raw dispositions at run time. The run input SHALL carry the `ComposedHandoffBundle`. Before running, the handler SHALL verify the bundle's integrity: its `digest` and `prompt` SHALL recompute from its `tasks` (`verifyComposedBundle`), and it SHALL have been composed against the review's currently-active patchset. A bundle that fails verification or was composed against a different review/patchset SHALL be refused (`status: "refused"`), not run. This binding is INTEGRITY (the same bytes run as were composed), not a consent gate — clicking run is the human act (Rule Zero).

#### Scenario: a reversed composition reaches the write turn reversed

- **WHEN** the model reversed a two-ask bundle and the composed bundle is run
- **THEN** the write turn receives the composed prompt in the reversed order, not the mechanical order

#### Scenario: a merged composition reaches the write turn as one task

- **WHEN** the model merged two asks into one group and the composed bundle is run
- **THEN** the write turn receives a single-task prompt carrying both asks' bodies

#### Scenario: a tampered or stale bundle is refused, never run

- **WHEN** a run is handed a bundle whose prompt or a body was swapped after composition, or a bundle composed against a patchset that is no longer active
- **THEN** the handler returns `status: "refused"` and the write turn is never invoked

### Requirement: The mechanical floor remains runnable

A `composed:false` mechanical-floor bundle SHALL remain a legitimate thing to run when it IS the composed bundle (the model was unavailable/failed, so the floor was composed as the floor). The run's refusal SHALL be scoped to a bundle that fails its own integrity check or is stale — never to the fact that a bundle is the floor.

#### Scenario: a legitimately-composed floor runs

- **WHEN** compose returned the mechanical floor (no composer wired) and that floor is run against its active patchset
- **THEN** the run executes it and captures the delta, exactly as it would a `composed:true` bundle

### Requirement: The stage-6 paper previews the composed bundle honestly

A pure view-model (`handoffPreview`, `layer:ui`, `@rennet/types` only) SHALL render the `ComposedHandoffBundle` before the run: the ordered tasks, each task's member asks (path, anchor, verbatim body), each task's `title` as PREVIEW-ONLY metadata separate from the executable heading, and the `composed` flag surfaced verbatim. The preview SHALL read the same ordered `tasks` the run executes, so it cannot show an order the run does not run. A `composed:false` floor SHALL render as an un-composed list, never dressed as authored prose.

#### Scenario: the previewed order equals the executed order

- **WHEN** a composed bundle is previewed
- **THEN** the previewed task order equals the order carried into `review.handoff.run` (the order of `bundle.prompt`)

#### Scenario: the floor is shown honestly as un-composed

- **WHEN** a `composed:false` mechanical-floor bundle is previewed
- **THEN** the preview surfaces `composed:false` and shows no authored titles
