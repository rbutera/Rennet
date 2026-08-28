# Context packet — C18 wiring-commands

Read `openspec/BUILD-LOOP.md` first. Added 2026-08-28 from the live-wiring
ledger audit; not in the original 32. The audit found four client surfaces whose
seams claim "one-file swap when the command lands" — but the backing commands
were never registered. This change registers + handles + persists (where needed)
the missing commands, then flips the seams in the same change. Honest-PRESENT
ruling applies: each surface must be structurally capable of showing real data;
honest-empty only where the data genuinely does not exist.

## Objective

All command registration lands in `packages/protocol/src/commands/index.ts`
(the `definitions` table), handlers in `packages/server/src/dispatch/` (one file
per family), and the client swap in the named seam file — the seam comments
themselves say "the ONLY file that changes".

1. **Group-A project prefs.** Five setters on `SettingsProjection`
   (`packages/app-ui/src/settings/data/projections.tsx`) are genuine no-ops in
   the live client: `setProjectGlyph`, `setWorktreeRoot`, `setWorktreePattern`,
   `setTracker`, `setGuidance`. Bind them onto the existing `settings.*` surface
   (`packages/server/src/dispatch/settings.ts` handlers + the `deps.settings`
   implementation in `packages/server/src/settings.ts`) and flip
   `projectEditsPersist` to `true` in the live projection, so
   `settings/projects/{identity,worktrees,issue-tracker,guidance}.tsx` enable
   their controls and `unbacked-note.tsx` retires.
2. **`project.rename`** (C12 cluster-7 seam). Two client callers already exist:
   `setProjectName` (projections.tsx, the sixth setter) and `renameProject`
   (`packages/app-ui/src/shell/sidebar-data.ts`). One command, persisted on the
   project record; an emptied name restores the `org/repo` fallback (R67).
3. **A lens-board read** (C05 cluster-8). `LensBoardSchema` froze in B3
   (`packages/protocol/src/board/lens-board.ts`: "the command that returns it is
   B4/B10's business") and the boards are real server-side: `runLensBoard`
   (`packages/server/src/runtime/lens-pipeline.ts`) writes each board via
   `deps.whiteboard.apply(boardId, …)` and the generation ledger
   (`packages/server/src/runtime/rounds.ts`) maps lens → boardId per generation.
   Register the read, serve the persisted board for (reviewId, generation, lens);
   `useBoardData` in `packages/app-ui/src/board/board-data.ts` becomes one
   `useCommand` read and the `BoardSource` context is deleted. A pair with no
   board is honest-missing, never fabricated.
4. **`session.list` + session mutations.** The sidebar's
   `SidebarSessionProjection` (sidebar-data.ts: rename / pin / archive /
   restore) is honest-empty because protocol carries no `session.list`. Register
   `session.list` (SidebarSession rows per project, enumerated from the
   persisted review store behind `service.reviewById` — add enumeration if the
   store only reads by id) plus `session.rename` / `session.setPinned` /
   `session.archive` (restore is un-archive; a bool on archive or a fourth
   command, implementer's call — the seam has `restoreSession`). Persist all
   three so they survive reload. Build BESIDE the existing `sessionHandlers` in
   `packages/server/src/dispatch/session.ts` — #540 already landed
   `session.transcript` + `session.rounds`; do not duplicate.

The client seam swaps ride in this same change — the surfaces exist and are
fixture-proven.

## Out of scope

C07's chat-data swap (blocked on B10 cluster-6's write side; a separate change).
C11's commandMenu exposure inventory (a deliberate pass of its own — new
commands land `commandMenu: false` like every current row, and stay off
`AGENT_EXPOSED`). Any new UI. Council mappings and host/tool detection
(C16/C17).

## Blocked by

C16 and C17 landing — they touch the same protocol command-registry/snapshot
surface (`commands/index.ts` + `commands.test.ts`); serialize behind them.
Merge surface: `protocol/commands` + `server/dispatch` + the named app-ui data
files — this change serializes with anything else touching those.

## Sources

- Registry + snapshot: `packages/protocol/src/commands/index.ts`,
  `packages/protocol/src/commands/commands.test.ts` (`ABSORBED_IDS`, 79 today)
- Dispatch: `packages/server/src/dispatch/` (`settings.ts`, `session.ts`,
  `runtime.ts` — `requireReviewById`, the `deps` surface)
- Seams: `packages/app-ui/src/settings/data/projections.tsx`,
  `packages/app-ui/src/shell/sidebar-data.ts`,
  `packages/app-ui/src/board/board-data.ts`
- Board substrate: `packages/server/src/runtime/lens-pipeline.ts`,
  `packages/server/src/runtime/rounds.ts`,
  `packages/protocol/src/board/lens-board.ts`
- Docs to keep true: `docs/developing/guides/settings-and-setup.md`,
  `docs/developing/concepts/surfacing-and-routing.md`

## Verification

- `pnpm check` green. `commands.test.ts` `ABSORBED_IDS` updated exactly once
  per new command (the length assertion moves with it) — a command registered
  without its snapshot row fails loudly, and vice versa.
- Per-seam positive controls (each can fail): a project rename persists across
  reload, and an emptied name restores the fallback; the sidebar lists real
  sessions from the store and a pin survives reload; a board read on a session
  with recorded boards renders them, and on a session with no boards resolves
  honest-missing, never a fabricated board; a group-A edit (e.g. the worktree
  pattern) reads back after reload with `projectEditsPersist: true`.

## Completion sigil

`<promise>C18-COMPLETE</promise>`
