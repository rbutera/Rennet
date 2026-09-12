## ADDED Requirements

### Requirement: A review can be started from a terminal against the running daemon

`rennet review <base>..<head> [path]` and `rennet review --pr <number> [path]` SHALL open a review over the running daemon by the same session path the New Chat front door uses (`session.mint`), resolving the repository at `path` (default: the current directory) to its git toplevel and to the project that contains it. A repository that is not yet a project SHALL be added with the daemon's own discover and add commands and their defaults, and the command SHALL say that it did. The command SHALL NOT capture or draft through a path the desktop does not use.

#### Scenario: A range over a repository that is already a project
- **WHEN** `rennet review main..feat/x` runs in a repository one project contains
- **THEN** a session is minted for that project with `branch: feat/x` and `base: main`, and the captured patchset's base OID is `merge-base main feat/x`

#### Scenario: A repository nobody has added
- **WHEN** `rennet review main..feat/x` runs in a repository no project contains
- **THEN** exactly one project is added for it before the mint, one line on stdout names the addition, and a second run adds nothing

#### Scenario: A pull request by number
- **WHEN** `rennet review --pr 12` runs
- **THEN** the target is the `project.detail` row numbered 12 and the mint carries that row's branch, repository and PR number, so a desktop session for the same PR is reattached rather than duplicated

### Requirement: A minted branch session may name its base

`session.mint`'s target SHALL accept an optional `base` ref. When present on a branch target, the capture SHALL take the merge-base of `base` and the branch instead of the project's primary branch. When absent, the capture SHALL be identical to the capture without this field. Beside `prNumber` the field SHALL have no effect. The claim key SHALL remain `(repository, branch)`.

#### Scenario: An explicit base
- **WHEN** a session is minted with `branch: feat/x` and `base: release/2`
- **THEN** the patchset's `baseRef` is `release/2` and its `baseOid` is `merge-base release/2 feat/x`

#### Scenario: The default is untouched
- **WHEN** a session is minted with `branch: feat/x` and no `base`
- **THEN** the patchset's `baseRef` is the project's primary branch, byte-for-byte as before this change

### Requirement: Progress is printed as the daemon reports it

While the session's preparation is `capturing` or `drafting`, the command SHALL print one stdout line, prefixed with the seconds elapsed since the mint returned, for each of: a change of capture step; a change of any lane's status, with its verdict or reason; a change of any seat's live line, named by seat and provider; and each `lensDraft` frame for the review, with the lens and the number of elements written. Lines SHALL be plain text with no cursor control. The command SHALL NOT print a line no daemon event produced.

#### Scenario: A seat reports what it is doing
- **WHEN** the Flagged lane's Codex seat's live line changes to "reading packages/server/src/cli.ts"
- **THEN** one line naming the lane, the seat, the provider and that text is printed, and nothing is printed while the line does not change

#### Scenario: A board fills in
- **WHEN** a `lensDraft` frame for the review arrives carrying three elements for `sequence`
- **THEN** one line reads that `sequence` wrote 3 elements

#### Scenario: A lane settles without a board
- **WHEN** the Design lane settles `absent` with reason `no-spec`
- **THEN** one line names the lane, `absent`, and `no-spec`

### Requirement: The result is written to a stable path and the path is printed last

When the preparation settles, the command SHALL write one JSON document to `<data dir>/reviews/<reviewId>.json`, or to `--out <file>`, creating the directory and replacing an existing file, and SHALL print that absolute path as its final stdout line. The document SHALL carry the review as `review.load` returns it, the range, the current generation id, every lens's `board.read` answer (board, absence or failure) for that generation, the settled lanes with their seats, the outcome, and the start and settle times. It SHALL NOT fabricate a board for a lens that reported an absence or a failure.

#### Scenario: A consumer reads the last line
- **WHEN** a script captures stdout and takes its last line
- **THEN** that line is the absolute path of a file that parses as the review document

#### Scenario: An absent lens stays absent
- **WHEN** `board.read` answers `absence: no-noise` for `noise`
- **THEN** the document's `boards.noise` carries `absence: "no-noise"` and no `board`

### Requirement: An unchanged target exits fast; a moved target is re-captured

When the mint reattaches to a session whose review's active patchset head is the requested head and whose preparation has settled, the command SHALL write the document from the persisted review and boards and exit 0 without minting or drafting. When the mint reattaches to a running preparation, the command SHALL attach to it. When the reattached session's review is at another head, or its preparation failed before a review existed, the command SHALL mint a successor with `replacesSessionId` and say which session was archived. When the reattached preparation failed at the boards stage with a review present, the command SHALL retry that preparation rather than re-capture.

#### Scenario: Nothing changed
- **WHEN** `rennet review main..feat/x` runs twice with no new commits
- **THEN** the second run mints nothing, starts no preparation, writes the same document and exits 0

#### Scenario: New commits on the branch
- **WHEN** `feat/x` gains a commit between two runs
- **THEN** the second run mints a successor session, the first session is archived, and the new document's head OID is the new tip

### Requirement: Exit codes carry the outcome, and a failure still writes

The command SHALL exit `0` when the boards settled and the document was written; `1` when no healthy daemon is found, when the preparation ended `failed` or `cancelled`, when `--timeout <seconds>` (default 1800) elapsed, or when the document could not be written; `2` on a usage error. In the failed, cancelled and timeout cases the document SHALL still be written with `outcome` and `reason` and every lane as it stood. A timeout SHALL NOT cancel the daemon's preparation.

#### Scenario: The boards stage fails
- **WHEN** the drafting fails after three lanes settled
- **THEN** the command exits 1, stderr carries the reason, and the document carries `outcome: "failed"`, the reason, and the three settled boards

#### Scenario: The daemon is not running
- **WHEN** no daemon claim is healthy for the data directory
- **THEN** the command exits 1 with the same message `rennet pair` prints, before any other output

#### Scenario: The clock runs out
- **WHEN** `--timeout 60` elapses while a seat is still drafting
- **THEN** the command exits 1 with `outcome: "timeout"` in the document, and the session's preparation is still `drafting` on the daemon
