# Design — wayfinding-polish (#297)

Four slices over one substrate in `packages/ui/src/nav/history.ts`. All UI-only; no
protocol touch. Each slice is independently testable and independently revertible.

## Slice A — human-readable crumb labels

`crumb(stack)` today hardcodes `label: surface.projectId` / `surface.reviewId`.
Give it a resolver:

```
type SurfaceLabels = { project(id): string | undefined; review(id): string | undefined };
function crumb(stack: Surface[], labels?: SurfaceLabels): CrumbSegment[]
```

For `project`/`review`, use `labels?.project(id)` / `labels?.review(id)` and **fall
back to the id** when it returns undefined. `projects`/`draft`/`paper` keep their
fixed words. The id fallback is the honest floor: an unknown name never blanks the
crumb and never invents a label. `labels` is optional so existing callers/tests keep
compiling; `app.tsx` builds it from the data it already holds (`projectDetail.name`
or equivalent for the open project; `review.title`/name for the open review; the
recents/persisted surfaces resolve by the same map, id-fallback when not loaded).

Confirm the actual field names by reading `Project` / the review type; if a display
name field is absent, resolve from whatever human string is loaded (path/title) and
fall back to id — never fabricate.

## Slice B — recents log

A pure module in `nav/history.ts`:

```
type Recents = Surface[];               // most-recent first, deduped, capped (e.g. 8)
function recordRecent(recents, surface): Recents   // dedupe by surfaceIdentity, unshift, cap
function surfaceIdentity(surface): string          // kind + id
```

Record on every navigation that lands on a surface (push / forward / ascend / the
bootstrap restore). Recents are NOT the current stack — they include places you
backed out of; that's the point. The palette gains a **Recent** group (in
`command/commands.ts`, rendered by `command-palette.tsx`) listing each recent by its
resolved label (Slice A), each action `navigate(push(surface))`. Exclude the current
surface from the list (jumping to where you already are is noise). Cap and dedupe are
load-bearing — assert both.

## Slice C — persistence

Renderer `localStorage`, one key (e.g. `rennet.nav.v1`). Persist `{ stack, future,
recents }` whenever they change (an effect on the reducer state + recents). On boot,
before/alongside the `app.bootstrap` effect:

1. Read + parse the stored blob under a try/catch; a malformed/absent blob yields the
   clean default (`{ stack: [{kind:"projects"}], future: [], recents: [] }`) — never a
   throw, never a half-restored state.
2. **Reconcile with bootstrap.** `app.bootstrap` returns the restored review (or
   none). Hydrate the reducer from the stored stack, then:
   - If bootstrap restored review R and the stored tip already is R's review surface,
     keep it (do NOT double-push — the current code's unconditional
     `push({kind:"review", reviewId: restored.id})` must not stack a duplicate).
   - If the stored tip is a `review`/`draft`/`paper` surface whose review is NOT the
     bootstrap-restored one (stale or gone), **floor** the stack to its nearest
     resolvable ancestor (a `project`, else the `projects` root) and clear `future`,
     so you never land on a surface whose review isn't loaded. This is the honest
     floor — better a real parent than a broken review screen.
3. Persist a `version` in the blob; a version mismatch is treated as absent (clean
   default). Bump the key/version if the shape changes.

Provide the hydrate/floor logic as PURE functions in `nav/history.ts`
(`hydrate(stored, bootstrapReviewId): NavHistoryState` + a `serialize`/`parse` pair)
so the reconciliation is unit-tested without a DOM, and `app.tsx` only wires storage
+ the effect. localStorage access in `app.tsx` is guarded (SSR/absent storage → skip
persist, keep session-only behaviour) — no crash if `localStorage` is unavailable.

## Slice D — onboarding root crumb

The front door (`kind: "projects"`) already renders through `navigationSurface`, so
it shows the "Projects" root crumb. The gap is the pre-bootstrap branch
`if (review === undefined) return <div className="loading">Restoring local review…</div>`
(app.tsx ~1789) — a crumb-less frame at first paint. Wrap that first-run/loading
frame so it carries the same root breadcrumb (a single "Projects" home crumb, not
interactive is fine while loading), so the wayfinding spine is present from the very
first frame a new user sees. Keep it minimal — reuse `Breadcrumb` with a
root-only crumb; do not fabricate deeper crumbs before the stack exists.

## Rule Zero

Every slice is orientation only. No consent, no permission, no gate; nothing is made
harder or removed. Recents/history make returning cheaper; labels make the spine
readable; the root crumb makes first-run legible. Jumping to a recent or ascending a
crumb just navigates.

## Tests

- **A:** `crumb` resolves names via the resolver and **falls back to the id** when a
  name is unknown; fixed-word surfaces unchanged; no fabricated label.
- **B:** `recordRecent` dedupes by identity, unshifts most-recent-first, caps; the
  palette Recent group lists resolved labels, excludes the current surface, and its
  action navigates to the surface.
- **C:** `hydrate` from a valid blob restores stack+future; a malformed/absent/
  version-mismatched blob yields the clean default; the bootstrap-restored review is
  not duplicated; a stored tip whose review is stale floors to the nearest ancestor
  (never a dead review surface). Round-trip `serialize`→`parse` is identity.
- **D:** the first-run/loading frame renders the root breadcrumb.
- Full `NX_DAEMON=false pnpm check` green; only `packages/ui/src` changed.
