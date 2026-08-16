# delta-rereview-account Specification (delta)

## Purpose

The deterministic, model-free account of what a returned (successor) patchset did relative to the reviewer's staged asks: per-ask addressed / partially-addressed / untouched, plus every change the agent made beyond any ask — at hunk grain where the substrate permits, path grain otherwise. It is the entry point of the delta re-review (journey stage 7): pure narration that gates nothing.

## ADDED Requirements

### Requirement: The deterministic account is complete without any model call

When a patchset activation succeeds a distinct prior patchset that carried staged asks, the system SHALL stamp a delta account computed entirely by deterministic arithmetic over the lineage carry and the prior-vs-successor content comparison — no model call. Per ask: an ask whose flagged target no longer exists byte-identically SHALL be reported `addressed`; an ask whose target carried byte-identically (matched by a rename-surviving identity) SHALL be reported `untouched` when its file otherwise did not change in content and `partially-addressed` when it did. Every path the successor changed that no ask covers SHALL be listed beyond-asks, so the changed set is partitioned totally — covered by an ask or beyond it, never dropped. The account SHALL be informational only: it gates no action and requires no acknowledgement.

#### Scenario: the four-fact fixture is stated in full

- **WHEN** a successor patchset addresses two of three staged asks, leaves the third untouched, and adds an unrequested change
- **THEN** the account states all four facts — two asks `addressed`, one `untouched`, and the unrequested change surfaced beyond-asks — with no model invoked

#### Scenario: a first capture carries no account

- **WHEN** a patchset activation has no distinct prior patchset with staged asks (a first capture or PR open)
- **THEN** no delta account is stamped and the review validates unchanged

### Requirement: Beyond-asks is surfaced at hunk grain

The account SHALL compute the successor's NEW hunks — hunks of the successor's per-file patch whose changed-line content (added plus deleted line bytes) appears in no hunk of the prior patch for that file or its rename source — and SHALL classify each new hunk against the asks: a hunk is COVERED when an ask targets its file path-grained, or when the ask's anchored span (at its carried, current path; deletions matched on the old-file range, otherwise the new-file range) intersects the hunk's range. Every uncovered new hunk SHALL be reported beyond-asks with its path and line range, in one of two named buckets: a hunk in a file NO ask targets (the loud scope-creep bucket), or a hunk inside an asked file but outside every asked span. Both buckets are honest narration of work the agent was allowed to do — the account SHALL NOT present a beyond-ask hunk as a violation, a warning to acknowledge, or a reason to block anything. The existing path-grain beyond-asks list SHALL remain present alongside the hunk-grain detail.

#### Scenario: an unrequested hunk inside an asked file is surfaced

- **WHEN** the successor changes an asked file both at the asked span and in a second, non-overlapping hunk no ask targets
- **THEN** the account reports the ask against its span AND reports the second hunk beyond-asks in the asked-file bucket, with its line range — it does not vanish into "partially addressed"

#### Scenario: a hunk in an unasked file lands in the loud bucket

- **WHEN** the successor adds a hunk in a file no ask targets
- **THEN** the account reports that hunk beyond-asks in the unasked-file bucket with its path and line range

#### Scenario: pure line-number drift is not a beyond-ask change

- **WHEN** a prior hunk reappears in the successor with identical changed-line content at shifted line numbers
- **THEN** it is not reported as a new hunk

### Requirement: Hunk claims degrade honestly to path grain

When a file's patch text is content-lossy (it carries the diff truncation marker) in either the prior or the successor patchset, the account SHALL make no hunk-grain claim for that file and SHALL report it at path grain only. An account produced before hunk grain existed (a persisted snapshot without the hunk fields) SHALL remain valid and SHALL render as the path-grain account it is. The system SHALL never display hunk precision it did not compute.

#### Scenario: a truncated patch yields path grain for that file

- **WHEN** the successor's patch for a changed file carries the truncation marker
- **THEN** that file appears in the path-grain beyond-asks (or its ask's status) with no hunk-grain rows, while untruncated files keep hunk grain

#### Scenario: a pre-existing persisted account still validates and renders

- **WHEN** a review persisted before this change (its account has no hunk-grain fields) is reloaded
- **THEN** it validates and the panel renders the path-grain account unchanged

### Requirement: A handoff run's asks are attributed to their composed tasks

When the successor patchset was captured by a handoff run, the account SHALL attribute each staged ask to the composed task that carried it — the task index from the verified bundle's traceMap, plus that task's preview title — matched from the ask trace the run hands to the capture. A capture with no handoff trace (a plain regenerate) SHALL carry no attribution and SHALL otherwise compute identically. Attribution is narration: it SHALL NOT alter any ask's status or gate anything.

#### Scenario: an ask names the task that ran it

- **WHEN** a handoff run of a composed bundle captures a successor and the account is stamped
- **THEN** each ask that maps to a bundle ask carries the index and preview title of the composed task the traceMap assigns it

#### Scenario: a regenerate carries no attribution

- **WHEN** a successor is captured outside any handoff run
- **THEN** the account's asks carry no task attribution and the rest of the account is unchanged

### Requirement: The rendered account anchors at hunk grain and its prose stays grounded in the account

The account panel SHALL render the beyond-ask hunks with their buckets, and activating a hunk-grain item SHALL navigate the diff to that hunk's span (not merely its file). The optional light-tier prose digest SHALL be built from ONLY the structured account including its hunk-grain facts — no diff text, no repository content — so it can state no fact the account does not carry; when the account has no hunk-grain detail the digest prompt carries the path-grain facts as before.

#### Scenario: tapping a beyond-ask hunk navigates to the hunk

- **WHEN** the reviewer activates a beyond-ask hunk row in the account panel
- **THEN** the diff navigates to that hunk's path and line range

#### Scenario: the digest prompt carries the hunk facts and nothing else

- **WHEN** the digest prompt is assembled over an account with hunk-grain beyond-asks
- **THEN** the prompt lists each beyond hunk's path, range, and bucket, and contains no content outside the structured account
