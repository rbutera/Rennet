## 1. The identity column (D1)

- [x] 1.1 Add an `identity` column as the leftmost column, always visible (no `fold`), narrow. Move the kind icon out of `ChangeCell` into an `IdentityCell`. `ChangeCell` keeps the title/branch, `#number`, `Merged` tag and branch subline, and loses its leading icon and its `RowBadge` call
- [x] 1.2 `IdentityCell` derives one token from `kind` + `mine` + `state` + `pr.reviewRequested` per D1's table (ordered, disjoint): `review` / `your PR` / `PR` / `merged` / `closed` / `local`, each with its icon and colour. The word is a plain `<span>`, no pill chrome. Control: a fixture with one row of each state renders each word exactly once and no `rounded-full` badge remains in the change cell
- [x] 1.3 Delete `RowBadge`. Control: "Review requested" and "Your PR" no longer render as pills; the identity column carries `review` and `your PR` instead

## 2. The gold edge (D2)

- [x] 2.1 The row draws a 2px `accent` left edge (inset box-shadow, no layout shift) when and only when `row.needsYou`; no edge otherwise. Control: a review-requested row and an own-PR-with-red-CI row carry the edge; a plain PR, a teammate PR, a merged PR and a local row do not
- [x] 2.2 Confirm colour never stands alone: the edged rows also render the `review` word and the accent `GitPullRequestArrow`. Control: the edge is present with the word, never the only signal

## 3. The Local column (D3)

- [x] 3.1 Add a `local` column (header "Local"), folding with the CI column (`FROM_54` or later), with a `LocalCell` renderer. Move the clean/dirty mark and the ahead/behind arrows out of `ChangeCell` for local rows into `LocalCell`; move the "checked out locally" text out of the PR subline into `LocalCell` as a `GitBranch` + `checked out` marker (with the dirty dot when `checkedOutLocally.dirty`)
- [x] 3.2 `LocalCell` cases per D3: local worktree → dirty/clean + ahead/behind; bare branch → ahead/behind only, no cleanliness word; PR checked out → `checked out` + dirty dot; PR not checked out → em dash. Controls: a bare branch renders no cleanliness word; `ahead`/`behind` of `null` render nothing (never `0`); the existing `data-worktree` and `N ahead`/`N behind` screen-reader spans survive the move (assert they are still in the row)
- [x] 3.3 `ChangeCell` no longer renders disk state. Control: the change cell of a local row shows the branch name and nothing about clean/dirty or ahead/behind; the "stage word is gone" assertions still hold

## 4. The default order (D4)

- [x] 4.1 Add `defaultRowOrder(rows)` to `smart-list.ts`: sort by `needsYou` desc, then `mine` desc, then `lastActivityAt` desc, reusing the recency tiebreaker. Unit control in `smart-list.test.ts`: a needs-you row precedes an older own PR which precedes a stale teammate PR
- [x] 4.2 `DEFAULT_SORTING` becomes `[]`; the view orders its rows through `defaultRowOrder` before the table. Control: at open, a needs-you row sits above a more-recently-active row that does not need the viewer, and no column header shows as actively sorted
- [x] 4.3 Clicking the Activity header restores a pure activity-desc sort (the composite order gives way). Control: after the click, the most-recent row is first regardless of `needsYou`

## 5. Documentation

- [x] 5.1 `docs/using/guides/getting-started.md`: the New Chat list paragraph — the identity column and its words, the gold edge meaning "needs you", the Local column, and the default order that floats what needs you. Remove any sentence describing the pills or "status beside the title"
- [x] 5.2 `docs/using/guides/reviewing-a-github-pr.md`: any sentence that names the "Review requested" / "Your PR" pills becomes the identity word + the gold edge
- [ ] 5.3 The cost sentence is delivered in the PR description by the orchestrator: nothing a session sends changes; this is a pure client render of substrate the daemon already ships

## 6. Acceptance

- [ ] 6.1 `pnpm check` green (full gate, positive control capable of failing)
- [ ] 6.2 Screenshots of the New Chat list on a multi-state fixture (a review-requested PR, an own PR, a teammate PR, a merged PR, a local worktree, a bare branch) attached to the PR for acceptance: the identity lane, the single gold edge, and the Local column all visible
