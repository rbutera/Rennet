# Spec Delta

## MODIFIED Requirements

### Requirement: The workspace opens immediately with capture as its first lane

Starting a review SHALL open the review's workspace at once. Capture SHALL appear as the first stage inside that workspace, alongside the lens stages, and SHALL NOT be a separate screen. While capture runs, the surface SHALL show that work is under way through motion on the lens rail and the board area from the first frame, without naming internal steps, and SHALL offer cancel.

#### Scenario: a branch review opens
- **WHEN** the reviewer starts a review of a branch
- **THEN** the workspace is on screen before capture completes, with capture shown as the first stage and the lens stages queued behind it

#### Scenario: capture is running
- **WHEN** capture has started and no lens lane has opened yet
- **THEN** the lens rail and board area visibly animate as a waiting presence, Cancel is reachable, and no step label is shown

## ADDED Requirements

### Requirement: Preparation never shows internal-state copy

While a review is being prepared, cancelled or has failed, neither the board nor the chat pane SHALL show copy naming Rennet's machinery or an empty internal state (for example "New review", "No review is attached to this session", "No board for this generation yet."). The chat pane SHALL show the session's own title (its branch or pull request) with a loading skeleton until the thread exists.

#### Scenario: chat pane during capture
- **WHEN** the reviewer opens a pull-request session that is still capturing
- **THEN** the chat pane is titled with the branch name and shows a skeleton, not "New review" or "No review is attached…"

#### Scenario: board during capture
- **WHEN** capture is running
- **THEN** the board area shows the animated waiting presence, not "No board for this generation yet."

### Requirement: A preparation failure renders as one actionable block

When preparation fails, the waiting presence SHALL be replaced by one failure block that states what went wrong in plain words, offers the recovery action matching the failure's kind (Install for me, Choose large-file mode, Sign in, or Retry), always offers Retry, and keeps the raw tool output behind a details disclosure. The failure SHALL NOT be shown only as a thin strip over an empty board.

#### Scenario: git-lfs missing during checkout
- **WHEN** preparation fails because `git-lfs` is not installed
- **THEN** the block reads that Git LFS is needed to check out this pull request, offers Install for me and Skip large files, and Retry; the git stderr is visible only after opening details

#### Scenario: Git LFS installed from the block
- **WHEN** Install for me in the failure block finishes with Git LFS installed
- **THEN** the block shows that Git LFS is installed and makes Retry its primary action; nothing is retried until the user activates Retry, and an install that lands after the user cancelled sends nothing

#### Scenario: unknown failure
- **WHEN** preparation fails for an unclassified reason
- **THEN** the block shows a plain-language summary, Retry, and the raw reason under details
