# ui-verification Specification

## Purpose

When a changeset under review touches UI surface files, the review runs one verification turn that mounts the rendered change with whatever the reviewed project affords, captures screenshots, runs an accessibility check, and compares the result against the review's captured design intent — surfacing what it saw as ordinary anchored findings with evidence, and disclosing honestly when it could not look.

## ADDED Requirements

### Requirement: A deterministic classifier decides whether a changeset touches UI

The pipeline SHALL decide whether a changeset warrants UI verification with a deterministic, versioned classifier over the changeset's file paths — no model invocation SHALL be spent to make this decision. A changeset with no UI-surface files SHALL skip the verify-ui turn entirely and record the skip as a distinct status, not as a failure and not as an all-clear.

#### Scenario: a renderer component change is classified as UI

- **WHEN** the changeset under review modifies a component or stylesheet file (for example a `.tsx`, `.vue`, `.svelte`, `.css`, or `.scss` file)
- **THEN** the classifier marks the changeset as touching UI and the verify-ui turn becomes eligible to run

#### Scenario: a backend-only changeset spends nothing

- **WHEN** the changeset under review modifies no UI-surface files
- **THEN** no verify-ui turn runs, no invocation budget is consumed
- **AND** the review records the not-UI status so downstream surfaces can distinguish "not applicable" from "could not run"

### Requirement: One budget-bounded verify-ui turn per review

UI verification SHALL run at most one harness turn per review, only at the deep review tier, consuming the shared review invocation budget. The turn SHALL run in a fresh session with the full tool surface, including the ability to execute commands in the reviewed repository (Rule Zero: the capable agent is the product). When the budget is exhausted before the turn runs, the review SHALL record the unavailable status with its reason instead of running the turn.

#### Scenario: deep review on a UI changeset runs the turn

- **WHEN** a deep review runs over a changeset classified as touching UI and budget remains
- **THEN** exactly one verify-ui turn runs in a fresh capable session
- **AND** the commands it actually executed are observed and recorded as proof the mount ran

#### Scenario: an exhausted budget is disclosed, not silently skipped

- **WHEN** the shared invocation budget is exhausted before the verify-ui turn starts
- **THEN** the review records the unavailable status naming the budget as the reason
- **AND** no all-clear is implied anywhere the status is shown

### Requirement: The turn mounts, screenshots, checks accessibility, and compares against captured intent

The verify-ui turn SHALL be directed to: mount the changed surface using whatever the reviewed project affords (its own tests, storybook, dev server, or installed browser tooling); capture screenshots of the rendered change into the review's evidence storage; run an accessibility check with the tooling the project affords; and compare what rendered against the review's captured design intent (the frozen patchset intent — pull-request title and body plus spec snapshots). Rennet SHALL NOT bundle a browser, renderer, or accessibility runtime of its own, and SHALL NOT ingest any design source beyond the intent the review already captured.

#### Scenario: a project with browser tooling yields screenshots and an a11y result

- **WHEN** the verify-ui turn runs against a project that affords rendering and accessibility tooling
- **THEN** the turn's result carries captured screenshot references and its accessibility observations
- **AND** observations that contradict the captured design intent are reported against the intent text they contradict

#### Scenario: a project that affords no rendering is reported honestly

- **WHEN** the verify-ui turn cannot mount the changed surface with anything the project affords
- **THEN** the result is the inconclusive could-not-mount disclosure carrying what was attempted
- **AND** it is never reported as "no UI problems found"

### Requirement: Observations surface as ordinary anchored findings

Each verify-ui observation SHALL surface as a finding anchored to the UI file it concerns, carrying a severity and an evidence chip describing what was observed, and SHALL flow through the same lens, disposition, collation, publish, and delta-carry machinery as every other finding. UI verification SHALL NOT introduce a separate disposition surface.

#### Scenario: an a11y violation becomes a dispositionable flag

- **WHEN** the verify-ui turn observes an accessibility violation in the rendered change
- **THEN** a finding anchored to the implicated UI file appears in the Flagged lens with its evidence
- **AND** the reviewer can disposition it exactly like any other flag

#### Scenario: deleting the pipeline wiring fails a test

- **WHEN** the verify-ui pass is disconnected from the review pipeline
- **THEN** at least one test that asserts a UI changeset's review carries the verify-ui findings and status fails

### Requirement: The status is honest, additive, and never a gate

The review result SHALL carry a UI-verification status — ran (with screenshot references), not-UI, or unavailable (with reason) — as an additive field: a review without it SHALL validate, transport, and render exactly as before this capability existed, and the transport SHALL NOT strip the field when present. The status and the verify-ui findings SHALL NOT feed any sign, publish, or disposition gate.

#### Scenario: a legacy review renders unchanged

- **WHEN** a persisted review from before this capability is loaded
- **THEN** it validates and renders with no UI-verification strip and no error

#### Scenario: the field survives transport

- **WHEN** a review result carrying the UI-verification status crosses the desktop transport boundary
- **THEN** the renderer receives the status with screenshot references intact

#### Scenario: signing is untouched by any verify-ui state

- **WHEN** a review's UI verification is unavailable, inconclusive, or carries unresolved verify-ui findings
- **THEN** sign and publish behave exactly as they would without the field

### Requirement: Screenshots persist with the review and render in the Flagged lens

Captured screenshots SHALL be stored with the review's persisted state so a reopened review (`review.load`) still shows them. When the pass ran, the Flagged lens SHALL display the captured screenshots inline; when it was unavailable, the lens SHALL show the one-line honest reason; when the changeset had no UI, the lens SHALL show nothing about UI verification.

#### Scenario: a reopened review still shows its evidence

- **WHEN** a review whose verify-ui pass captured screenshots is reopened later by id
- **THEN** the Flagged lens renders the same screenshots from the review's persisted evidence

#### Scenario: a missing screenshot file degrades honestly

- **WHEN** a screenshot reference in a persisted review no longer resolves to a readable file
- **THEN** the lens shows a plain missing-evidence note for that entry instead of a broken image or a crash
