## Context

`decideBoundWorkspace` (`packages/server/src/bound-workspace.ts`) is the one place a session's workspace is chosen, and it is called once per session. It has three arms: a pull-request snapshot (`ensurePrSnapshotWorkspace`, detached at the reviewed head, re-pinned in place by `repinBoundWorkspace`), a branch some worktree already has out (`worktreeForBranch`, bound to as-is), and a branch nothing has out (`ensureBranchWorktree` at `branchWorktreePath(dataDir, repoKey, branch)`). The round path captures the successor patchset from the bound root with `headRef: operation.sourceTarget.branch` (`create-server.ts` ~3931), and `submitForgePullRequest` pushes `refs/heads/<headRef>:refs/heads/<headRef>` from `input.repoRoot`.

The settings ladder already declares `worktreeBaseDir` (`DETECTABLE`, no detector since the scout's hint was retired) and `worktreePattern` (`CONFIG_ONLY`), maps them onto the wire as `worktreeRoot` / `worktreePattern`, and writes them through `settings.setProjectValue`. Nothing reads the resolved values.

## Decisions

### D1 — Location resolves off the ladder, and a user-set root is absolute

`worktreeRoot` keeps its registry entry and wire key. Builtin is `join(dataDir, "worktrees")`, computed at resolution time so the preview and the binding agree with whatever `--data-dir` / `RENNET_USER_DATA` produced. The global rung is `daemon-settings.json` → `worktrees.root`, because a filesystem path is a fact about the daemon's host, the same argument that put `tracker` there rather than in client settings. The repo rung is `.rennet/config.json` → `worktreeBaseDir`, the field that already exists. A written value is expanded (`~`) and made absolute by the daemon; a relative value resolves against the data directory. The declaration stays `DETECTABLE`; no detector is added. A changed location applies to sessions created after the change, because a session binds once, and the card says so in one line beside the editor.

*Rejected:* a client-settings rung. A viewer on another machine has no opinion about where a daemon's host keeps checkouts.

### D2 — Layout is two patterns with real tokens, refused when they escape the root

Two keys, both relative to the root. `worktreePattern` (existing) places a branch worktree; tokens `{repo}` (the escaped realpath key, today's middle segment), `{name}` (the resolved remote's repository name, and the repository directory's basename only when no remote resolves — this design first said basename outright, which was wrong: the pull-request placement has always used the forge name, so a clone of `acme/widget` into `/work/widget-local` would have previewed `acme/widget-local/pr-1` while the binding created `acme/widget/pr-1`), `{owner}` (the forge owner when a remote resolves, else `local`), `{branch}` (the branch, its `/` kept as separators). Default `{repo}/{branch}`. `prWorktreePattern` (new) places a pull-request snapshot; tokens `{owner}`, `{name}`, `{repo}`, `{number}`. Default `{owner}/{name}/pr-{number}`. Both defaults are the shapes hardcoded today, so an untouched install places nothing differently, and no migration touches an existing worktree.

A write is refused, with the file untouched, when the pattern carries an unknown token, resolves to an absolute path, resolves to the root itself, or resolves outside the root for any token values (a `..` segment). `branchWorktreePath` and `prWorktreePath` take `(root, pattern, repo, branch|number)`; the old signatures go. The token records are built by `branchTokens` / `prTokens` in adapters, which every bind site AND the preview call, so the set a pattern write blesses cannot drift from the set a binding supplies — a `{owner}` blessed at the write and missing at the bind is a stored pattern that previews fine and throws.

*Rejected:* one pattern for both. A snapshot has a number and no branch; a branch has no number. Forcing one grammar over both produced the empty-token questions this design does not want.

### D3 — The preview is resolved on the daemon and shipped on the row

`settingsProjectSchema` gains additive-optional `worktreePreview: { branch: string; pullRequest: string }`, computed per row from the resolved root, the resolved patterns, the row's real repo key, its real owner/name when a remote resolves, the repository's current branch as the sample (else `main`), and `1` as the sample number. app-ui renders the two strings under the editors and derives nothing. This is the whole answer to why #812's preview lied.

### D4 — `workspace` is a two-valued setting; `own` binds beside the reviewer's checkout on a sibling branch

Key `workspace`, values `share` | `own`, builtin `share`, global and repo rungs (`daemon-settings.json` → `worktrees.workspace`; `.rennet/config.json` → `workspace`).

Under `share` the three arms are unchanged. Under `own`:

- A branch nothing has out: unchanged. Rennet's worktree is on the branch itself; there is no conflict to avoid.
- A pull request: unchanged.
- A branch some worktree already has out: git refuses a second checkout of one branch, so Rennet creates its worktree at `branchWorktreePath` **on a sibling branch** `rennet/<branch>` forked from the branch's current head (`git worktree add -b rennet/<branch> <path> <branch>`; if the sibling exists and its tip is reachable from the branch, it is reset to the branch's head first; if it has commits the branch does not, it is used as it stands and the inventory row says it is ahead).

The session records `workBranch` beside `boundRoot`: the branch itself under `share` or under `own`'s first two arms, the sibling under the third. Every consumer that today assumes "the session's branch" is a ref in the bound root reads `workBranch` instead:

- **The round.** The turn commits in the bound root, which has the sibling checked out, so commits land on the sibling without the worker knowing. The successor patchset is captured from the bound root with `headRef: <branch>` — the reviewed branch's NAME, which is what the review and the pull request are about — and `headOid` from the sibling's tip, exactly as today's `operation.state.commits.to`.
- **The pull-request push.** `submitForgePullRequest` takes `workBranch` and pushes `refs/heads/<workBranch>:refs/heads/<headRef>`. Under `share` the two names are equal and the refspec is byte-identical to today's. The reviewer's local branch is now behind its upstream, which a plain pull fixes; that sentence is on the round card after a push under `own`.
- **Landing locally.** `session.landWorkBranch` runs `git merge --ff-only <workBranch>` INSIDE the worktree that has the branch out (the reviewer's checkout). A dirty checkout makes git refuse; the refusal is shown as "your checkout on `<branch>` has uncommitted changes; the round's commits are on `rennet/<branch>`" — a fact, not a dialog, and the button stays. A non-fast-forward (the reviewer committed on the branch meanwhile) is reported the same way, and Rennet does not merge or rebase on the reviewer's behalf.

*Rejected:* a detached workspace committing on a detached HEAD. Its commits are reachable only through a worktree's HEAD and the reflog, and `worktree prune` or `gc` can lose them; a branch is a ref the reviewer can see in `git branch` and recover from. *Rejected:* an `auto` value that picks `own` when the reviewer's checkout is dirty at bind time. It felt clever, which Rule Zero names as the signal to stop, and it makes the workspace a function of state the reviewer did not choose. *Rejected:* refusing to bind while the reviewer's checkout holds the branch. A gate.

### D5 — Sibling cleanup is reachability, never deletion of unmerged work

On `session.archive`, when the session's `workBranch` is a sibling: if the sibling's tip is an ancestor of the local branch OR of the branch's remote-tracking ref (the push under `own` makes the latter true), the worktree is removed and the sibling deleted. Otherwise both stay and the inventory row reads "ahead of `<branch>` by N commits". Nothing forces. The existing startup sweep gains the same rule for siblings whose sessions are gone.

### D6 — The inventory is read from git and the session store, and computed on request

`worktrees.list({ repoPath })` returns one row per workspace Rennet knows for that repository: `git worktree list --porcelain` filtered to paths under the resolved root plus the PR index plus any `boundRoot` recorded on a session of that repository (which is how the reviewer's own checkout appears, tagged `own checkout`, with no remove action). Each row: `path`, `kind` (`own-checkout` | `branch` | `sibling` | `pull-request`), `ref`, `sessionIds`, `createdAt` (the worktree's `.git` file mtime), `lastUsedAt` (the latest bound session's activity), `sizeBytes` (a bounded `du`, capped at 2 s per row, `undefined` past the cap and the cell says "—"). `worktrees.remove({ repoPath, path })` runs `git worktree remove` without `--force`, deletes a sibling only under D5's rule, and returns git's refusal verbatim when there is one. Both are direct reads and writes with no confirmation (settings-resolution: no ceremony on any control). The list reflects a project→repo mapping, so every call names `repoPath`, never a project id (CLAUDE.md: a workspace maps many repos to one identity).

### D7 — The card

Order on the Projects page is unchanged. The Worktrees section becomes: **Location** (text field, provenance chip, Reset and Pin as the other layered rows), **Layout** (two text fields, each with its resolved preview line from D3), **Workspace** (a two-segment control, `share` / `own`, with one sentence under each naming what it does to a branch the reviewer has out), and **Workspaces** (the D6 rows; empty state is one sentence: "Nothing yet. Rennet's worktrees for this repository appear here."). The four prose rows are deleted. The caption keeps `BackingFile` naming the two files the section writes.

## Risks / Trade-offs

- **A pattern edit on a repository with live sessions.** Existing sessions keep their recorded `boundRoot`; new ones use the new layout; both show in the inventory. No relocation is attempted. Documented on the card in one line.
- **`{owner}` with no forge remote.** Resolves to `local`, stated in the token help. A repository with two forge remotes uses the same resolution `resolveForgeRemote` already makes for submission.
- **The land action's fast-forward runs in the reviewer's checkout.** This is the one place `own` mode writes to the reviewer's tree, and it does so only on the reviewer's click, only as a fast-forward, and only when git agrees the tree is clean. This is the trade-off `own` exists to make explicit.
- **Two repositories in one workspace, both on `feat/x`, one in `own`.** The binding is per repository (the review carries `repositoryRoot`), so the settings resolve per repo rung and the siblings are per repository. The fixture in task 2.8 is the proof, and it is the fixture the 2026-08-28 rule demands.

## Verification notes

- The re-pin flag from the proposal discussion is answered: the successor patchset already keys on `headOid` from the round's commits and carries `headRef` as the reviewed branch's name (`create-server.ts` ~3931), so under `own` nothing in the review's pinning changes; only where the commits are READ from (the bound root, unchanged) and where they are PUSHED from (`workBranch`, new) move.
- `repinBoundWorkspace` is pull-request-only and is untouched.
