# Reopen a persisted review by id, and restore navigation across restarts

## Why

Two shipped features are capped by one missing primitive. A review that is fully
persisted locally cannot be reopened on its own: the only doors into the review
surface are `review.capture` (needs a live worktree) and `review.openPr` (needs
PR context). That is why #305 had to re-scope navigation persistence down to
recents-only — a restored surface pointing at a review could not render honestly.
Closing #324 (load a review by id) unblocks the final #297 follow-up (the
back/forward stack surviving an app restart) and makes retrospective reading of
old reviews first-class. This is a read of the user's own local state; there is
no gate to design (Rule Zero).

## What Changes

- New protocol command `review.load`: takes a persisted review id, returns
  `{ review, repositoryPresent }` from the local store. A pure read — no event is
  appended, the review renders exactly as persisted (R28: patchsets immutable).
  The existing freshness/delta machinery decides staleness *after* load; nothing
  blocks the load.
- Dispatch stops pinning addressed reviews to the globally-latest one:
  `requireLatestReview` becomes a by-id resolution over the store
  (`ReviewService.reviewById`), so every downstream command (canvases, flagged,
  noise, ask, reattach, handoff, …) works against a loaded older review. One
  function, all callers.
- Honest missing-context behavior: when the review's `repositoryRoot` no longer
  exists on disk, `review.load` still returns the persisted review with
  `repositoryPresent: false`; the renderer shows a plain status line, skips the
  working-tree freshness watcher (like a snapshot review), and live model
  surfaces that need the repo report their existing honest unavailable states.
  No confirmation, no gate — the persisted review always shows.
- Navigation-stack persistence (#297 remainder): the persisted nav state grows
  from recents-only to the full back/forward stack (additive, versioned local
  UI state; an unreadable or older blob degrades to the current recents-only
  behavior — no migration ceremony). On boot the app restores the stack and a
  landing rehydrator loads whatever the current surface needs (`review.load`
  for review-family surfaces, `project.detail` for project surfaces). An entry
  that can no longer load is dropped with a plain status, flooring to the
  nearest restorable ancestor (the Projects root always restores).
- Docs updated in the same change: delivery-order wave-4 entry, getting-started
  wayfinding paragraph, architecture-overview persistence section.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-review-persistence`: new requirement — any persisted review is loadable
  by id as a pure read (no event append), independent of which review is most
  recent; the store's addressability is by id, not latest-pinned.
- `desktop-review-surface`: "start and resume" extends to reopening any
  persisted review without its original worktree/PR context, with honest
  missing-context status; new requirement — the navigation stack (back/forward)
  persists across restarts and restores by rehydrating surfaces on landing,
  flooring honestly when an entry cannot load.

## Impact

- `packages/protocol/src/index.ts`: one new command definition (`review.load`).
- `packages/core/src/index.ts`: expose `ReviewService.reviewById` (delegates to
  the existing `ReviewStorePort.reviewById`).
- `apps/desktop/src/main/dispatch.ts`: `review.load` handler; the by-id
  resolution replacing the latest-pin; conditional watcher/allow-root when the
  repository is present.
- `packages/ui/src/nav/history.ts`: persisted schema v3 (stack + future +
  recents), parser accepts v2 recents.
- `packages/ui/src/app.tsx`: boot-time stack restore, the landing rehydrator,
  missing-context status, freshness-poll skip for absent roots.
- No changes to `Review`/`Patchset` schemas; no conflict with #327
  (patchset-bound flagged results) or #329 (delta-account fields) — no existing
  field changes, the one new wire field lives on the new command's output.
- Docs: `docs/src/content/docs/developing/reference/delivery-order.md`,
  `docs/src/content/docs/using/guide/getting-started.md`,
  `docs/src/content/docs/developing/concepts/architecture-overview.md`.
