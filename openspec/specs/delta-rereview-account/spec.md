# delta-rereview-account Specification

## Purpose
Defines the deterministic account of how a successor patchset addressed each staged ask and which changes fell outside those asks. It reports hunk detail when available and path detail otherwise, without gating any action.
## Requirements
### Requirement: The deterministic account is complete without any model call

When a patchset activation succeeds a distinct prior patchset with staged asks, the system SHALL compute a delta account without a model call. It SHALL use lineage carry and compare the prior and successor content. An ask whose flagged target no longer exists byte-identically SHALL be `addressed`. An ask whose target carried byte-identically through rename-surviving identity SHALL be `untouched` when the file content did not otherwise change and `partially-addressed` when it did. Every changed path not covered by an ask SHALL appear in beyond-asks. The account SHALL be informational and require no acknowledgement.

#### Scenario: the four-fact fixture is stated in full

- **WHEN** a successor patchset addresses two of three staged asks, leaves the third untouched, and adds an unrequested change
- **THEN** the account states that two asks were `addressed`, one was `untouched`, and one unrequested change appears in beyond-asks, with no model invoked

#### Scenario: a first capture carries no account

- **WHEN** a patchset activation has no distinct prior patchset with staged asks (a first capture or PR open)
- **THEN** no delta account is stamped and the review validates unchanged

### Requirement: Beyond-asks is surfaced at hunk grain

The account SHALL compute the successor's new hunks. A new hunk is one whose added and deleted line bytes appear in no prior hunk for the file or its rename source. It SHALL classify a new hunk as covered when an ask targets the whole path or when the ask's current anchored span intersects the hunk's range. Deletions SHALL match against the old-file range, and other changes SHALL match against the new-file range. Every uncovered new hunk SHALL appear in beyond-asks with its path and line range. Hunks in files targeted by no ask SHALL use the unasked-file bucket. Hunks outside every asked span in an asked file SHALL use the asked-file bucket. Neither bucket SHALL imply a violation or block an action. The path-level beyond-asks list SHALL remain present beside hunk detail.

#### Scenario: an unrequested hunk inside an asked file is surfaced

- **WHEN** the successor changes an asked file both at the asked span and in a second, non-overlapping hunk no ask targets
- **THEN** the account reports the ask against its span and reports the second hunk in the asked-file beyond-asks bucket with its line range

#### Scenario: a hunk in an unasked file lands in the loud bucket

- **WHEN** the successor adds a hunk in a file no ask targets
- **THEN** the account reports that hunk beyond-asks in the unasked-file bucket with its path and line range

#### Scenario: pure line-number drift is not a beyond-ask change

- **WHEN** a prior hunk reappears in the successor with identical changed-line content at shifted line numbers
- **THEN** it is not reported as a new hunk

### Requirement: Hunk claims degrade honestly to path grain

When either patchset carries the diff truncation marker for a file, the account SHALL make no hunk-level claim for that file and SHALL report only path detail. A persisted account without hunk fields SHALL remain valid and render its path-level data. The system SHALL never display precision it did not compute.

#### Scenario: a truncated patch yields path grain for that file

- **WHEN** the successor's patch for a changed file carries the truncation marker
- **THEN** that file appears in the path-grain beyond-asks (or its ask's status) with no hunk-grain rows, while untruncated files keep hunk grain

#### Scenario: An account without hunk fields validates and renders

- **WHEN** a persisted review has an account without hunk fields
- **THEN** it validates and the panel renders the path-grain account unchanged

### Requirement: A handoff run's asks are attributed to their composed tasks

When a handoff run captures the successor patchset, the account SHALL attribute each staged ask to its composed task. It SHALL use the task index from the verified bundle's traceMap and the task's preview title, matched through the ask trace supplied to capture. A capture without a handoff trace SHALL carry no attribution and compute the same statuses. Attribution SHALL NOT alter status or gate an action.

#### Scenario: an ask names the task that ran it

- **WHEN** a handoff run of a composed bundle captures a successor and the account is stamped
- **THEN** each ask that maps to a bundle ask carries the index and preview title of the composed task the traceMap assigns it

#### Scenario: a regenerate carries no attribution

- **WHEN** a successor is captured outside any handoff run
- **THEN** the account's asks carry no task attribution and the rest of the account is unchanged

### Requirement: The rendered account anchors at hunk grain and its prose stays grounded in the account

The account panel SHALL render beyond-ask hunks with their buckets. Activating a hunk item SHALL navigate the diff to that hunk's span, not only its file. The optional light-tier digest SHALL use only the structured account, including its hunk facts. It SHALL receive no diff text or repository content. When the account has no hunk detail, the digest prompt SHALL carry only path facts.

#### Scenario: tapping a beyond-ask hunk navigates to the hunk

- **WHEN** the reviewer activates a beyond-ask hunk row in the account panel
- **THEN** the diff navigates to that hunk's path and line range

#### Scenario: the digest prompt carries the hunk facts and nothing else

- **WHEN** the digest prompt is assembled over an account with hunk-grain beyond-asks
- **THEN** the prompt lists each beyond hunk's path, range, and bucket, and contains no content outside the structured account
