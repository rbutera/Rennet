# C13 — Onboarding coach marks

## Why

INVENTORY §11 (26 claims) + R55 (#458) call for a coach-mark system: contextual
tips, one on screen at a time, chained per surface, skippable and re-summonable.
R55 law 10 makes this the *one* sanctioned place for explanatory copy in the
chrome — everywhere else labels only name things; the first-launch tour is where
the product is allowed to teach. That is the "voice split": tour marks carry a
teaching title + one-line body; nothing else in the chrome explains or promises.

A working coach-mark implementation already exists in
`spikes/board-prototype/` (`lib/tour.ts`, `components/coachmark.tsx`). This change
ports it into `packages/app-ui/src/coach/` **with two structural rewrites the
autopsy (comment 5431046732) demands** — it is a port under review, not a lift.

## What changes

- **Port the mark model and store** (nine marks, one-at-a-time, system-order
  election, chain delay, skip-all, replay) into a new `coach/` surface. The
  spike's copy and `Mark`/`MARKS`/`MARK_BY_ID` shape are good and travel intact.
- **Rewrite anchoring off `data-tour` DOM selectors** (autopsy S8, fence
  addendum rule 7). Anchors resolve through a **typed registry keyed by the
  closed `MarkId` union** — each anchor registers its element via a
  `useCoachAnchor(id)` ref callback; the Coachmark reads the element from the
  registry, never `document.querySelector('[data-tour=…]')`. The selector
  contract stays in the spike. Its already-broken duplicate anchor
  (`data-tour="new-chat"` declared twice, first wins, second never fires) is the
  regression this rewrite must make impossible and the positive control tests it.
- **Rewrite persistence off `localStorage`** (§13). Seen + skip-all persist to
  `client-settings.json` through `settings.*`: a `coachmarks` slice added to
  `clientSettingsSchema`, surfaced additively in the `settings.get` output, and
  written by a thin `settings.setCoachmarks` command that rides B10's existing
  file-config-store (the engine itself is B10, out of scope). No module-level
  mutable state on the rendering path (S8) — the chain timer and the anchor
  registry live in the store/provider, not at module scope.
- **Anchor the nine marks to their landed surfaces** and mount one active
  Coachmark at the shell. Marks whose surface has not landed yet (blocked-by
  C3/C8/C12) pass `enabled={false}` so they never elect — no orphan, no crash.
- **Wire the sidebar "Replay Tour" button** (already present at
  `shell/sidebar/sidebar.tsx:214`, explicitly waiting on C13) to `replay()`.
- Hand-rolled throughout — **no tour library dependency**.

### The nine marks (#487 cap finding)

R55's original cap was eight. On #487 Rai ruled a ninth mark **in**, live
(commit `fc2ed84e`): `start-review` ("Ready to Go"), registered **ahead of**
`new-chat` in system order so it wins on the indexing-ready surface. R55's count
moved from eight to nine. The trailing "keep or swap when the onboarding build
ticket gets cut" thread is *this* ticket and is **non-blocking** — the shipped
spike already registers `start-review` as its own distinct `MarkId` additive to
`new-chat` (both exist; not a swap). This change carries **nine marks**, no
displacement: `start-review, new-chat, smart-list, lenses, highlight, fab,
verdict, draft, dispatch`. Nothing about the cap is left open.

## Impact

- New: `packages/app-ui/src/coach/` (model, store, registry, Coachmark, anchors).
- `packages/protocol`: `clientSettingsSchema` gains a `coachmarks` slice;
  `settingsViewSchema` surfaces it additively; new `settings.setCoachmarks`
  command. Thin core handler over B10's file-config-store.
- `packages/app-ui/src/shell/sidebar/sidebar.tsx`: Replay Tour wired.
- Anchor call-sites across `project/` (indexing, new-chat), `board/`,
  `handoff/`, `shell/` chrome.
- Docs: a using-side onboarding page describing the tour (contextual, one at a
  time, skip-all, replay from Help) and the client-settings field list gains
  `coachmarks`.
- Out of scope: new marks beyond the ruled nine; the settings persistence engine
  (B10). Rule Zero: no gates — skip is one click, dismiss is one click or one
  use of the anchor, nothing is confirmed.

## Fix-loop ledger (PR #535 dual review)

Four findings upheld (3 P2 + 1 P3), fixed at their root, no gates added.

- **Finding 1 (P2) — `useMergedRefs` cleanup clears every input ref.** React 19
  skips its own null-invoke fallback for any ref once the ref callback returns a
  cleanup, so the merged cleanup left object refs pinned to a detached node
  (fab.tsx read `fabRef.current` for exit-flight geometry → misfired) and legacy
  callback refs never saw their null-invoke. Fixed once at the shared function
  (`coach/registry.ts`), covering both merge sites (fab, indexing CTA). Proven by
  `coach/merged-refs.dom.test.tsx` — a live→null rerender clears the object ref and
  null-invokes the legacy callback ref.
