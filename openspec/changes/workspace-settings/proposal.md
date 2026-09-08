## Why

Settings → Projects → Worktrees is a settings section with no settings in it. Four rows, each a label and a paragraph, each ending in a monospace phrase that looks like a value and is not one. Rai, 2026-09-08: *"this part of settings is... ridiculous. first of all, settings should be configurable. these worktree things should be configurable. and it looks and feels like it's documentation masquerading as settings items."*

It got that way honestly. #812 found the card's old Location and Naming editors promising a folder Rennet never creates: `worktreeRoot` and `worktreePattern` persisted on the repo rung, and the one function that places a worktree — `decideBoundWorkspace` in `packages/server/src/bound-workspace.ts` — reads `dataDir` and two hardcoded shapes, never the ladder. The editors were deleted and the card was rewritten to describe the binding. The description is accurate. It is also the wrong object for a settings page, and the two keys it replaced are still on the wire, in the registry, in `settings.ts` and in the projection, persisted and consumed by nothing.

The underlying question — where does Rennet work, and does it ever work inside a checkout the reviewer already has open — is a real preference with real consequences. An agent that commits in the reviewer's own tree lands its work where the reviewer is looking, which is the right default; it is also an agent editing a directory that may hold uncommitted work, a half-finished rebase, or a dev server's watch. Deferring that choice was raised and refused the same day: *"filing it as an issue just defers my thinking and i hate that, we need to solve this issue now."*

## What Changes

- **BREAKING: `worktreeRoot` and `worktreePattern` become live.** The binding reads the resolved location and layout off the settings ladder. The location's builtin is the data directory's `worktrees/`; its global rung is a host fact in `daemon-settings.json`, its repo rung is the project's `.rennet/config.json`. The layout is two patterns with real tokens — `{repo}/{branch}` for a branch worktree and `{owner}/{name}/pr-{number}` for a pull-request snapshot, which are exactly today's hardcoded shapes, so an untouched install places nothing differently. A pattern that escapes the root is refused at write.
- **The preview is the daemon's answer, never the client's derivation.** `settings.get` carries the resolved example paths for the row's own repository. The client renders strings. The reason #812's preview lied is that app-ui computed it without the data directory or the escaped repo key; nothing in app-ui derives a path again.
- **A new setting, `workspace`, with two values.** `share` (the default): a review of a branch some checkout already has out binds to that checkout. `own`: Rennet always works in a folder it made. `own` on a branch nobody has out and on a pull request changes nothing. `own` on a branch the reviewer has out binds to a Rennet worktree on a **sibling branch**, `rennet/<branch>`, forked from the branch's head; rounds commit there; the pull-request push maps the sibling onto the branch's name on the remote; and a "land" action fast-forwards the reviewer's checkout when it is clean, and states the branch name when it is not.
- **The card lists what the knobs produced.** Every workspace Rennet knows for the scoped repository — the reviewer's own checkout when a session is bound there, each branch worktree, each pull-request snapshot, each sibling — with its path, its ref, the sessions bound to it, when it was made, when it was last used, and its size. Rennet-made, idle entries carry a remove action. The four prose rows are deleted; the settings guide keeps the explanation.
- **Sibling branches are collected, not abandoned.** When a session on a sibling is archived and the sibling's tip is reachable from the branch it forked from, locally or on the remote after a push, the sibling is deleted with the worktree. Otherwise both stay, and the inventory row says why.

## Capabilities

### New Capabilities

- `workspace-inventory`: the settings surface lists every workspace Rennet knows for a repository with the facts that identify it, and removes an idle Rennet-made one on request; a removal that git refuses is reported, never forced.

### Modified Capabilities

- `session-bound-workspace`: the location and layout of a Rennet-created worktree resolve off the settings ladder; a `workspace` setting decides whether a checkout that already has the branch out is bound to or worked beside on a sibling branch; a round's commits land on the session's **work branch**, which is the branch itself under `share` and the sibling under `own`; the pull-request push and the new land action carry the sibling back to the branch's name.
- `settings-resolution`: `worktreeRoot`, `worktreePattern`, `prWorktreePattern` and `workspace` are registered keys with a consumer; the global rung of a path-valued key is the daemon's host; the resolved preview travels on the settings row.

## Impact

- `packages/protocol/src/wire.ts`, `commands/index.ts`: `prWorktreePattern` and `workspace` join `settingsProjectValueKeySchema` and `settingsProjectPrefsSchema`; `worktreePreview` and `workBranch` are additive-optional on the row and the session; `worktrees.list` / `worktrees.remove` / `session.landWorkBranch` are new commands.
- `packages/core/src/settings-resolver.ts`: the two new keys; `worktreeBaseDir` becomes `CONFIG_ONLY`, so all four worktree keys resolve `builtin < global < repo`. The scout still records where a repository's own worktrees live, and stops offering it: that fact is the repository's convention, and offering it to a root the binding now reads would move placement on an install that touched no setting.
- `packages/server/src/settings.ts`: the global rung for `worktrees.{root,pattern,prPattern,workspace}` in `daemonSettingsSchema`; the preview computed per row.
- `packages/server/src/bound-workspace.ts`, `create-server.ts`: `decideBoundWorkspace` takes the resolved settings; the sibling arm; `workBranch` recorded beside `boundRoot`; the round's successor patchset captured with `headRef` = the reviewed branch and the commits read from the work branch; the sweep on archive.
- `packages/adapters/src/pr-worktree.ts`: `branchWorktreePath` / `prWorktreePath` take a root and a pattern; `ensureSiblingWorktree`; the inventory reader over `git worktree list` plus the PR index.
- `packages/server/src/forge-submission.ts`: the push refspec is `refs/heads/<workBranch>:refs/heads/<headRef>`.
- `packages/app-ui/src/settings/projects/worktrees.tsx`: rewritten; `projects.dom.test.tsx`; the round card gains the land action.
- Docs: `docs/developing/guides/settings-and-setup.md` (the Worktrees card paragraph), `docs/developing/concepts/handoff-and-exits.md` (the binding and where commits land), `docs/using/guides/getting-started.md` (the Worktrees bullet).
- Harness cost: **nothing a session sends changes.** No prompt, interpolation or tool surface grows. Stated here so the reviewer does not look for a measurement.
- Issues: closes #812's third surface for good, by replacing the description with the setting it described.
