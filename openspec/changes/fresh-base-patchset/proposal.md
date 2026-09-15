## Why

Rennet builds a local patchset against whatever its clone happens to call the primary branch, and that ref is often stale. A branch cut from today's `origin/main` and reviewed against a local `main` that was last pulled a week ago gets a merge-base a week old, so the review carries every pull request that landed in between. The reviewer reads a board about three branches' work under one branch's name, and nothing errors. Rai, 2026-09-12: *"rennet currently will happily create a patchset against a stale main, which results in reviews ending up covering multiple branches' work."*

Two local paths do this, differently. The branch-row review (`captureBranchPatchset`, `packages/server/src/create-server.ts`) takes the project's `primaryBranch`, which is the bare local name `main`, and asks for `merge-base main <head>`. Local `main` only moves when the reviewer pulls; a worktree lane cut from `origin/main` after other lanes merged on GitHub is already ahead of it. The working-tree capture (`resolveBase` in `packages/adapters/src/git-capture.ts`) prefers `origin/main`, which is fresher but still only as fresh as the last fetch, and it never looks at local `main` even when local `main` is the newer of the two. The New Chat row's ahead/behind and line counts (`project-detail-source.ts`) measure against the same bare name, so the row and the review it opens can disagree about what the branch contains. The pull-request path is not affected: it pins the forge's base tip and diffs a three-dot range, so git computes the merge-base against a fresh base.

## What Changes

- **One resolver decides the base for every local surface.** Given a repository and the primary branch's name, it considers every ref that names that branch in this clone (the remote-tracking ref for each remote, `origin` first, then the local branch), picks the newest one (the ref no other candidate is ahead of), and records the merge-base of that ref with the reviewed head as the patchset's `baseOid`. Where two candidates have each moved past the other, the remote-tracking ref wins, because the remote is what a pull request opens against. `baseRef` records the winning ref's short name.
- **The branch-row review and the working-tree capture both use it.** The branch path stops passing the bare `primaryBranch` name straight to `merge-base`; the working-tree path stops preferring `origin/main` unconditionally. Both take the resolved merge-base as `baseOid`. The working-tree capture records the winning ref's spelling as `baseRef`, as it does today; the branch path keeps recording the name it was handed, because that `baseRef` is what an own-branch pull request opens against. The wire shape, patchset identity and the round path's successor capture are untouched.
- **The pull request opens against a branch name.** The publish seam strips a leading `<remote>/` from a recorded `baseRef` when that segment is one of the repository's remotes, so a capture measured against `origin/main` asks the forge for `main`. The working-tree path was already recording `origin/main` and sending it verbatim, which GitHub refuses; this closes that too.
- **The New Chat row measures against the same ref.** Ahead/behind, the committed diffstat and the first-commit date for a local branch use the resolved ref, so a row's numbers and the review it opens describe the same range.
- **No fetch.** Capture reads the clone as it stands. The local-review-capture spec says capture mutates no ref, a fetch writes a remote-tracking ref and reaches the network, and the case a fetch would rescue (a branch that carries primary-branch commits no local ref knows) is not the case reported. Deciding this here rather than filing it: if a stale remote-tracking ref turns out to bite, that is a second change with its own egress sentence.

## Capabilities

### New Capabilities

- `primary-base-resolution`: how Rennet chooses the commit a local branch is measured from, given the clone's several spellings of the primary branch.

### Modified Capabilities

- `local-review-capture`: the base of a working-tree or branch-range patchset is the merge-base with the newest ref naming the primary branch, never a stale spelling of it.

## Impact

- `packages/adapters/src/primary-base.ts` (new): `resolvePrimaryBase(git, root, { primaryBranch?, head })`, the candidate walk, the newest-ref choice and the merge-base. `packages/adapters/src/index.ts` exports it.
- `packages/adapters/src/git-capture.ts`: `resolveBase` delegates to the resolver; the probe order for a repository with no `origin/HEAD` (`main`, then `master`) survives as the primary-name fallback.
- `packages/server/src/create-server.ts`: `captureBranchPatchset` takes its `baseOid` from it instead of `merge-base <base> <head>`, and keeps the handed name as `baseRef`.
- `packages/server/src/forge-submission.ts`, `packages/server/src/dispatch/publish.ts`: the destination carries the repository's remote list; `forgeBaseBranch` strips one leading `<remote>/` from `baseRef` before the submission and the preview string.
- `packages/adapters/src/project-detail-source.ts`: `aheadBehind` and `branchDiffstat` take the resolved ref.
- Tests: a fixture with a local `main` behind `origin/main` and a branch cut from `origin/main`, on both capture paths and the row measurement, reddened by restoring the old lookup. A second fixture where local `main` is the newer ref. A third where the two have diverged.
- Docs: `docs/using/guides/getting-started.md` (what a local branch row captures and measures), `docs/developing/concepts/architecture-overview.md` (the capture step names the resolved base).
- Harness cost: **nothing a session sends changes.** No prompt, interpolation, tool surface or settings surface grows. A capture runs a handful more `rev-parse` / `merge-base --is-ancestor` calls, all local.
