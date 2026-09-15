## Why

The New Chat list makes you read every row to learn what it is. A row is a local branch or a pull request, and the whole distinction rides on one 3.5px icon mid-cell — a `GitBranch`, a `GitPullRequest`, a `GitMerge` — sitting next to a title that is doing all the shouting. The two facts that actually change what you would DO with a row — "this PR wants your review" and "this PR is yours" — are pills (`RowBadge`) floating beside the title, so they land at a different horizontal position on every row and the eye has to hunt. Ask "which of these needs me?" and the honest answer today is: read all of them.

Rai, 2026-09-14: *"how would you make it more obvious whether a branch is local or remote or a PR or your own PR or whatever in the new chat branch list... without resorting to pills. perhaps a column?"*

Pills fail because they stamp three independent axes onto one floating object: what the row **is** (local / PR), your **relationship** to it (yours / needs you / someone else's / done), and its **local condition** (checked out, dirty, ahead of the primary branch). Cram all three beside the title and the row is confetti; the two badges we ship are already that confetti at N=2. The axes want separate, fixed positions the eye learns once, not one crowded lane it re-reads per row.

## What Changes

- **A leading identity column.** A narrow, always-visible leftmost column carries the row's icon plus one quiet lowercase word — `local`, `PR`, `your PR`, `review`, `merged`, `closed` — one word per row, mutually exclusive, in a fixed position you scan top-to-bottom in a single pass. The icon moves out of the change cell into this column. The word is derived from `kind` + `mine` + `state` + review-requested, so it collapses the type axis and the relationship axis into one token.
- **The one gold accent, spent on the rows that need you.** A 2px left edge on the row, gold, drawn only when the row `needsYou` (your review was requested, or it is your own open PR with red CI). Everything else has no edge. This is DESIGN.md's single-gold-accent rule used exactly once, so gold keeps meaning "this one is waiting on you," and it never stands alone — the identity word (`review`) and the accent `GitPullRequestArrow` icon carry the same fact for anyone who does not see the colour.
- **A Local column for the on-disk facts.** A narrow column that answers "what is on my disk" for both kinds of row: a local worktree says clean/dirty and how far ahead/behind the primary branch it sits; a bare local branch (no checkout to measure) says only ahead/behind; a PR that is also checked out locally says so here instead of in a subline. The change cell keeps the title and the branch and stops carrying disk state.
- **The default order floats what needs you.** The opening order is `needsYou`, then `mine`, then recency — so the rows that are about you cluster at the top instead of scattering through an activity sort. Choosing any column header switches to that column's own sort, exactly as today; the composite order is only the default.
- **`RowBadge` is deleted.** No status pills. "Review requested" and "Your PR" now live in the identity column and the gold edge, in fixed positions, which is the whole point.

Not changing: the stage word (`captured` / `reviewed` / `prd`) stays off the row. It was shown once and cut as self-explaining chrome (`new-chat-view.dom.test.tsx` still asserts "the stage word is gone"), and re-adding it would reverse that. Recorded in the design as rejected, not silently dropped.

## Capabilities

### New Capabilities

- `new-chat-row-legibility`: the New Chat list differentiates a row's kind and the viewer's relationship to it through a leading identity column and a single gold edge rather than floating pills, states each row's on-disk condition in its own column, and opens on an order that floats the rows that need the viewer.

## Impact

- `packages/app-ui/src/project/new-chat-table.tsx`: a new leading `identity` column and `Local` column; `IdentityCell` and `LocalCell` renderers; `ChangeCell` loses the icon and the disk-state block; `RowBadge` is deleted; the fold table gains two narrow columns and the fold points are re-balanced; the row gains the conditional gold left edge.
- `packages/app-ui/src/project/smart-list.ts`: a `defaultRowOrder(rows)` helper (`needsYou`, then `mine`, then recency) consumed as the table's initial order; no wire or type change.
- `packages/app-ui/src/project/new-chat-view.tsx`: `DEFAULT_SORTING` becomes the composite default (no active column sort at open); the input rows are ordered by `defaultRowOrder`.
- Tests: `new-chat-view.dom.test.tsx` and `smart-list.test.ts` — the identity word per state, the gold edge only on `needsYou`, the disk facts in the Local column, the default order, and the absence of the two pills. The "stage word is gone" assertions stay.
- Docs: `docs/using/guides/getting-started.md` and `docs/using/guides/reviewing-a-github-pr.md` describe the list a reviewer reads; update any sentence that names the pills or says status sits beside the title.
- Harness cost: **nothing a session sends changes.** This is a pure client render of substrate the daemon already ships. Stated here so the reviewer does not look for a measurement.
