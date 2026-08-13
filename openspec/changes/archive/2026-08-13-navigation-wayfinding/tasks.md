# Tasks — navigation-wayfinding (#297)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof each behaviour with the failing prediction named first. Keep every change under `packages/ui/src` — do not touch protocol/core/adapters/desktop-main. No consent/confirmation/capability gate anywhere (Rule Zero). Wireframe `18-navigation-model` is the authority.

## 1. The navigation model (pure, model-free — build + test FIRST)
- [x] 1.1 Add `packages/ui/src/nav/history.ts`: the `Surface` union (`projects` | `project{projectId}` | `review{reviewId}` | `draft{reviewId}` | `paper{reviewId}`) and a pure reducer/store with `stack`, `future`, and `push` / `back` / `forward` / `ascendTo` / `replaceTop`, plus a `crumb(stack)` deriver (label + ascend target; lenses are never segments).
- [x] 1.2 Unit tests (`nav/history.test.ts`) asserting the laws — the acceptance red-proofs: `push` grows the stack + clears `future`; `back` lands on the PRIOR surface (a review's `back` → its `project`, NOT `projects`); `forward` re-pushes; `ascendTo(i)` truncates; `replaceTop` swaps the tip with NO new history entry. Assert the contract, not the impl.

## 2. Breadcrumb + NavRail components (pure presentational)
- [x] 2.1 `components/breadcrumb.tsx`: renders `crumb` segments in the title bar (frame-18 form), each a button → `onAscend(index)`. Home/root segment included. No lenses.
- [x] 2.2 `components/nav-rail.tsx`: the compact left rail — Back / Forward (disabled at the ends), Home, Projects — calling injected handlers.
- [x] 2.3 DOM tests: the breadcrumb renders the stack's segments and a click ascends; Back is disabled at the root and enabled after a push; the rail's buttons fire their handlers.

## 3. Wire app.tsx onto the model
- [x] 3.1 Replace `atFrontDoor` / `directEntry` / `destinationView` with the surface stack. The `screen` resolution switches on `current.kind`. Opens become `push(...)`; the Projects control becomes `push({projects})` / `ascendTo(root)`; draft/paper opens become `push({draft})` / `push({paper})`.
- [x] 3.2 **Back from a review lands on Project detail** — the Back control (+ ⌘[) pops to the `project` surface. Red-proof: a dom test opens project → review, hits Back, asserts project detail shows (NOT the front door).
- [x] 3.3 Render `Breadcrumb` in the title bar and `NavRail` on the left of in-project surfaces. Keep the mode pill + patchset chip in the title-bar right slot.
- [x] 3.4 Lens/`view` state stays as-is and is DECOUPLED from history: switching a lens must not push a surface or move the crumb. Red-proof: after a lens switch, history length + crumb are unchanged.
- [x] 3.5 The legacy `directEntry` drawn door is removed from the UI (kept as a palette command only, task 4).

## 4. Keybindings + palette
- [x] 4.1 Wire `⌘[` → back, `⌘]` → forward (mirror the existing `⌘K` global key handling).
- [x] 4.2 `command/`: added the **Navigate** group to `buildCommands` (project, review, Back, Forward, Draft/Paper in a review, Open Settings, palette-only legacy direct-entry). **Removed the `claims` lens command.** Red-proof present: `nav.back` present, no `lens.claims`. *(DEFERRED: recent-locations on an empty query — the palette has no recents/history-store substrate yet; a follow-up, noted in the PR.)*
- [x] 4.3 Settings reachable as an overlay from anywhere (a Navigate command + any existing entry), returning to the origin surface — never entering the stack.

## 5. Prove it + scope audit
- [x] 5.1 Red-then-green for each named red-proof above (back-lands-on-project, lens-switch-no-history, no-claims-command, push-grows-history).
- [x] 5.2 Confirm NO navigation act introduces a confirmation/consent/capability gate (Rule Zero) — a back/forward/crumb/palette move is always a plain navigation; a mid-edit draft persists on navigate-away.
- [x] 5.3 Scope audit: only `packages/ui/src` changed. `NX_DAEMON=false pnpm check` green; state the tip sha + gate total.
