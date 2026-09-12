# OpenSpec changes

Active changes describe accepted work that has not yet been promoted into `openspec/specs/`. Rule Zero in [`AGENTS.md`](../../AGENTS.md) outranks every change and promoted specification.

## Active

- `headless-review-cli`: `rennet review <base>..<head>` and `rennet review --pr <n>`: a terminal client of the daemon's own session path that prints the lanes and board writes as they happen and writes one JSON document to `<data dir>/reviews/<reviewId>.json`; `session.mint` gains an optional `base`.
- `workspace-settings` — Settings → Projects → Worktrees becomes four settings the binding reads (location, layout, `workspace: share|own`) plus an inventory of the workspaces they produced; `own` works beside an existing checkout on a sibling branch.

## Lifecycle

Create work under `openspec/changes/<change-name>/`. Keep its proposal, design, tasks, and capability deltas aligned with the implementation. Archive a completed change after verification; archiving promotes accepted deltas into `openspec/specs/` and moves the change under `openspec/changes/archive/`.

A retired partial change records its outcome and keeps unfinished tasks unchecked. Archive it with `--skip-specs` when its unimplemented scope is not an accepted contract.
