## ADDED Requirements

### Requirement: A leading identity column names each row's kind and relationship in one word

The New Chat list SHALL carry a leading, always-visible column that renders, for each row, the row's kind icon and exactly one lowercase word naming what the row is and the viewer's relationship to it. The word SHALL be one of `local`, `PR`, `your PR`, `review`, `merged`, `closed`, derived from the row's kind, ownership, lifecycle state, and whether the viewer's review was requested, and the conditions SHALL be disjoint so that every row yields exactly one word. The word SHALL NOT be rendered as a pill (no fill, border, or rounded chrome). This column SHALL NOT fold out as the canvas narrows.

#### Scenario: A PR whose review was requested reads "review"

- **WHEN** the list renders an open PR whose review was requested from the viewer
- **THEN** its identity column shows the `GitPullRequestArrow` icon and the word `review`

#### Scenario: The viewer's own open PR reads "your PR"

- **WHEN** the list renders an open PR the viewer authored, with no review requested from them
- **THEN** its identity column shows the word `your PR`

#### Scenario: A local branch reads "local"

- **WHEN** the list renders a local-work row
- **THEN** its identity column shows the `GitBranch` icon and the word `local`

#### Scenario: A merged PR reads "merged"

- **WHEN** the list renders a merged PR
- **THEN** its identity column shows the `GitMerge` icon and the word `merged`

### Requirement: The single gold accent marks the rows that need the viewer

The list SHALL draw a gold left edge on a row when and only when the row needs the viewer — the viewer's review was requested, or it is the viewer's own open PR whose CI is failing — and SHALL draw no such edge on any other row. The edge SHALL NOT be the only signal of that state: a row that carries the edge SHALL also carry the `review` identity word and the accent request icon.

#### Scenario: A review-requested row carries the edge

- **WHEN** the list renders a PR whose review was requested from the viewer
- **THEN** the row shows the gold left edge and the `review` word

#### Scenario: A plain teammate PR carries no edge

- **WHEN** the list renders an open PR the viewer did not author and whose review was not requested from them
- **THEN** the row shows no gold edge

### Requirement: A Local column states each row's on-disk condition

The list SHALL carry a column that states what is on the viewer's disk for each row. A local worktree row SHALL show its clean/dirty condition and, when computable and non-zero, how far ahead of and behind the primary branch it sits. A bare local branch SHALL show ahead/behind only and SHALL NOT show a cleanliness word. A PR that is checked out locally SHALL be marked as checked out here, with a dirty indicator when that checkout is dirty. A PR that is not checked out SHALL show an em dash. An un-computable ahead/behind (`null`) SHALL render nothing rather than `0`. The change cell SHALL NOT render on-disk state.

#### Scenario: A dirty worktree states its condition in the Local column

- **WHEN** the list renders a local worktree with uncommitted changes that is two commits ahead of the primary branch
- **THEN** the Local column shows the dirty mark and `2 ahead`, and the change cell shows no clean/dirty or ahead/behind

#### Scenario: A bare branch says nothing about cleanliness

- **WHEN** the list renders a bare local branch (no checkout on disk)
- **THEN** the Local column shows its ahead/behind and no clean/dirty word

#### Scenario: A checked-out PR is marked in the Local column

- **WHEN** the list renders a PR that is also checked out locally
- **THEN** the Local column marks it as checked out, and the change cell does not carry a "checked out locally" subline

### Requirement: The list opens on an order that floats what needs the viewer

The list SHALL open with no column actively sorted and SHALL order its rows by whether they need the viewer first, then by whether the viewer owns them, then by recency of activity. Selecting a column header SHALL replace this order with that column's own sort.

#### Scenario: A needs-you row opens above a more recently active row

- **WHEN** the list opens with a review-requested PR that last moved a week ago and a teammate PR that moved an hour ago and does not need the viewer
- **THEN** the review-requested PR appears above the teammate PR and no column header shows as actively sorted

#### Scenario: Sorting by activity overrides the default order

- **WHEN** the viewer clicks the Activity column header
- **THEN** the rows sort by activity descending regardless of whether any row needs the viewer
