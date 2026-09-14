## Context

`ChangeCell` (`new-chat-table.tsx`) folds four things into one cell today: the kind icon, the title/branch, the relationship pill (`RowBadge`), and the on-disk state (a clean/dirty pill and ahead/behind arrows on local rows; a "checked out locally" subline on PR rows). The table is a TanStack table whose columns fold from the right as the canvas narrows, defaulting to an activity-desc sort. `SmartRow` (`smart-list.ts`) already carries every fact this change needs — `kind`, `mine`, `state`, `needsYou`, `pr.reviewRequested`, `local.{dirty,worktree,ahead,behind}`, `checkedOutLocally` — so this is a presentation change with no new wire data.

The distinctions the reviewer asked to see are three independent axes (type, relationship, on-disk condition). The design gives each a fixed position instead of stacking them beside the title.

## Decisions

### D1 — A leading identity column reads type-and-relationship as one word

A new leftmost column `identity`, always visible (it never folds; it is the primary differentiator), narrow enough for an icon plus one short word. It carries the icon that lived in `ChangeCell` and one lowercase token, mutually exclusive, derived once:

| condition | icon | word |
| --- | --- | --- |
| PR, open, review requested from viewer | `GitPullRequestArrow` (accent) | `review` |
| PR, open, `mine`, not review-requested | `GitPullRequest` | `your PR` |
| PR, open, not `mine`, not review-requested | `GitPullRequest` (faint) | `PR` |
| PR, `merged` | `GitMerge` | `merged` |
| PR, `closed` | `GitPullRequest` (faint) | `closed` |
| local | `GitBranch` (constant faint — dirty is owned by the Local column, never this always-visible icon) | `local` |

One row yields exactly one token because the conditions are ordered and disjoint: review-requested outranks `mine` outranks plain PR, and a non-open PR is `merged`/`closed` before any of them. The word is a `<span>`, not a pill — no fill, no border, no rounded chrome. It reads down the column as a lane; the eye learns the six words once and never hunts.

*Rejected:* keeping the icon-only signal and adding the word elsewhere. The icon at 3.5px is exactly the signal that failed; the word is the fix, and it belongs in the same fixed column as the icon so the two reinforce.

### D2 — The one gold accent marks the rows that need you

The row gains a 2px left edge (an inset box-shadow so it does not shift the cell box), coloured `accent` only when `row.needsYou`, and drawn as nothing otherwise. `needsYou` is already the derived "your review was requested, or your own open PR's CI is red" (`smart-list.ts`), so the edge needs no new predicate. This is the single gold accent DESIGN.md permits, spent once, on the one question a reviewer opens this list to ask. Colour never stands alone: every edged row carries a screen-reader-only attention label naming why it needs the viewer (`Review requested`, or `Your pull request, CI failing`), so the edge never stands alone for assistive technology at any width. A review-requested row also reinforces with the visible `review` word and accent `GitPullRequestArrow`; the own-failing-CI row reads `your PR` with the failing-CI mark — the CI mark folds below 54rem and its aria-label is `aria-hidden` on the `Icon` wrapper, which is exactly why the sr-only label, not the CI icon, is what guarantees the edge has a spoken companion.

*Rejected:* a second edge colour for `mine`, or for "someone else's." Two accents is the confetti problem back in a thinner disguise; the identity word already carries `your PR`, and a neutral row needs no mark.

### D3 — A Local column states each row's on-disk condition

A narrow column `local` (header "Local"), folding no earlier than the CI column, answering one question for both kinds of row: what is on my disk?

- **Local worktree** (`kind === "local"`, `local.worktree`): the clean/dirty mark (copper dot + `dirty`, or green dot + `clean`) and, when non-zero and computable, ahead/behind as the drawn arrows with the screen-reader words (`N ahead`, `N behind`) — the exact controls that live in `ChangeCell` today, relocated. `ahead`/`behind` of `null` (base unresolvable) draw nothing, never `0`.
- **Bare local branch** (`kind === "local"`, not `worktree`): ahead/behind only, no cleanliness word — a bare branch has no checkout to measure, so it says nothing about clean/dirty (no self-explaining chrome), exactly as today.
- **PR checked out locally** (`checkedOutLocally` present): a `GitBranch` icon + `checked out`, with the copper dirty dot when that checkout is dirty. This replaces the "checked out locally" subline text in `ChangeCell`.
- **PR not checked out**: an em dash.

The change cell keeps the title (PR) or branch (local), the `#number`/`!number`, the `Merged` tag, and the branch name; it stops carrying disk state. So the two on-disk pills leave the title lane and the three axes are now in three columns.

*Rejected:* a boolean pushed/local-only column. `LocalWork` carries no remote-tracking ref — a purely local row has no PR by construction, and ahead/behind is measured against the primary branch, not a remote. Naming a column "pushed" would claim data we do not have; "Local" states only what the substrate knows.

### D4 — The default order floats what needs you; a column click overrides it

The table opens with no active column sort. The input rows are ordered by `defaultRowOrder`: `needsYou` first, then `mine`, then `lastActivityAt` descending — a `SmartRow` comparator beside the existing `sortSmartRows`, reusing its recency tiebreaker. Choosing any column header sets that column's sort and the composite order gives way entirely, exactly as a column sort behaves today. So the opening view answers "what needs me, then mine, then what moved recently," and every explicit sort still works.

`DEFAULT_SORTING` becomes `[]` (no column actively sorted at open) and the view sorts its rows through `defaultRowOrder` before handing them to the table. The activity column is still sortable; it is simply not the pre-selected sort.

*Rejected:* keeping activity-desc as the active default and adding a hidden needs-you pre-sort. A single active column sort in TanStack reorders the whole model, so the boost would vanish the moment the activity sort ran; the honest expression is to make the composite order the default and let a column click replace it.

### D5 — Stage stays off the row (rejected re-addition)

`LocalWork.stage` (`captured` / `reviewed` / `prd`) is real substrate the wire carries and `localRow` drops. Surfacing it was considered and is rejected: it was shown on the row once and deliberately cut as self-explaining chrome, and `new-chat-view.dom.test.tsx` still pins "the stage word is gone." The stage is a fact about Rennet's local pipeline position, not about the branch a reviewer is choosing between, which is the exact shape the no-self-explaining-chrome rule names. Re-adding it belongs in its own change with its own argument, not smuggled into a legibility pass. Recorded here so the next reader does not re-discover the deletion as a bug.

## Risks / Trade-offs

- **Two more columns on an already-folding table.** Both new columns are narrow (an icon plus a short word). The identity column never folds; the Local column folds with CI. The change cell stays `w-full` and absorbs the remaining width. The fold points are re-balanced in the same file, and the `@container` comment block is updated to match.
- **The default-order change is a visible behaviour change.** The list no longer opens sorted purely by activity. This is the intended improvement, and it is reversible by clicking the Activity header. Documented in the getting-started guide.
- **Screen-reader parity.** Every colour and icon signal has a word: the identity token, the CI aria-labels (unchanged), the ahead/behind screen-reader spans (relocated, unchanged), and — for the gold edge — an sr-only attention label on every edged row naming why it needs the viewer. The gold edge is decorative reinforcement for a sighted reviewer; the sr-only label is what carries its meaning to assistive technology, so the edge never stands alone at any width.
