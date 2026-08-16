# narrated-progress Specification

## Purpose

While Rennet works — building the initial context dump, refreshing a project's context in the background, or capturing and generating a review — the wait narrates itself: one shared feed of real pipeline events in plain speech, so waiting never feels like a black box. The MVP presentation is an honest plain spinner over that real feed; the delightful animation is a later, separate change.

## ADDED Requirements

### Requirement: A working wait is never a mute surface

Whenever a narrated slot (project processing, context refresh, review capture/generation) is running, the interface SHALL show an honest in-progress indicator over the live narration feed for that run. It SHALL NOT present a bare blank surface, and SHALL NOT present a bare busy indicator with no feed when narration events exist for the run.

#### Scenario: the processing slot shows a spinner over the real feed

- **WHEN** a project is being processed (the initial context dump)
- **THEN** the processing slot renders a plain in-progress indicator over the live feed of that run's real pipeline events
- **AND** no bare blank surface is shown at any point in the run

#### Scenario: the capture/review wait narrates instead of going mute

- **WHEN** a review capture or review generation is running
- **THEN** the wait renders the same in-progress-over-feed presentation from the run's real progress events
- **AND** the mute-busy-only presentation (a disabled surface with no feed) does not occur while events are being emitted

### Requirement: One narration organ, everywhere

All narrated slots SHALL render through a single shared narration-feed component. The processing screen, the context-refresh indicator, and the capture/review wait SHALL be consumers of that one component, not parallel implementations of the feed.

#### Scenario: the three slots share one component

- **WHEN** the processing screen, the refresh indicator, and the capture/review wait each render a narration feed
- **THEN** each renders the same shared narration-feed component
- **AND** no slot carries its own duplicate implementation of the event fold or feed rendering

### Requirement: Feed lines are real events in plain speech

Every feed line SHALL derive from a real emitted pipeline event (a stage with a real note and optional real detail, a milestone, a completion, or an error). The feed SHALL NOT contain scripted or invented lines that do not correspond to an emitted event. Completed work SHALL collapse into a compact done-ledger so a long run never becomes a wall of text, and the current activity SHALL be visible as the latest line.

#### Scenario: lines come only from emitted events

- **WHEN** the narration feed renders during a run
- **THEN** every rendered line corresponds to an event actually emitted by the pipeline for that run
- **AND** stage details shown (counts, names) are the event's real values, never placeholders

#### Scenario: completed lines collapse into a done-ledger

- **WHEN** a stage completes and later stages continue arriving
- **THEN** the completed stage folds into the compact done-ledger form
- **AND** the in-progress line remains visible as the feed's current line

### Requirement: The capture and review pipeline emits deterministic progress events

The review capture and review-generation path SHALL emit typed progress events at its real seams (capture milestones, deterministic-floor completion, per-angle admission) on the same progress transport the processing slot uses, keyed to the initiating command. Event emission SHALL be deterministic: it SHALL NOT require any model call to produce a complete feed. The terminal event and the command's resolved value SHALL agree.

#### Scenario: a review run produces a complete deterministic feed

- **WHEN** a review capture and generation runs to completion
- **THEN** progress events for its real milestones were emitted on the progress transport, keyed to the initiating command
- **AND** a terminal event was emitted that agrees with the command's resolved value

#### Scenario: a soft failure narrates instead of silencing the feed

- **WHEN** one part of a run fails while the run continues (for example one repo of a workspace)
- **THEN** the failure is emitted as an event and rendered honestly in the feed
- **AND** the run's remaining narration continues

### Requirement: The feed is complete with zero model calls

The narration feed for every narrated slot SHALL be complete — every line, detail, ledger entry, and terminal state present — with the model utility port stubbed out. Model-flavoured garnish lines are out of scope for this capability; the feed SHALL NOT depend on any model output for completeness.

#### Scenario: narrated slots run fully with the utility port stubbed

- **WHEN** the narrated slots run with the model utility port stubbed out
- **THEN** the feed renders complete, with every line derived from deterministic events
- **AND** no model invocation occurs to produce any part of the feed

### Requirement: Landed feed lines anchor to their artifacts

A feed line whose work has landed as a navigable artifact (a processed project, a captured review) SHALL act as an anchor: activating it navigates to that artifact. A line with no landed artifact SHALL be honestly inert — it SHALL NOT present as navigable or dead-link.

#### Scenario: tapping a landed line opens the artifact

- **WHEN** the user activates a feed line whose work produced a navigable artifact
- **THEN** the interface navigates to that artifact

#### Scenario: a line without an artifact does not pretend

- **WHEN** a feed line's work has produced no navigable artifact
- **THEN** the line does not present as navigable
- **AND** activating it performs no broken navigation

### Requirement: Background refresh narration is visible

When a background context refresh narrates its pass on the progress transport, the interface SHALL surface it through the shared narration organ as an ambient indicator. It SHALL NOT interrupt or take over the user's current surface, and its absence of subscribers SHALL NOT be the steady state — the broadcast has a listener.

#### Scenario: a background refresh pass is visible while it runs

- **WHEN** a background refresh pass emits narration events
- **THEN** an ambient indicator driven by the shared narration organ reflects the pass
- **AND** the user's current surface is not interrupted or replaced

### Requirement: A long run survives leaving and returning

A narrated run SHALL continue when the user navigates away, and its progress SHALL remain observable: the project's card SHALL show an in-progress glyph while its run is live, and returning to the narrated slot SHALL re-attach to the live feed (or show the completed summary if the run finished while away). Progress for a resumable run SHALL be keyed by a stable identifier, not an identity minted per view mount.

#### Scenario: leaving does not kill or orphan the run

- **WHEN** the user leaves the processing slot while a run is live
- **THEN** the run continues to completion
- **AND** the project's card shows an in-progress glyph until it completes

#### Scenario: returning re-attaches to the live feed

- **WHEN** the user returns to the narrated slot while the run is still live
- **THEN** the feed re-attaches and continues from the run's current progress

#### Scenario: returning after completion shows the honest summary

- **WHEN** the user returns after the run completed while they were away
- **THEN** the slot shows the run's completed summary, including any per-part failures
