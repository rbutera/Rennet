## MODIFIED Requirements

### Requirement: The stage-6 paper previews the composed bundle honestly

A pure view-model (`handoffPreview`, `layer:ui`, `@rennet/types` only) SHALL render the `ComposedHandoffBundle` before the run: the ordered tasks, each task's member asks (path, anchor, verbatim body), each task's `title` as PREVIEW-ONLY metadata separate from the executable heading, and the `composed` flag surfaced verbatim. The preview SHALL read the same ordered `tasks` the run executes, so it cannot show an order the run does not run. A `composed:false` floor SHALL render as an un-composed list, never dressed as authored prose.

The preview SHALL be reachable in the app: an own-branch review with actionable dispositions SHALL offer a handoff path whose paper obtains its bundle from `review.handoff.compose` and renders it with this view-model before any run. The renderer SHALL NOT synthesize, reorder, or mutate a bundle for display.

#### Scenario: the previewed order equals the executed order

- **WHEN** a composed bundle is previewed
- **THEN** the previewed task order equals the order carried into `review.handoff.run` (the order of `bundle.prompt`)

#### Scenario: the floor is shown honestly as un-composed

- **WHEN** a `composed:false` mechanical-floor bundle is previewed
- **THEN** the preview surfaces `composed:false` and shows no authored titles

#### Scenario: the handoff paper is reachable from an own-branch review

- **WHEN** an own-branch review has at least one disposition that produces a handoff ask
- **THEN** the reviewer can open a handoff paper in-app whose content is the composed bundle returned by `review.handoff.compose` for that review

## ADDED Requirements

### Requirement: The run is triggered in-app with the exact previewed bundle

The renderer SHALL invoke `review.handoff.run` with the exact `ComposedHandoffBundle` it previewed — same object, same digest. Between preview and run the renderer SHALL NOT recompose, edit, or substitute the bundle; if the reviewer wants a different bundle, the path is changing dispositions and composing again, which replaces the previewed bundle before any run.

#### Scenario: the run receives the previewed bundle

- **WHEN** the reviewer triggers the run from the handoff paper
- **THEN** `review.handoff.run` receives the same bundle instance the paper rendered, and the main process verifies it by digest

#### Scenario: recomposing replaces the preview before the run

- **WHEN** dispositions change after a bundle was composed and the reviewer returns to the handoff paper
- **THEN** the paper previews a freshly composed bundle and any subsequent run executes that fresh bundle, not the stale one

### Requirement: The run outcome is surfaced truthfully

The renderer SHALL surface the `review.handoff.run` outcome exactly as the command reports it: a success shows the run's result state, a refusal (tampered or stale bundle) is shown as a refusal with its reason, and a failure is shown as an error. While a run is in flight the surface SHALL show a pending state. The renderer SHALL NOT display a success state for any non-success outcome and SHALL NOT claim a run happened when the command was never invoked.

#### Scenario: a refusal is shown as a refusal

- **WHEN** `review.handoff.run` returns a refused outcome
- **THEN** the surface reports the refusal and its reason, and shows no success state

#### Scenario: a pending run is visible

- **WHEN** a run has been triggered and has not yet returned
- **THEN** the surface shows a pending state until the outcome arrives
