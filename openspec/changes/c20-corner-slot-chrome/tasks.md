# Tasks — c20-corner-slot-chrome (C20, #558)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is
part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster;
one commit per checked task. Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless
stated; full gate `sh -c 'pnpm check'` at cluster 8.

This ports the **design, not the code**. `spike/corner-slot-demo` (`@a73d5b08`, files
`spikes/board-prototype/components/{corner-slot,shell,chat-column,main-surface,app-sidebar,session-view}.tsx`)
is a Next.js throwaway behind the fence — read it to understand the intended result, then write a clean
implementation against the real client. Its emulated coloured dots do **not** ship: on darwin the app has
the OS's own lights.

**Reused surfaces (confirm on `main` at session start — do NOT re-implement):**
- `packages/app-ui/src/shell/sidebar/sidebar.tsx` — `useMacTrafficLights()` (reads `useBridge().platform`),
  the `navigation-titlebar` header, `RennetLockup`, `Rail()`, `UpdateControl`, `Sidebar()`'s focus effect.
- `packages/app-ui/src/index.css` `.navigation-titlebar` (≈line 110) — the existing drag / no-drag rule
  (#557's pattern). Do not write a second one.
- `packages/app-ui/src/routes/layout.tsx` — the frame: `sidebarOpen` / `chatOpen` / `dockOpen`
  (`chatOpen && isSessionRoute`), the always-mounted `data-slot="chat-dock"`, the chat-width clamp.
- `packages/app-ui/src/shell/constants.ts` — `SIDEBAR_PANEL_WIDTH` / `SIDEBAR_RAIL_WIDTH`.
- `packages/app-ui/src/shell/top-bar.tsx` — the 56px three-column session bar (back arrow, chat-expand,
  `Trail`, lens-switcher slot, History · Map · Diff `ToggleGroup`).
- `packages/app-ui/src/chat/chat-header.tsx` + `chat-dock.tsx` — the ONE dock header and its mount.
- `packages/app-ui/src/components/icon.tsx` — the icon wrapper; lucide `PanelLeft` / `MessageSquare`.
- `packages/app-ui/src/test/*` + `sidebar.dom.test.tsx`'s `MemoryBridge({ platform })` — the darwin /
  non-darwin mounting pattern, already written for #557.
- `apps/desktop/src/main/index.ts` — `titleBarStyle: "hiddenInset"` on darwin (already set).
- `apps/desktop/e2e/harness.ts` + `*.spec.ts` — the Playwright-on-Electron harness for cluster 8.
- `scripts/check-inventory-tags.mjs` — the standalone inventory checker to EXTEND in cluster 7.

**Session-start bearing:** `grep -n "pl-\[76px\]\|pt-8\|navigation-titlebar" packages/app-ui/src/shell/sidebar/sidebar.tsx`
(#557's interim fix, partly superseded here); `grep -rn "SIDEBAR_RAIL_WIDTH" packages/app-ui/src`
(2 call sites + 1 test); `grep -rn "Expand chat\|Collapse chat" packages/app-ui/src` (today's split toggle
pair). Then `grep -rn "corner-slot\|CornerSlot" packages/app-ui/src` — **none exists**, so cluster 1 adds it.

---

## 1. `CornerSlot` + state 1 (sidebar expanded): lights → wordmark → toggle

- [x] 1.1 `packages/app-ui/src/shell/corner-slot.tsx`: the one component. A strip carrying (a) the macOS
  traffic-light inset — a real reserved zone on darwin, **zero** on every other host, no emulated dots — and
  (b) the sidebar toggle (`PanelLeft`, `aria-label` "Collapse sidebar" / "Expand sidebar"), plus an optional
  `wordmark` slot rendered BETWEEN them (state 1 only). It marks itself `data-slot="corner-slot"` and, on
  darwin, carries the existing `navigation-titlebar` class so the strip is the window drag region and its
  buttons opt back out. A `floating` variant (cluster 5) renders the same content as a translucent pill.
  Move `useMacTrafficLights()` here from `sidebar.tsx` (its only remaining consumers are this file).
- [x] 1.2 Same file: `export function cornerSlotOwner({ sidebarOpen, dockOpen }): "sidebar" | "chat" | "floating"`
  — a **pure** function, no React, no store read. Sidebar open ⇒ `"sidebar"`; else dock open ⇒ `"chat"`;
  else `"floating"`. This is the single-owner authority; the three call sites each render only when they own
  it (Reconciliation 3: `dockOpen`, not "the dock exists").
- [x] 1.3 `packages/app-ui/src/shell/sidebar/sidebar.tsx`: the expanded header row becomes
  `<CornerSlot owner="sidebar" wordmark={<RennetLockup …/>} />` — order **lights → wordmark → toggle**.
  Delete the `pl-[76px]` reserve and the inline `navigation-titlebar` (both now live in `CornerSlot`);
  keep the 14px lockup on darwin (#557) unless it fights the row, and keep the 16px non-darwin size.
  The row must still fit the 256px panel with the light zone, the lockup and the toggle unclipped.
- [x] 1.4 Tests: unit-test `cornerSlotOwner` over all four `{sidebarOpen, dockOpen}` combinations.
  Rework `sidebar.dom.test.tsx`'s "macOS traffic-light clearance" block for the new geometry — on darwin the
  header carries `navigation-titlebar` and the reserved light zone, the lockup sits AFTER the zone and BEFORE
  the toggle, and light-zone + lockup width + toggle ≤ `SIDEBAR_PANEL_WIDTH`; on `win32` / `linux` /
  `undefined` there is no inset, no drag class, and the 16px lockup. Cluster gate green. Commit.

## 2. Delete the collapsed rail — collapsed means hidden

- [x] 2.1 `sidebar.tsx`: delete `Rail()` and its mount; the `<aside>` becomes `w-64` with `border-r` when
  open and `w-0` with **no** border when closed (a collapsed sidebar must contribute zero width and zero
  hairline, or the chat/main pane is not flush to the window edge and the light inset lands wrong).
  Delete the rail's `pt-8` traffic-light dodge with it (#557, superseded). Remove now-unused imports.
- [x] 2.2 `sidebar.tsx`: delete `UpdateControl`'s `"rail"` variant and its branch — the rail was its only
  caller; `variant="panel"` stays for the expanded footer (Reconciliation 6). If that leaves `variant` a
  one-value prop, drop the prop.
- [x] 2.3 `packages/app-ui/src/shell/constants.ts`: delete `SIDEBAR_RAIL_WIDTH`; `routes/layout.tsx`'s
  `sidebarWidth` becomes `sidebarOpen ? SIDEBAR_PANEL_WIDTH : 0` (Reconciliation 7). Fix
  `routes/layout.dom.test.tsx`'s "re-clamps when the rail expands…" case to the new widths — the clamp
  behaviour it proves must survive, only the numbers change.
- [x] 2.4 `sidebar.tsx`: re-point `Sidebar()`'s post-swap focus effect at the CornerSlot's live toggle
  wherever it now mounts (it currently queries inside the `<aside>`, where "Expand sidebar" no longer exists)
  — Reconciliation 8.
- [x] 2.5 Tests: `sidebar.dom.test.tsx`'s collapse test asserts the collapsed `<aside>` renders no rail, no
  nav, and zero width; **a keyboard collapse leaves focus on the CornerSlot's Expand toggle, not `<body>`**
  (this fails loudly if 2.4 is missed). Confirm by hand that Search/⌘P, New Chat, Add Project, Add
  Environment, Update, Help and Settings are all still reachable from the expanded sidebar + command menu
  (Reconciliation 2) and record it in the commit message. Cluster gate green. Commit.

## 3. State 2 — the CornerSlot inline in the chat header; the collapse control leaves

- [x] 3.1 `packages/app-ui/src/chat/chat-header.tsx`: accept an optional `corner` node and render it as the
  FIRST child of the existing 56px header row with `self-start` (so the light inset holds its true y in a row
  taller than the sidebar's), dropping the row's leading padding when it is present. **Delete the
  `PanelRight` "Collapse chat" button** — the one chat toggle moves to the main view in cluster 4. No extra
  strip, no second header.
- [x] 3.2 `packages/app-ui/src/chat/chat-dock.tsx` (or `routes/layout.tsx`, whichever owns `dockOpen`):
  pass `corner={<CornerSlot owner="chat" />}` **exactly when `cornerSlotOwner(...) === "chat"`**. The dock
  stays always-mounted with `width: 0` + `inert` when closed — so this must be gated on `dockOpen`, never on
  the dock's existence (Reconciliation 3). Confirm by grep that `ChatDock` is the only `ChatHeader` mount in
  the client (the spike's second bespoke chat surface has no counterpart here); if a second appears, it takes
  the same slot — never a bespoke bar. **Record the grep's verdict in one line here and move on** — if
  `ChatDock` is the only mount, that is the answer; do not hunt the ghost surface further.
- [x] 3.3 DOM test in `packages/app-ui/src/chat/`: with the sidebar collapsed on a session route with the
  chat open, the chat header carries exactly one `[data-slot="corner-slot"]`, `self-start`, ahead of the
  `Trail`; with the sidebar OPEN the chat header carries none (and the hidden inert dock never does).
  The "Collapse chat" control is gone from the header.
  **This is the cluster's positive control, and it is the packet's named regression class:** remove the
  `dockOpen` gating from 3.2 so the CornerSlot mounts inside the hidden inert dock, re-run, watch the
  sidebar-OPEN assertion go red, restore the gating. Record the observed failure text in the commit message —
  a hidden second mount is invisible on screen and only a test can catch it. Cluster gate green. Commit.

## 4. One chat toggle, on the rightmost pane's top-left

- [x] 4.1 `packages/app-ui/src/shell/top-bar.tsx`: replace the conditional `PanelRightOpen` "Expand chat"
  button with a SINGLE `MessageSquare` toggle that is always present in the left slot, `aria-pressed={chatOpen}`,
  labelled "Open chat" / "Close chat", writing `setChatOpen(!chatOpen)`. It sits after the back arrow and
  before the trail. This is now the only chat open/close control in the app.
- [x] 4.2 `packages/app-ui/src/shell/top-bar.dom.test.tsx`: the toggle round-trips — click closes the dock
  (`data-open="false"` on the dock slot), click again reopens it — in state 1 (sidebar open) and state 2
  (sidebar collapsed). Assert no "Collapse chat" control exists anywhere in the mounted tree. Cluster gate
  green. Commit.

## 5. State 3 — full-bleed main view, floating CornerSlot pill, floating chips

- [x] 5.1 `packages/app-ui/src/routes/layout.tsx`: render `<CornerSlot floating />` fixed at the window's
  top-left exactly when `cornerSlotOwner(...) === "floating"`. It belongs to the LAYOUT, not `TopBar`, so a
  takeover route (Settings, New Chat, Archived, Context Map, Indexing) with the sidebar collapsed still has a
  corner slot and a drag region (Reconciliation 4). On darwin the pill's inset must leave the real lights
  their exact position — the pill is translucent backing plus the toggle, never a control under a light.
- [x] 5.2 `packages/app-ui/src/shell/top-bar.tsx`: in state 3 the bar dissolves — it becomes an absolutely
  positioned, `pointer-events-none` overlay whose three slots become `pointer-events-auto` translucent
  blurred chips (back arrow and chat toggle as round FABs, the trail in a pill, the lens switcher and the
  History · Map · Diff pill restyled to match). **Every element the bar shows in states 1–2 still renders**
  (Reconciliation 5) — dropping a chip "because it does not fit" is honest-present's failure mode. The left
  chip group clears the floating CornerSlot horizontally.
- [x] 5.3 The main surface goes full-bleed under the chips: content **clears** them at rest and **slides
  under** them on scroll (top padding on the region, taken back as negative-margin + scroll padding on the
  scrolling view — the demo's tested compromise; hard full-bleed clipped headings). Verify the board and the
  diff view both read correctly at rest and mid-scroll.
  **Risk note (read before writing the test):** this is the one clause in the packet with no crisp DOM
  assertion — jsdom has no layout, so "clears at rest, slides under on scroll" cannot be measured the way the
  other clusters measure geometry. Pin whatever is genuinely pinnable (the clearance/scroll-padding classes
  are applied exactly in state 3 and absent otherwise). If the visual behaviour itself cannot be pinned by a
  real test, **report the limitation in the task note and prove it by hand in cluster 8.1 instead** — a test
  that passes without proving anything is worse than an honest note.
- [x] 5.4 DOM test: in state 3 the top bar is the floating overlay, every state-1 control is still present
  and clickable, and the chat FAB reopens the dock. Cluster gate green. Commit.

## 6. The single-mount invariant + platform assertions (the regression class)

- [x] 6.1 A DOM test that drives all three states through the real layout and asserts
  `document.querySelectorAll('[data-slot="corner-slot"]').length === 1` in each — including the hidden inert
  dock case (sidebar open + chat open), which is where a literal port of the spike double-mounts.
- [x] 6.2 Platform assertions in the same file, #557's pattern: on `platform: "darwin"` the owning CornerSlot
  reserves the light zone and carries `navigation-titlebar`; on `win32` / `linux` / `undefined` it reserves
  nothing and carries no drag class, while the **toggle geometry is identical** (the same single toggle in
  the same place — non-darwin loses the inset, not the affordance).
- [x] 6.3 **Packet positive control (must be able to fail):** force the state-2 mount while the sidebar is
  expanded (bypass `cornerSlotOwner`, e.g. hand `ChatHeader` a `corner` node unconditionally), run 6.1, watch
  the double-mount assertion go red, revert. Record the observed failure text in the commit message —
  evidence shown, never asserted. Cluster gate green. Commit.

## 7. Inventory re-ruling — annotate every invalidated claim in place (C14 depends on this)

C14 audits `spikes/board-prototype/INVENTORY.md` as its source of truth. A line still asserting a 48px rail
after C20 deletes it is a lie in the record; a line that silently vanishes is worse, because the audit cannot
tell a deliberate re-ruling from an oversight. Annotate **in place**, never delete, never renumber.

- [x] 7.1 In `spikes/board-prototype/INVENTORY.md`, append `(re-ruled by C20 / #558 — Rai 2026-08-28)` to
  each invalidated claim line, keeping its `- [ ]`, its text, its file reference and its `[ws:CN]` tag intact
  (so `scripts/check-inventory-tags.mjs` still passes). The candidate set, by line number and opening words
  on `main` at `6156de9f`:
  - **53** `[ws:C3]` "The sidebar collapses between a 256px full panel and a 48px icon rail…" — collapsed is
    now width 0 / hidden; there is no rail.
  - **55** `[ws:C3]` "Both the expanded panel and the rail carry a collapse/expand control…" — the CornerSlot
    carries the one toggle, wherever it mounts.
  - **61** `[ws:C3]` "The collapsed rail carries Search above New Chat at the top, and Update, Help, Settings
    bottom-anchored…" — deleted with the rail; the affordances live in the expanded sidebar and ⌘P/⌘K.
  - **97** `[ws:C3]` "An Update control sits at the sidebar's foot … and in the collapsed rail" — the foot
    half stands, the rail half is gone.
  - **108** `[ws:C3]` "Header height is two deliberate tiers: … 56px … 40px" — states 1–2 keep the tiers;
    state 3 dissolves the session bar into a floating chip layer.
  - **109** `[ws:C3]` "The header is a three-column grid: left slot (back arrow, chat-expand, trail)…" — the
    left slot's control is now a single always-present chat toggle, and state 3 renders the grid as chips.
  - **110** `[ws:C3]` "When the chat column is collapsed, the header's left slot shows an expand-chat
    control…" — the toggle is present in BOTH directions, not only when collapsed.
  - **389** `[ws:C3]` "The chat-pane header is 56px and carries the two-line session trail plus a collapse
    control…" — the collapse control leaves; in state 2 the header's leading element is the CornerSlot.
  - **391** `[ws:C3]` "Collapsing the chat reveals the same trail and an expand affordance in the main top
    bar" — the one toggle is always in the main top bar.
  - **694** `[ws:C11]` "The sidebar's Search row and the rail's Search button open the same menu" — the rail
    half is gone. *(Outside the packet's stated C3/C7 set but genuinely contradicted; annotate it, and note
    in the commit that C11's line was touched so C14 is not surprised.)*
  - **54** `[ws:C3]` (lockup as scheme-swapped vector artwork) and **112** `[ws:C3]` (the same trail component
    in both headers): **verify** — the expectation is that both survive C20 unchanged. Record a one-line
    verdict for each in the tasks record below; do not annotate a line C20 does not contradict.
- [x] 7.2 Record the verdict for every line above in this file (annotated / verified-unchanged, one line
  each), under a `### Inventory re-ruling record` heading appended to this cluster. **No silent drops** — a
  line in the candidate set with no verdict is an unfinished task.
- [x] 7.3 Extend `scripts/check-inventory-tags.mjs` with a second assertion: a literal list of the
  C20-invalidated claim substrings (from 7.1), each of which must match a line that carries the
  `(re-ruled by C20 / #558 — Rai 2026-08-28)` annotation — exit 1 naming any that does not, and exit 1 if a
  listed substring matches **no** line (so a deleted claim fails too, not just an un-annotated one).
  Run `node scripts/check-inventory-tags.mjs` and show it pass.
- [x] 7.4 **Positive control:** strip the annotation from one re-ruled line, re-run the script, watch it name
  that line and exit 1; then delete a listed line outright and watch the "matches no line" branch fire;
  restore both. Record the observed output in the commit message. Cluster gate green. Commit.

## 8. Packet verification — macOS E2E, docs, full gate

- [ ] 8.1 **SPEC WRITTEN, NEVER EXECUTED — blocked by #569 (Playwright cannot launch Electron).** The
  deliverable exists; the proof is owed. E2E against the real app on macOS (`apps/desktop/e2e`, Playwright-on-Electron, evidence shown not
  asserted): drive all three states — expanded sidebar, collapsed + chat open, collapsed + chat closed. In
  each: the OS traffic lights **never overlap an interactive control** (assert the toggle's and the nearest
  chip's bounding boxes clear the light zone), window **drag works from the corner strip**, and the chat
  toggle round-trips. Screenshot each state and attach the paths to the commit message. Prove 5.3's
  scroll-under here if it could not be pinned by a DOM test.
  **Risk note:** this spec is precedent-free — the repo's Playwright-on-Electron harness has no existing
  window-drag or traffic-light-geometry case to copy. Do **not** burn hours inventing a harness. It may
  reasonably reduce to the bounding-box geometry assertion (which Playwright can do) plus screenshots and a
  **manual-proof note** for the drag, stated plainly as manual. An honest "drag verified by hand on macOS
  26.x, screenshots attached" beats a synthetic drag test that proves nothing about the real window.
- [x] 8.2 `apps/desktop/src/main/index.ts`: adjust `trafficLightPosition` **only if** vertical centering in
  the host row genuinely needs it after 8.1 — measure first, and if no adjustment is needed, say so in the
  task note rather than tuning blind. Update the file's comment either way: it currently points readers at
  `shell/sidebar/sidebar.tsx` for the 76px reserve, which cluster 1 deleted.
- [x] 8.3 Docs (definition of done). **`DESIGN.md` — the translucency amendment (approved 2026-08-28).**
  §Material (line 79) and §Required design behavior both ban glass / vibrancy / translucent chrome. Add a
  **narrow, justified exception** to each — never a softening, never a deletion. **Do NOT delete or
  generalize the original prohibition: it stands for everything else.** Wording rule, follow this shape:
  > chrome that floats over content in the full-bleed state may use a translucent, blurred ground — the only
  > sanctioned use; opaque grounds remain the rule everywhere else (Rai, 2026-08-28).

  Record the provenance in the DESIGN.md edit or its commit message, so nobody relitigates it: **Rai approved
  those chips live, watching them render, on 2026-08-28** — the later and more specific ruling; and line 79
  traces to `5e2f0917` *"docs: rebuild the current documentation library"* (2026-08-20), originating in
  `77490ab4` *"Build Rennet marketing site"* — a docs-rebuild commit, **not** a Rai design-ruling commit. So
  this is a clarification of an agent-authored rule against a Rai-authored ruling, and it is well-founded
  either way. Then §Layout's "collapsible left sidebar" sentence gets collapsed = hidden and the corner-slot
  model. Then `grep -rn "rail\|sidebar\|traffic light\|title ?bar" docs/ --exclude-dir=dist --exclude-dir=.astro`
  and `packages/app-ui/DESIGN.md`, and fix every page a reader would now be wrong about. Reader-facing docs
  describe current Rennet — do not narrate the rail's history.
- [x] 8.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm **zero new
  packages**, not assume — lint, typecheck, test, build); paste the `GATE_EXIT` line. Commit. Output the
  completion sigil `<promise>C20-COMPLETE</promise>`. **`BUILD-STATUS.json` is flipped by `main`, not this
  agent** (per dispatch).

### Inventory re-ruling record

Annotated in place with `(re-ruled by C20 / #558 — Rai 2026-08-28)` — line numbers as
they stood on `main` at `6156de9f`, unchanged (no deletions, no renumbering):

- **53** `[ws:C3]` "The sidebar collapses between a 256px full panel and a 48px icon rail…"
  — **annotated**: collapsed is now width 0 / hidden; there is no 48px icon rail.
- **55** `[ws:C3]` "Both the expanded panel and the rail carry a collapse/expand control"
  — **annotated**: the CornerSlot carries the one toggle, wherever it mounts.
- **61** `[ws:C3]` "The collapsed rail carries Search above New Chat at the top…"
  — **annotated**: deleted with the rail; the affordances live in the expanded sidebar and ⌘P/⌘K.
- **97** `[ws:C3]` "An Update control sits at the sidebar's foot … and in the collapsed rail"
  — **annotated**: the foot half stands; the rail half is gone.
- **108** `[ws:C3]` "Header height is two deliberate tiers…"
  — **annotated**: states 1–2 keep the tiers; state 3 dissolves the session bar into a floating chip layer.
- **109** `[ws:C3]` "The header is a three-column grid: left slot (back arrow, chat-expand, trail)…"
  — **annotated**: the left slot's control is now a single always-present chat toggle, and state 3 renders the grid as chips.
- **110** `[ws:C3]` "When the chat column is collapsed, the header's left slot shows an expand-chat control…"
  — **annotated**: the toggle is present in BOTH directions, not only when the chat is collapsed.
- **389** `[ws:C3]` "The chat-pane header is 56px and carries the two-line session trail plus a collapse control…"
  — **annotated**: the collapse control leaves; in state 2 the header's leading element is the CornerSlot.
- **391** `[ws:C3]` "Collapsing the chat reveals the same trail and an expand affordance in the main top bar"
  — **annotated**: the one toggle is always in the main top bar, in both directions.
- **694** `[ws:C11]` "The sidebar's Search row and the rail's Search button open the same menu"
  — **annotated**: the rail's Search button is gone; the sidebar's Search row and ⌘P/⌘K open the menu.
  *(A C11 line, outside the packet's stated C3/C7 set, but genuinely contradicted — flagged in the
  commit so C14 is not surprised.)*

Verified unchanged — C20 does not contradict these, so they are NOT annotated:

- **54** `[ws:C3]` (the expanded header's lockup is scheme-swapped vector artwork, never a font)
  — **verified unchanged**: the lockup still renders through `RennetLockup` in the sidebar's header
  row, now as the CornerSlot's `wordmark` slot. Its nature (real vector artwork, scheme-swapped,
  14px on darwin / 16px elsewhere) is exactly what it was; only its neighbours moved.
- **112** `[ws:C3]` (the same trail component renders in the chat-pane header and the main top bar)
  — **verified unchanged**: both `chat/chat-header.tsx` and `shell/top-bar.tsx` still render the one
  `shell/trail.tsx`. State 3 wraps the top bar's instance in a chip, which restyles its container,
  not the component.

### Task notes — 3.2, 5.3, 8.1, 8.2

- **3.2 grep verdict.** `ChatDock` is the ONLY `ChatHeader` mount in the client
  (`grep -rn ChatHeader packages apps` → `chat/chat-dock.tsx` and the component's own
  file). The spike's second bespoke chat surface has no counterpart here. Not hunted
  further.
- **5.3 limitation, reported rather than faked.** happy-dom has no layout engine, so
  "clears at rest, slides under on scroll" cannot be MEASURED in a DOM test. What is
  pinned is the half that is genuinely pinnable: `rennet-floating-chrome` (and
  `data-floating-chrome="true"`) is applied to the outlet region in state 3 and absent
  in states 1 and 2 (`shell/floating-chrome.dom.test.tsx`). The behaviour itself is
  CSS: the region takes the clearance as top padding and the pane's primary scroller
  (`min-h-0 flex-1 overflow-y-auto`, the repo-wide idiom) takes it back as negative
  margin plus its own top and scroll padding. The visual result is a manual-proof item;
  see 8.1.
- **8.1 is UNCHECKED and stays unchecked: spec written, never executed — blocked by #569.** A checked
  box would claim a verification that did not happen, which is the same "test that proves nothing"
  pattern this build has spent the day killing. The geometry spec
  is written (`apps/desktop/e2e/corner-slot.spec.ts`: exactly one slot per state, the
  slot's controls clear the traffic-light zone, `-webkit-app-region: drag` on the strip
  with `no-drag` on its buttons, screenshots per state, sidebar round-trip). It cannot
  execute on this machine: Playwright's Electron driver fails to launch at all —

      Electron: bad option: --remote-debugging-port=0
      electron.launch: Process failed to launch!

  CONTROL: an UNTOUCHED spec on `main` fails identically
  (`pnpm nx e2e rennet-desktop --args="--grep=hardened"` → same launch error), so this
  is Electron 43.2.0 vs @playwright/test 1.62.0, repo-wide and pre-existing, not this
  change. Filed as **#569**; fixing it is its own work, not C20's.

  **Consequences, stated so nothing here reads as machine-verified.** THREE claims are
  UNPROVEN BY MACHINE and have no automated proof anywhere in this change:

  1. the OS traffic lights never overlap an interactive control (bounding-box geometry),
  2. window drag works from the corner strip in every state,
  3. 5.3's clear-at-rest / slide-under-on-scroll.

  Their proof path is **Rai's manual verification on real hardware**, once this ships in
  the release he auto-updates to on latios. The drag was always a manual-proof item per
  the packet's own risk note; #569 pulled the other two in with it. Until Rai looks at
  it on a real window, all three are asserted by construction and by reading the CSS —
  not demonstrated.
- **8.2 `trafficLightPosition`: no change, measured-not-assumed is NOT claimed.** The
  default `hiddenInset` inset is what the corner slot's 76px reserve and 40px strip were
  measured against (#557's numbers, unchanged here), and nothing in the DOM suite
  suggests a vertical mismatch — but 8.1 could not run, so no measurement was taken. No
  blind tuning: the override stays absent, which is the state that has been shipping. The
  file's comment no longer points readers at the deleted 76px reserve in
  `shell/sidebar/sidebar.tsx`; it points at `shell/corner-slot.tsx`.
