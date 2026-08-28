# Context packet — C20 corner-slot-chrome

Read `openspec/BUILD-LOOP.md` first. Added 2026-08-28, Rai-approved from a live
spike demo (issue #561). **Lands BEFORE C14** (Rai's explicit sequencing) so
the audit sees final shell geometry. Closes #558.

## Objective

Implement the approved "corner slot" macOS chrome model in the real client.
Reference implementation: branch `spike/corner-slot-demo` (@a73d5b08) on the
spike — port the *design*, not the code (fence rules apply). Demo walkthrough:
`/s/teammate`, three states.

The rule: **the leftmost pane owns the traffic lights.** One `CornerSlot`
component = [macOS traffic-light inset] + [sidebar toggle, PanelLeft icon],
with exactly one mount at a time:

1. **Sidebar expanded** — CornerSlot in the sidebar header row, with the
   Rennet wordmark BETWEEN the lights and the sidebar toggle (Rai's amended
   ruling 2026-08-28: lights → wordmark → toggle; the demo omitted the
   wordmark — restore it here). States 2 and 3 carry NO wordmark.
2. **Sidebar collapsed + chat open** — CornerSlot inline at the LEFT of the
   chat's existing header row (no extra strip; `self-start` so the light inset
   holds its real y, not the row centre). Applies to EVERY chat-column mount,
   including the new-chat/session route the demo skipped.
3. **Sidebar collapsed + chat closed** — main view full-bleed; CornerSlot
   floats top-left as a translucent pill; the main titlebar's contents (trail,
   Map·Diff, lens switcher, History) become floating blurred chips. Content
   clears the chips at rest and slides under them on scroll (demo's tested
   compromise — hard full-bleed clipped headings).

Chat open/close: ONE control on the RIGHTMOST pane's top-left (MessageSquare
icon) — plain titlebar button in states 1–2, round FAB in state 3. It leaves
the chat header entirely.

The collapsed icon RAIL is deleted. Collapsed = hidden; its affordances need no
replacement (one toggle away in the expanded sidebar; ⌘P/⌘K keep the keyboard
path). The 48px rail could never contain the light cluster — that impossibility
is why this model exists.

Platform: real `hiddenInset` lights on darwin (no emulation — the demo's
emulated dots exist only because a browser has no lights; the app's are the
OS's own and static by nature). Adjust `trafficLightPosition` only if vertical
centering in the host row needs it. The CornerSlot strip is the drag region
(`.navigation-titlebar` pattern from #557). Non-darwin: no lights inset, but
the same single-toggle geometry; Windows keeps its native frame.

Supersedes within #557's fix: the `pl-[76px]` inset is replaced by the
CornerSlot's own geometry (the wordmark now sits between lights and toggle);
the rail's `pt-8` dies with the rail. Keep the 14px lockup size from #557
unless it fights the row.

## Inventory reconciliation (C14 depends on this)

This change deliberately contradicts §1 claims that assume the wordmark's
old placement, the 48px rail, and a chat-header collapse control. Enumerate the
affected `[ws:C3]`/`[ws:C7]` lines in `spikes/board-prototype/INVENTORY.md`,
and annotate each `(re-ruled by C20 / #558 — Rai 2026-08-28)` in place. C14
verifies the C20 behavior for those lines, not the original claim. No silent
drops — every touched line is listed in the change's tasks record.

## Out of scope

Any further main-titlebar redesign; board/diff content; the #554 settings-store
question. Merging the three floating objects in state 3 into fewer pills is a
recorded OPEN NIT (Rai saw three and accepted) — do not do it here without a
fresh ruling.

## Blocked by

C3/C7 (landed). Footprint: `app-ui/src/shell/*` (sidebar, top-bar area),
`app-ui/src/chat/` header, review-workspace/main-surface chrome, `apps/desktop`
main only if `trafficLightPosition` needs touching. Check overlap with the C07
chat-data swap and C11 command-menu work before co-dispatch.

## Sources

- Approved demo: `spike/corner-slot-demo` branch @a73d5b08 (components/corner-slot.tsx, shell.tsx, chat-column.tsx, main-surface.tsx, app-sidebar.tsx)
- The drag-gap ticket this closes: https://github.com/rbutera/rennet/issues/558
- #557's interim fix (partially superseded, see above)
- T3 Code's pattern (Rai's stated model: lights in leftmost pane's header, no band)

## Verification

- `pnpm check` green (GATE_EXIT line). DOM tests: each state mounts CornerSlot
  in exactly one place (a double-mount is the regression class); darwin
  vs non-darwin class assertions per #557's pattern; chat toggle round-trips
  from the main view in all states. E2E: drive the real app on macOS through
  all three states — lights never overlap an interactive control, drag works
  from the corner strip in every state. Positive control: force the state-2
  mount while expanded and watch the double-mount test fail.

## Completion sigil

`<promise>C20-COMPLETE</promise>`
