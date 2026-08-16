# Design — add-review-reopen

## Context

See proposal.md — Why. The relevant current state:

- `SqliteReviewStore.reviewById(reviewId)` already exists
  (`packages/adapters/src/sqlite-review-store.ts`) and folds the event history
  into a `Review`. `ReviewService` uses it privately (`requireReview`) for
  writes, but exposes nothing for reads.
- Dispatch (`apps/desktop/src/main/dispatch.ts`) resolves every id-addressed
  read through `requireLatestReview`, which asserts the addressed review IS the
  globally-latest one (`service.bootstrap()`). That pin is the single reason a
  loaded older review would fail in every downstream command.
- The renderer holds one review at a time (Rai's #297 decision 5: opening B
  evicts A) and keys every per-review effect (canvases, flagged, noise, threads,
  freshness poll) on `review.id`/`activePatchsetId`. Snapshot reviews already
  skip the working-tree freshness watcher (`isSnapshotReview`).
- Nav history (`packages/ui/src/nav/history.ts`) persists recents-only at
  `rennet.nav.v2`; the reducer already models `{stack, future}` in memory.
- #305's review proved why stack persistence was cut: a restored surface could
  not rehydrate (`projectDetail` never reloaded on boot; no load-review-by-id),
  so it rendered wrong content under the wrong crumb or crashed.

## Goals / Non-Goals

**Goals:**
- The smallest protocol + dispatch change that makes a persisted review
  addressable and loadable by id, and the renderer change that restores the
  surface stack across restarts by rehydrating on landing.

**Non-Goals:**
- No review tabs, no multi-review state (decision 5 stands: load evicts).
- No browsing of predecessor patchsets (decision 4 stands: trail-listed only).
- No persistence of per-review view state (selected file, lens, zoom) — the
  stack restores *where* you were, not every scroll position.
- No canvas/model-output persistence: reopened reviews regenerate live surfaces
  when the repo is present, and show the existing honest unavailable/failed
  states when it is not.
- No migration of the v2 nav blob beyond keeping its recents readable.

## Decisions

**D1 — `review.load` returns `{ review, repositoryPresent }`, nothing more.**
The issue asks for "the same shape the capture/openPr paths return" — that shape
is `{ review }` (the review already carries patchsets, activePatchsetId, and
dispositions). Canvases and threads already flow through their own id-keyed
commands (`review.canvases`, `review.reattach`) that the renderer fires whenever
a review lands, so bundling them into the load would duplicate two existing
paths. `repositoryPresent` (an `existsSync` on `review.repositoryRoot`) is the
one fact only main can cheaply provide and the renderer needs to render honest
missing-context status and to skip the freshness poll. Alternative considered:
a richer `context: {...}` object — rejected, one boolean covers the honest copy;
grow it if a second fact ever earns its place.

**D2 — kill the latest-pin at its root: `requireLatestReview` →
`requireReviewById`.** Dispatch's helper becomes a by-id resolution through a
new public `ReviewService.reviewById(reviewId)` (a one-line delegation to the
store; `requireReview` stays private for writes). Every downstream command
routes through this one helper, so the fix lands once for canvases, flagged,
noise, ask, reattach, symbol lookup, handoff, PR-body drafting, and delta
digest alike. Alternative considered: have `review.load` "activate" the loaded
review so it becomes latest — rejected: that writes an event to service a read
(violates the pure-read requirement and R28's spirit) and re-introduces the pin
everywhere else. The pin was a convenience from the one-review era, not a
safety property: every command still takes an explicit reviewId, repo-touching
commands still pass `assertAllowedRepository`, and publish targets still bind
to the review's own `postTarget`.

**D3 — main's load handler mirrors bootstrap, conditionally.** On
`review.load`: resolve by id (plain "Review not found" otherwise), check
`existsSync(repositoryRoot)`; only when present, `allowedRoots.add(root)` +
`startWatching(root)` (watching a missing path is noise; an absent root also
stays out of `allowedRoots`, so nothing repo-touching can run against a path
that isn't there — that is honesty about capability, not a gate: the persisted
review itself always returns).

**D4 — renderer: one landing rehydrator instead of a boot-special-path.** A
single effect watches the current surface: review-family surface whose id ≠ the
held review's id → `review.load`; project surface whose id ≠ the cached
`projectDetail` → the existing `project.detail` + `projects.list` reload (the
`goToRecent` logic, extracted). While rehydrating, the surface shows the
existing loading treatment — never another surface's content under the crumb
(the exact #305 bug class). On failure: plain error toast naming what could not
be reopened, and the entry is dropped (navigate back / floor to the nearest
ancestor; the Projects root needs no data). This one mechanism serves boot
restore, back/forward into a not-yet-loaded surface, and any future programmatic
navigation — no separate restore ceremony. `app.bootstrap` keeps returning the
latest review; when a persisted stack restores, the stack wins for navigation
and the rehydrator reconciles the held review to the tip.

**D5 — nav persistence: version 3, additive, forgiving parser.** The persisted
blob becomes `{ version: 3, recents, stack, future }` under a `rennet.nav.v3`
key. Parsing accepts v3 fully and a v2 blob's recents (three lines — keeps the
user's recents across the upgrade); anything else degrades to the clean default.
Every restored surface is shape-validated (known kind + non-empty id) exactly as
recents are today; any invalid entry invalidates only the stack, not the
recents. `review` surfaces are now legal in the persisted stack because D1–D4
make them restorable — the #305 exclusion is deleted, not worked around.

**D6 — missing-root reviews behave like snapshot reviews.** The renderer treats
`repositoryPresent: false` the way it treats `isSnapshotReview`: no 1.5s
freshness poll, no watcher — plus one plain status line on the review surface
("The original worktree is gone — showing the review as captured."). Repo-
dependent live surfaces (canvases) fail into their existing honest failed/
unavailable states with retry; the Files view, dispositions, delta account, and
reattached threads render fully from persisted state.

## Risks / Trade-offs

- [Removing the latest-pin lets two windows address different reviews] → There
  is one renderer window; the pin never provided isolation, only an assertion.
  Id-addressed resolution is strictly more correct: a stale renderer holding an
  evicted review now gets that review's real state instead of "Review not
  found".
- [A restored mid-stack project surface may reference a since-removed project]
  → The rehydrator's failure path drops the entry with a plain status; the
  Projects root always lands.
- [`review.canvases` against a review whose repo is gone burns a failed model
  attempt] → The renderer already knows `repositoryPresent` and skips straight
  to the honest unavailable state instead of firing a load that must fail.
- [v2 recents parse kept, stack starts empty on first v3 boot] → Deliberate:
  no migration ceremony; the stack fills from the first session's navigation.

## Migration Plan

None needed. The nav-blob version bump is self-contained local UI state with a
forgiving parser (D5); the protocol command is new; the dispatch helper change
is behavior-preserving for every existing caller (the addressed review was
always also findable by id).
