# Tasks — add-review-reopen

Red-first throughout: each group starts with a failing test (the positive
control) proving the behavior is absent, then makes it pass. Gate is
`pnpm check`.

## 1. Protocol + core: `review.load`

- [x] 1.1 RED: protocol test asserting `review.load` is a known command with
      input `{ commandId, reviewId }` and output `{ review, repositoryPresent }`
      — fails on current `commandDefinitions`.
- [x] 1.2 Add the `review.load` command definition to
      `packages/protocol/src/index.ts` (input: commandId + non-empty reviewId;
      output: `reviewSchema` + `repositoryPresent: z.boolean()`); test green.
- [x] 1.3 RED: core test asserting `ReviewService.reviewById` returns a
      persisted review by id when a newer review exists, and null for an
      unknown id — fails (method absent).
- [x] 1.4 Expose `ReviewService.reviewById(reviewId)` delegating to
      `ReviewStorePort.reviewById`; test green.

## 2. Dispatch: load handler + kill the latest-pin

- [x] 2.1 RED: dispatch test — with two persisted reviews, `review.load` of the
      OLDER id returns it as persisted with `repositoryPresent` reflecting an
      `existsSync` of its root, and appends no event (store event count
      unchanged; a second load returns the same review). Fails (no handler).
- [x] 2.2 RED: dispatch test — after loading the older review,
      `review.reattach` and `review.canvases` addressed to that id resolve it
      (no "Review not found"). Fails on `requireLatestReview`.
- [x] 2.3 Implement the `review.load` handler: resolve by id via
      `service.reviewById`, plain "Review not found" otherwise; when the root
      exists, `allowedRoots.add` + `startWatching`; when absent, neither.
- [x] 2.4 Replace `requireLatestReview` with `requireReviewById` (by-id via
      `service.reviewById`) for every id-addressed caller; keep
      `service.bootstrap()` for `app.bootstrap` only. Both RED tests green;
      existing dispatch tests stay green (positive control that the rename
      changed resolution, not behavior, for the latest review).
- [x] 2.5 Test: `review.load` of a review whose root is missing does NOT add
      the missing path to `allowedRoots` (a follow-up repo-addressed command
      against that path still refuses) while the load itself succeeded.

## 3. Nav history: persisted stack (v3)

- [x] 3.1 RED: `nav/history` tests — serialize emits
      `{ version: 3, recents, stack, future }`; parse restores all three from
      v3; parse of a v2 blob keeps its recents with an empty stack; corrupt or
      unknown-version blobs yield the clean default; an invalid stack entry
      drops the stack but keeps valid recents. Fail on the v2 shape.
- [x] 3.2 Bump `NAV_HISTORY_VERSION` to 3, extend `serialize`/`parse` with
      shape-validated stack + future (every `Surface` kind legal, including
      review-family); tests green.

## 4. Renderer: landing rehydrator + restore + honest missing context

- [x] 4.1 RED: DOM test — a persisted v3 stack `projects › project › review`
      restores on boot: the app lands on the review (via a mocked
      `review.load`), the breadcrumb shows the full trail, and back rehydrates
      the project surface via `project.detail`. Fails (stack not restored).
- [x] 4.2 RED: DOM test — while a landed surface is rehydrating, the loading
      treatment shows; another surface's content never renders under its crumb
      (the #305 regression control).
- [x] 4.3 RED: DOM test — `review.load` rejecting for the restored tip drops
      the entry with a plain status naming what could not be reopened and lands
      on the nearest restorable ancestor; a fully unrestorable stack lands on
      Projects.
- [x] 4.4 RED: DOM test — a review loaded with `repositoryPresent: false`
      renders the persisted files/dispositions, shows the plain
      worktree-gone status line, starts NO freshness poll (no
      `review.checkFreshness` calls fire), and the canvases view shows the
      honest unavailable state without invoking `review.canvases`.
- [x] 4.5 Implement: boot-time stack restore (persisted stack wins over the
      bootstrap push; `app.bootstrap` still supplies the held review), the
      landing rehydrator effect (review-family → `review.load`; project →
      extracted `project.detail` + `projects.list` reload shared with
      `goToRecent`), rehydration loading state, failure flooring, the
      missing-root status line, and the freshness/canvases skip keyed on
      `repositoryPresent`. All group-4 tests green.
- [x] 4.6 Persist stack + future on navigation changes (same localStorage write
      path as recents); test that navigating then re-mounting restores the same
      stack.

## 5. Docs (same change — definition of done)

- [x] 5.1 `docs/src/content/docs/developing/reference/delivery-order.md`: mark
      wave 4 delivered with a one-paragraph summary (review.load by id, by-id
      dispatch resolution, nav-stack restore; #324 closed, #297 closed).
- [x] 5.2 `docs/src/content/docs/using/guide/getting-started.md`: the
      wayfinding paragraph gains reopening old reviews + picking up where you
      left off after a restart, including the honest worktree-gone status.
- [x] 5.3 `docs/src/content/docs/developing/concepts/architecture-overview.md`:
      persistence section states reviews are loadable by id (`review.load`) and
      navigation state persists as renderer-local UI state.

## 6. Gate

- [ ] 6.1 Full `pnpm check` green across the workspace; confirm at least one
      test in each RED group was observed failing before its implementation
      landed (positive controls).
