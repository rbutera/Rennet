# C20 — Corner-slot chrome: the leftmost pane owns the traffic lights (#558)

## Why

On darwin the desktop window is `titleBarStyle: "hiddenInset"`, so the OS paints the close/minimise/zoom
buttons **over** the renderer's top-left corner. #557 bought clearance the only way a fixed frame allowed:
reserve a 76px zone in the expanded sidebar header (pushing the wordmark right), and push the collapsed
rail's stack down 32px because the 48px rail is **narrower than the light cluster and can never contain it**.
That impossibility is the whole reason this change exists — a chrome band the lights can live in does not fit
the frame Rennet has.

#558 is the leftover: with the lights parked over a pane's header, there is no draggable strip left in some
states, and the collapsed rail's top is a dead zone owned by three OS buttons it cannot host.

Rai approved the answer live on 2026-08-28 from the `spike/corner-slot-demo` walkthrough (three states,
`@a73d5b08`). The model is **the leftmost pane owns the traffic lights**: one `CornerSlot` object —
[macOS light inset] + [sidebar toggle] — with **exactly one mount at a time**, moving between the sidebar
header, the chat header, and a floating pill over the main view as panes collapse. The rail dies with it.

This ports the **design, not the code** (the spike is a Next.js throwaway behind the fence; its emulated dots
exist only because a browser has no traffic lights — the app gets the OS's own). It lands **before C14** on
Rai's explicit sequencing, so the conformance audit sees final shell geometry, and it ships in the next
auto-release that Rai watches auto-update on his own machine — so it is real, not scaffolded.

## What Changes

1. **One `CornerSlot` component, one owner at a time.** `packages/app-ui/src/shell/corner-slot.tsx`: the
   macOS traffic-light inset (real `hiddenInset` lights on darwin, zero inset elsewhere) + the sidebar
   toggle (`PanelLeft`), carrying the existing `navigation-titlebar` drag rule so the corner strip is the
   window's drag region in every state. A pure `cornerSlotOwner({ sidebarOpen, dockOpen })` decides which of
   the three call sites renders it — **`"sidebar" | "chat" | "floating"`, never two**.
2. **State 1 — sidebar expanded.** The CornerSlot IS the sidebar header row, ordered
   **lights → wordmark → toggle** (Rai's amended ruling 2026-08-28; the demo omitted the wordmark, this
   restores it). This supersedes #557's `pl-[76px]` reserve: the inset is now the CornerSlot's own geometry.
   The 14px lockup from #557 stays unless it fights the row. States 2 and 3 carry **no** wordmark.
3. **State 2 — sidebar collapsed, chat open.** The CornerSlot mounts inline at the **left of the existing
   chat header row** — no extra strip, `self-start` so the light inset holds its true y instead of the taller
   row's centre. It applies to **every** chat mount, which in this repo is the one always-mounted `ChatDock`
   (the demo's second bespoke chat surface does not exist here — see Reconciliation 3).
4. **State 3 — sidebar collapsed, chat closed.** The main surface goes full-bleed; the CornerSlot floats
   top-left as a translucent pill; the session top-bar's contents (back arrow, trail, lens switcher,
   History · Map · Diff) become floating blurred chips. Content **clears** the chips at rest and **slides
   under** them on scroll — the demo's tested compromise, because hard full-bleed clipped headings.
5. **One chat toggle, on the rightmost pane's top-left.** A single `MessageSquare` control that opens AND
   closes the chat, living on the main view: a plain top-bar button in states 1–2, a round FAB in state 3.
   It leaves the chat header entirely — today's split pair (`PanelRightOpen` "Expand chat" in the top bar,
   `PanelRight` "Collapse chat" in `ChatHeader`) collapses into it.
6. **The collapsed icon rail is deleted.** Collapsed means hidden: `w-0`, no border, no `Rail()`,
   `SIDEBAR_RAIL_WIDTH` gone from the frame's width math. Its affordances need **no** replacement — every one
   is a single toggle away in the expanded sidebar, and ⌘P/⌘K keep the keyboard path. The `pt-8` vertical
   dodge #557 added for the rail dies with the rail.
7. **Inventory re-ruling.** The `[ws:C3]`/`[ws:C7]` claim lines in `spikes/board-prototype/INVENTORY.md`
   that assume the 48px rail, the old wordmark placement, and a chat-header collapse control are
   **annotated in place** `(re-ruled by C20 / #558 — Rai 2026-08-28)` — never deleted, never left stale.
   C14 then verifies the C20 behavior for those lines, not the original claim, and can tell a deliberate
   re-ruling from an oversight.

## Out of scope

Any further main-titlebar redesign beyond states 1–3; board/diff content; the #554 settings-store question.
**Merging state 3's three floating objects into fewer pills is a recorded OPEN NIT** — Rai saw three and
accepted them; do not do it here without a fresh ruling. No new dependency, no new icon set, no
`ResizeHandle`/dock-width behaviour change beyond dropping the rail term from the maximum.

## Objective clause → cluster map (every packet clause lands a task)

| Packet clause | Cluster |
|---|---|
| One `CornerSlot` = light inset + sidebar toggle, exactly one mount at a time | 1, 6 |
| State 1 — sidebar header, lights → wordmark → toggle | 1 |
| State 2 — inline at the LEFT of the chat header, `self-start`, every chat mount | 3 |
| State 3 — full-bleed main view, floating pill + blurred chips, clear-at-rest / slide-under-on-scroll | 5 |
| One chat open/close control on the rightmost pane's top-left; leaves the chat header | 4, 5 |
| The collapsed rail is deleted; collapsed = hidden; no replacement affordances | 2 |
| Real `hiddenInset` lights on darwin, no emulation; `trafficLightPosition` only if centering needs it | 1, 8 |
| CornerSlot strip is the drag region (`navigation-titlebar`, #557's pattern) | 1, 5 |
| Non-darwin: no lights inset, same single-toggle geometry; Windows keeps its native frame | 1, 6 |
| Supersedes #557: `pl-[76px]` → CornerSlot geometry; rail `pt-8` dies; 14px lockup kept | 1, 2 |
| Inventory `[ws:C3]`/`[ws:C7]` re-ruling annotations, no silent drops | 7 |
| DOM tests: single mount per state, darwin vs non-darwin classes, chat toggle round-trips | 6 |
| E2E on macOS through all three states; lights never overlap a control; drag from the corner strip | 8 |
| Positive control: force the state-2 mount while expanded ⇒ the double-mount test fails | 6 |
| Docs correct in the same change | 8 |

## Reconciliations (part of the spec — hold these, do not re-open)

1. **DESIGN.md's "no translucent chrome" is amended, not ignored (ruled 2026-08-28).** `DESIGN.md` §Material
   (line 79) says *"Do not use glass, vibrancy, translucent chrome, or decorative shadows"*, and §Required
   design behavior repeats it. State 3's floating pill and blurred chips are translucent chrome by that
   wording — and **Rai approved those chips live, watching them render, on 2026-08-28**, which is the later
   and more specific ruling. The reconciliation is **not** to quietly violate the file, and **not** to soften
   or delete the prohibition: this change **amends `DESIGN.md` with one narrow, justified exception** — chrome
   that floats over content in the full-bleed state may use a translucent, blurred ground; opaque grounds
   remain the rule everywhere else. Provenance, recorded so nobody relitigates it: line 79 was last written by
   `5e2f0917` *"docs: rebuild the current documentation library"* (2026-08-20), originating in `77490ab4`
   *"Build Rennet marketing site"* — a docs-library rebuild, **not** a design-ruling commit. So this is a
   clarification of an agent-authored rule against a Rai-authored ruling. The amendment is well-founded either
   way. §Layout's "collapsible left sidebar" sentence is updated for collapsed = hidden. If the docs are wrong
   after this change, the change is not done.
2. **The 48px rail's deletion is not a capability removal.** Rule Zero forbids denying an agent or a user a
   capability. Nothing is lost here: Search/⌘P, New Chat, Add Project, Add Environment, Update, Help and
   Settings all remain one toggle away in the expanded sidebar, and the command menu keeps the keyboard
   path. What dies is a 48px strip that structurally could not host the OS lights. Verify the affordances,
   do not replace them with a substitute rail.
3. **The chat dock persists; the spike's chat column did not — this is the double-mount trap.** In this repo
   `routes/layout.tsx` keeps `data-slot="chat-dock"` **always mounted** and hides it with `width: 0` +
   `inert` (the R47 transcript-identity guarantee). A literal port of the spike would mount a CornerSlot
   inside that hidden, inert, zero-width dock in **every** state — an invisible second mount that breaks the
   one-owner rule and steals the drag region. The chat mount is therefore gated on the layout's `dockOpen`
   (`chatOpen && isSessionRoute`), not on the dock existing. This is the regression class the packet names.
4. **The floating mount belongs to the layout, not the top bar.** `TopBar` renders on session routes only;
   every takeover (Settings, New Chat, Archived, Context Map, Indexing) has no top bar at all. With the
   sidebar collapsed on a takeover there would otherwise be **no** CornerSlot and no drag region. So the
   floating state-3 mount is rendered by `routes/layout.tsx` (as the spike's `shell.tsx` did), which covers
   session and takeover routes alike; the chip restyle of the bar's contents stays inside `TopBar`.
5. **Honest-present holds through the restyle.** State 3 dissolves the top bar's chrome, not its data: the
   trail, lens switcher, and History · Map · Diff pill all still render as chips, with the same
   derived-presence rules (History appears exactly when a round completed). A chip that would be dropped
   because it "does not fit the floating layer" is a lie by omission — restyle it or keep the bar.
6. **`UpdateControl`'s `"rail"` variant dies with its only caller.** The rail is its sole mount
   (`variant="panel"` serves the expanded footer). Delete the variant and its branch rather than leaving a
   one-implementation prop for a caller that no longer exists.
7. **`SIDEBAR_RAIL_WIDTH` is removed, not zeroed.** `routes/layout.tsx` computes the chat's maximum from
   `sidebarOpen ? PANEL : RAIL`; collapsed is now 0, so the constant has no meaning. Delete it from
   `shell/constants.ts` and fix the one call site plus the layout test that names it, so no reader believes
   a 48px rail still exists.
8. **The sidebar's focus hand-off must survive the rail's deletion.** `Sidebar()`'s effect refocuses the
   counterpart toggle after a collapse/expand swap by querying `[aria-label="Expand sidebar"]`. With the
   rail gone that element moves into the chat header or the floating pill — outside the `<aside>` the effect
   queries. Re-point it at the CornerSlot's live toggle, or keyboard collapse strands focus on `<body>`.

## Verification (packet)

`pnpm check` green (GATE_EXIT line). DOM tests: each state mounts the CornerSlot in **exactly one** place
(the double-mount is the regression class); darwin vs non-darwin class assertions per #557's pattern; the
chat toggle round-trips from the main view in all three states. E2E: drive the real app on macOS through all
three states — the lights never overlap an interactive control, and window drag works from the corner strip
in every state. **Positive control (must be able to fail):** force the state-2 mount while the sidebar is
expanded and watch the double-mount test fail.

## Completion sigil

`<promise>C20-COMPLETE</promise>`
