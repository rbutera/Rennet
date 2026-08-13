# Wayfinding polish — the four #297 follow-ups (#297)

## Why

The v4.0 wayfinding spine (PR #301) shipped the surface-stack model, breadcrumb,
nav rail, and back/forward. Four deliberate polish follow-ups were left on #297, each
small but each a real rough edge in day-to-day use:

1. **Breadcrumb labels are ids.** `crumb()` renders `surface.projectId` and
   `surface.reviewId` verbatim — the breadcrumb reads "Projects › a1b2c3 › 9f8e7d"
   instead of names. Unreadable orientation.
2. **No recents in the palette.** The palette's Navigate group can jump to fixed
   destinations, but there is no "where was I" — nothing lists the places you've
   actually visited.
3. **History is session-only.** `navHistoryReducer` lives in a `useReducer`, so a
   restart drops the whole back/forward stack. You reopen to a bare root.
4. **The first-run frame has no root crumb.** The pre-bootstrap "Restoring local
   review…" frame renders with no breadcrumb at all, so the wayfinding spine is
   absent at the exact moment a new user first looks at the app.

These share substrate — labels feed both the crumb and the recents list; recents and
history share one persisted store — so they land best as one change with clean,
independently-testable slices.

## What changes

- **Human-readable crumbs.** `crumb()` takes a label resolver that turns a surface
  into its project/review NAME, falling back to the id when the name is unknown (the
  honest floor — never a blank crumb, never a wrong name).
- **Recents.** A small recents log records distinct visited surfaces (most-recent
  first, deduped by identity, capped). A palette **Recent** group lists them by their
  human-readable label and jumps to them.
- **Persistence.** The nav stack + future + recents persist to the renderer's
  `localStorage` and rehydrate on boot, reconciled with `app.bootstrap` so a surface
  is never duplicated and a stale/dead review surface floors to its nearest
  resolvable ancestor rather than landing you on a broken screen.
- **Onboarding root crumb.** The first-run / loading frames carry the same root
  breadcrumb the front door already shows, so the spine is present from first paint.

## Impact

- Affected: `packages/ui/src` only — `nav/history.ts` (crumb resolver, recents log,
  hydrate/persist helpers), `components/breadcrumb.tsx` (unchanged rendering, richer
  labels), `command/commands.ts` + `components/command-palette.tsx` (Recent group),
  `app.tsx` (thread the resolver, persist/rehydrate, first-run crumb), `styles.css`.
- **No protocol / IPC change.** Persistence is renderer-side `localStorage`; labels
  come from already-loaded project/review data. Nothing new crosses the bridge.
- Rule Zero: pure orientation/navigation improvements — no gate, no consent, no
  capability removed. Recents and history just make returning cheaper.
- Closes the four wayfinding follow-ups deferred on #297.
