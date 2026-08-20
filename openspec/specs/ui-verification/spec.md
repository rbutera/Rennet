# ui-verification specification

## Purpose

When a changeset touches UI files, one verification turn mounts the changed UI, captures screenshots, checks accessibility, and compares the result with the captured design intent. Its observations become ordinary anchored findings, and an unsuccessful mount reports what the turn attempted.

## Requirements

### Requirement: A deterministic classifier decides whether a changeset touches UI

The pipeline SHALL use a deterministic, versioned path classifier to decide whether a changeset warrants UI verification. Classification SHALL invoke no model. A changeset with no UI files SHALL skip the verify-ui turn and record `not-ui`, not failure or all-clear.

#### Scenario: A renderer component change is classified as UI

- **WHEN** the changeset under review modifies a component or stylesheet file (for example a `.tsx`, `.vue`, `.svelte`, `.css`, or `.scss` file)
- **THEN** the classifier marks the changeset as touching UI and the verify-ui turn becomes eligible to run

#### Scenario: A backend-only changeset spends nothing

- **WHEN** the changeset under review modifies no UI files
- **THEN** no verify-ui turn runs, no invocation budget is consumed
- **AND** the review records `not-ui` so downstream readers can distinguish "not applicable" from "could not run"

### Requirement: One budget-bounded verify-ui turn per review

UI verification SHALL run at most one model turn per review and only at the deep review tier. The shared review invocation budget SHALL cover the turn. It SHALL run in a fresh session with all tools, including command execution in the reviewed repository. When the budget is exhausted, the review SHALL record `unavailable` with the reason instead of running the turn.

#### Scenario: Deep review on a UI changeset runs the turn

- **WHEN** a deep review runs over a changeset classified as touching UI and budget remains
- **THEN** exactly one verify-ui turn runs in a fresh capable session
- **AND** the commands it actually executed are observed and recorded as proof the mount ran

#### Scenario: An exhausted budget is disclosed, not silently skipped

- **WHEN** the shared invocation budget is exhausted before the verify-ui turn starts
- **THEN** the review records the unavailable status naming the budget as the reason
- **AND** no all-clear is implied anywhere the status is shown

### Requirement: The turn mounts, screenshots, checks accessibility, and compares against captured intent

The verify-ui turn SHALL mount the changed UI with the reviewed project's tests, Storybook, dev server, or installed browser tools. It SHALL capture screenshots in the review evidence store, run an accessibility check with the project's tools, and compare the rendered result with the patchset's captured intent. That intent consists of the pull request title, body, and spec snapshots. Rennet SHALL NOT bundle a browser, renderer, or accessibility runtime. It SHALL NOT ingest a design source outside the captured review intent.

#### Scenario: A project with browser tooling yields screenshots and an accessibility result

- **WHEN** the verify-ui turn runs against a project that affords rendering and accessibility tooling
- **THEN** the turn's result carries captured screenshot references and its accessibility observations
- **AND** observations that contradict the captured design intent are reported against the intent text they contradict

#### Scenario: A project with no rendering tools reports the limitation

- **WHEN** the verify-ui turn cannot mount the changed UI with the project's installed tools
- **THEN** the result is the inconclusive could-not-mount disclosure carrying what was attempted
- **AND** it is never reported as "no UI problems found"

### Requirement: Observations become ordinary anchored findings

Each verify-ui observation SHALL become a finding anchored to the relevant UI file. It SHALL carry a severity and an evidence chip that states what the turn observed. The finding SHALL use the same lens, disposition, collation, posting, and delta-carry paths as every other finding. UI verification SHALL NOT add a separate disposition screen.

#### Scenario: An accessibility violation becomes a dispositionable flag

- **WHEN** the verify-ui turn observes an accessibility violation in the rendered change
- **THEN** a finding anchored to the implicated UI file appears in the Flagged lens with its evidence
- **AND** the reviewer can disposition it exactly like any other flag

#### Scenario: Deleting the pipeline wiring fails a test

- **WHEN** the verify-ui pass is disconnected from the review pipeline
- **THEN** at least one test that asserts a UI changeset's review carries the verify-ui findings and status fails

### Requirement: The status is honest, additive, and never a gate

The successful review result SHALL carry an optional UI-verification status on the `ok` `FlaggedReview` branch. The status SHALL be `pending` while late enrichment runs, `ran` with screenshot references, `not-ui`, or `unavailable` with a reason. Every status SHALL carry the classifier version. A review without the field SHALL remain valid, and transport SHALL preserve the field when present. The immediate response SHALL report scheduled late enrichment even when no finding needs adjudication. A failed base review carries no findings and therefore no UI-verification result. UI-verification status and findings SHALL NOT block posting or disposition actions.

#### Scenario: A review without UI-verification data renders

- **WHEN** a persisted review has no UI-verification field
- **THEN** it validates and renders with no UI-verification strip and no error

#### Scenario: The field survives transport

- **WHEN** a review result carrying the UI-verification status crosses the desktop transport boundary
- **THEN** the renderer receives the status with screenshot references intact

#### Scenario: Posting is untouched by any verify-ui state

- **WHEN** a review's UI verification is unavailable, inconclusive, or carries unresolved verify-ui findings
- **THEN** posting remains available and uses the same outbound payload

### Requirement: Screenshots are isolated, bounded, retained, and rendered in the Flagged lens

Captured screenshots SHALL persist in an app-owned directory unique to the review, patchset, and run until bounded retention prunes them. `FlaggedReview`, its UI-verification status, and the renderer's references SHALL remain transient. Reopening a review SHALL recompute them with the CI signal and `blockingStates`. The renderer SHALL expose only the directory bound to the completed current enrichment. A completed newer run SHALL remove the same patchset's prior run, and retention SHALL prune old patchset directories. Before reading evidence, the adapter SHALL resolve the real path, require a regular file inside the review evidence directory, and stat it. One screenshot SHALL be limited to 8 MiB. The protocol SHALL limit screenshot references per run and the data URL length. After a completed pass, the Flagged lens SHALL display screenshots inline. Pending and unavailable states SHALL explain why no full all-clear exists. The `not-ui` state SHALL add no UI-verification copy to the lens.

#### Scenario: Reopening recomputes the transient evidence status

- **WHEN** a review whose prior verify-ui run captured screenshots is reopened later by id
- **THEN** the eager Flagged review recomputes verify-ui status and evidence references for the reopened run
- **AND** prior screenshot files may remain in their bounded run namespace, but the renderer does not remount stale references from the prior transient result

#### Scenario: A slow stale run cannot overwrite current evidence

- **WHEN** patchset A's slow verify-ui turn finishes after patchset B has produced an evidence file with the same basename
- **THEN** each turn wrote a distinct namespace and only the completed enrichment's namespaced reference is exposed
- **AND** A cannot overwrite or delete B's bound bytes

#### Scenario: A missing screenshot file reports its absence

- **WHEN** a screenshot reference in the completed transient review no longer resolves to a readable file
- **THEN** the lens shows a plain missing-evidence note for that entry instead of a broken image or a crash

#### Scenario: Symlink escape and oversized evidence are refused before read

- **WHEN** the final screenshot or an intermediate directory is a symlink whose real path leaves the canonical review evidence directory, or the regular file exceeds 8 MiB
- **THEN** no bytes are read or returned
- **AND** the command reports not-found or oversized honestly
