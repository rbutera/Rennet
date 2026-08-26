# Build loop preamble — every board-rebuild dispatch reads this first

Shared rules for all `b*`/`c*` changes. Authority: `docs/developing/plans/board-rebuild-plan.md` (the plan). Each change directory already contains its `context.md` packet, authored by the plan session (#489) — the packet is your context authority. Author `proposal.md` + `tasks.md` FROM the packet; do not re-derive scope, do not re-open closed decisions. Rule Zero (CLAUDE.md) governs: no gates, no ceremony.

## Session-start bearings (every session, before any work)

1. Read this file, your change's `context.md`, and your `tasks.md` if it exists.
2. `git log --oneline -15` — see what landed since the wave began.
3. Read `BUILD-STATUS.json` at repo root (create from the plan's workstream table if absent; you may only flip `passes`/status fields, never remove or reword entries).
4. Run the smoke check (`pnpm nx affected -t typecheck,test` minimum) to learn whether you inherited a broken state.
5. Pick the highest-priority unfinished task. **Search the codebase before assuming anything is unimplemented** — use parallel read-only subagents; duplicate implementation is the classic loop failure.

## Standing rules

- One change in flight per track; one task cluster per session; fresh context per session. Assume interruption at any moment — progress that is not in `tasks.md` checkboxes, `BUILD-STATUS.json`, or a commit does not exist.
- Commit per completed task with descriptive messages; push freely (pushing is not publishing). Worktree-per-agent + nx cleanup rules in CLAUDE.md apply.
- **No placeholder or stub implementations.** If a task cannot be completed fully, leave it unchecked with a note — never a hollow pass.
- Verification closes the loop: `pnpm check` green, plus the packet's end-to-end proof (a positive control that can fail). Evidence shown, never asserted. UI changes are proven by driving the real app.
- Docs: update every page your change invalidates in the same change (definition of done). The packet lists known pages; check `docs/` for others.
- Completion: when every task is checked and verification has run, output the packet's completion sigil and flip the workstream's entry in `BUILD-STATUS.json`.
- Dual review (Opus + Codex seats, fresh contexts, diff + packet only) gates the wave's merge; findings are sorted under Rule Zero.
