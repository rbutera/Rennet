## 1. The keys, their rungs, and the preview (D1, D2, D3)

Ships on its own: values resolve and preview correctly; the binding still ignores them until group 2.

- [x] 1.1 Protocol: add `prWorktreePattern` and `workspace` to `settingsProjectValueKeySchema` and `settingsProjectPrefsSchema`; add additive-optional `worktreePreview` to `settingsProjectSchema`; add `worktrees: { root?, pattern?, prPattern?, workspace? }` to `daemonSettingsSchema`. A row without `worktreePreview` still parses
- [x] 1.2 Registry: `prWorktreePattern` (`CONFIG_ONLY`, builtin `{owner}/{name}/pr-{number}`), `workspace` (enum `share`|`own`, builtin `share`, global+repo), `worktreePattern` builtin becomes `{repo}/{branch}` (was `""`). Control: the "every live setting is registered" assertion enumerates the four keys
- [x] 1.3 Server: the global rung for the four keys reads from `daemonSettings.worktrees`; the repo rung from `config.json`; `settings.setProjectValue` accepts the two new keys; a global write lands in `daemon-settings.json` and a malformed file refuses byte-for-byte (existing rule, new keys)
- [x] 1.4 Adapters: `branchWorktreePath(root, pattern, tokens)` and `prWorktreePath(root, pattern, tokens)` with the D2 token set; `renderWorktreePattern` refuses an unknown token, an absolute result, or a result outside the root. Controls: `../` escapes, `{nope}`, and a `/abs` pattern each refuse; the two defaults reproduce today's paths byte-for-byte on the existing fixtures
- [x] 1.5 Server: the write path validates a pattern through `renderWorktreePattern` with placeholder tokens before persisting, and refuses with the reason. Control: a refused write leaves `config.json` unchanged
- [x] 1.6 Server: compute `worktreePreview` per row (D3) from the row's real repo key, resolved remote, current branch and `1`; no path string is derived in app-ui. Control: a two-repo workspace fixture yields two different previews for one project

## 2. The binding reads the settings; `own` mode; the work branch (D1, D4, D5)

- [x] 2.1 `decideBoundWorkspace` takes `{ root, pattern, prPattern, workspace }` resolved for `review.repositoryRoot`, and returns `{ boundRoot, workBranch }`; `create-server.ts` records both on the session. `workBranch` is additive-optional on the wire and absent reads as the reviewed branch
- [x] 2.2 The sibling arm: `ensureSiblingWorktree(git, cloneRoot, path, branch)` per D4 (create `-b rennet/<branch>` from the branch's head; bind an EXISTING sibling worktree exactly as it stands, touching neither its tree nor its index; re-fork only an ORPHANED sibling branch — one with no worktree — and only when its commits are reachable from the branch or a remote-tracking ref of it; keep an ahead one as it stands). Controls: a fixture whose checkout has the branch out and `workspace: own` binds to a new worktree on `rennet/<branch>` and the reviewer's checkout is byte-for-byte untouched; under `share` the same fixture binds to the checkout, as today
- [x] 2.3 The round: the successor patchset's `headRef` stays the reviewed branch's name and `headOid` the sibling's tip. Control: a round under `own` yields a patchset whose commits are on `rennet/<branch>` and not on `<branch>`, and the review's active patchset names `<branch>`
- [x] 2.4 The push: `submitForgePullRequest` takes `workBranch` and pushes `refs/heads/<workBranch>:refs/heads/<headRef>`. Controls: under `share` the refspec is byte-identical to today's; under `own` the remote's `<branch>` advances to the sibling's tip and the local `<branch>` does not move
- [x] 2.5 `session.landWorkBranch`: ff-only merge inside the worktree that has the branch out; a dirty tree and a non-fast-forward each return git's refusal verbatim and change nothing. Controls: clean → the branch advances and the reviewer's index is unchanged; dirty → refused, tree unchanged; diverged → refused, no merge commit
- [x] 2.6 Archive: D5's reachability rule deletes a merged sibling with its worktree and keeps an unmerged one; the startup sweep applies the same rule to orphaned siblings. Controls: pushed-then-archived deletes; ahead-then-archived keeps and the inventory row reads "ahead by N"
- [x] 2.7 The strip: after a push under `own`, one line NAMES the remote-tracking ref the push updated (`refs/remotes/<remote>/<branch>`, rendered `origin/feat/x`) and how far the local branch is behind it — never "its upstream", which is a concept rather than a ref, and never the sibling's own count; before a push the line says where the round's commits are instead. The land action sits beside it with git's refusal verbatim when refused. The no-self-explaining-chrome rule: the line names the branch, not Rennet's machinery
- [x] 2.8 The fixture this change is not done without: a workspace of two repositories, both on `feat/x`, both with the branch checked out in the reviewer's own worktree, one repository `own` and the other `share`. One session per repository binds to a sibling and to the checkout respectively, each session's `boundRoot` is under its OWN repository, and swapping the two rows' `repositoryRoot` reddens it

## 3. The inventory (D6)

- [x] 3.1 Adapters: `listWorkspaces(git, repoRoot, root, prIndex, sessions)` over `git worktree list --porcelain`, the PR index and the sessions' bound roots, producing D6's rows; `sizeBytes` bounded at 2 s per row. Controls: a row past the cap carries `undefined`; the reviewer's checkout appears as `own-checkout` only while a session is bound to it
- [x] 3.2 Protocol + server: `worktrees.list` and `worktrees.remove`, both keyed by `repoPath`, the removal addressing a row by its opaque `id` so a projected client can round-trip one; remove runs `git worktree remove` without `--force`, applies D5 to the sibling BRANCH, and returns git's refusal verbatim. Controls: a dirty worktree's removal is refused and the directory remains; an `own-checkout` row cannot be addressed by remove
- [x] 3.3 Registry: both commands join the command registry with the same locus handling as the other repo-scoped commands (a WSL repository lists its worktrees through its own locus)

## 4. The card (D7)

- [ ] 4.1 Rewrite `worktrees.tsx`: Location with provenance, Reset and Pin; Layout with two fields and their preview lines from the row; Workspace as a two-segment control; Workspaces as the inventory rows with remove on Rennet-made idle entries; one-sentence empty state; the four prose rows deleted. Section caption keeps `BackingFile` for the two files the section writes
- [ ] 4.2 `projects.dom.test.tsx`: the preview renders the row's string and nothing computed (control: change the row's string, watch the render follow); a `share`/`own` click writes through `settings.setProjectValue` with the right `repoPath` for the scoped row in a two-repo project; a remove click dispatches with the row's path; a refused remove renders git's text
- [ ] 4.3 Editors sit DISABLED with `UnbackedNote` when no write store backs the row, as the other Projects editors do

## 5. Documentation and the cost sentence

- [x] 5.1 `docs/developing/guides/settings-and-setup.md`: replace the "statement, not a setting" paragraph with the four controls and the inventory; name the two files and the rung of each key
- [x] 5.2 `docs/developing/concepts/handoff-and-exits.md`: the binding under `share` and `own`, the work branch, where a round's commits land in each, the push refspec, the land action, and D5's cleanup rule; the `~/.rennet/worktrees/<repoKey>/<branch>` sentence becomes "the resolved root and layout, `<root>/{repo}/{branch}` by default"
- [x] 5.3 `docs/using/guides/getting-started.md`: the Worktrees bullet says what a reviewer can set and what they will see listed
- [x] 5.4 The cost paragraph is delivered in the PR description by the orchestrator, not in a doc page: no prompt, interpolation, tool surface or settings surface a session SENDS changes; the settings surface the VIEWER sees grows by four controls and a list
