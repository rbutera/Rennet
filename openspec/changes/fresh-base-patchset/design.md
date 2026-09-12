## Context

Three local surfaces turn "the primary branch" into a commit, and each does it its own way.

- `resolveBase` in `packages/adapters/src/git-capture.ts` probes `origin/HEAD`'s target, then `origin/main`, `origin/master`, `main`, `master`, takes the first that resolves, and runs `merge-base <that> HEAD`. It never compares candidates, so a local `main` that is newer than `origin/main` is ignored, and an `origin/main` nobody has fetched for a week is trusted.
- `captureBranchPatchset` in `packages/server/src/create-server.ts` receives `project.primaryBranch`, the bare name `main` that project discovery records, and runs `merge-base main <head>`. Local `main` moves only when the reviewer pulls. Every worktree lane cut from `origin/main` after a sibling merged on GitHub is ahead of it, and the merge-base lands wherever local `main` stopped.
- `aheadBehind` and `branchDiffstat` in `packages/adapters/src/project-detail-source.ts` run `rev-list` and `diff --numstat` over `main...<branch>` with the same bare name.

The pull-request path (`github-changeset-source.ts`, `gitlab-forge.ts`) pins the forge's base tip and hands `captureRangePatchset` a `base...head` three-dot range, so git computes the merge-base against a base the forge just reported. It is not touched.

The result of a stale spelling is always silent. `merge-base <stale> <head>` returns the stale tip when the branch already contains it, the three-dot range then spans every commit the primary branch took after that tip, and the review reads as one branch's work while carrying several.

## Decisions

### D1 — One resolver, and the newest spelling of the primary branch wins

`resolvePrimaryBase(git, root, { primaryBranch?, head })` in `packages/adapters/src/primary-base.ts` returns `{ baseRef, baseOid }`.

The primary name comes from the caller when it has one (`project.primaryBranch`), else from `origin/HEAD`'s target, else from the first of `main`, `master` that any candidate below resolves for. The candidates are every ref that names that branch in this clone, in this order: `refs/remotes/<remote>/<name>` for each remote from `git remote`, with `origin` first, then `refs/heads/<name>`. A candidate that does not resolve to a commit is dropped. Zero candidates resolves to `HEAD` with the head's own OID as base, which is what `resolveBase` does today for a repository with no primary branch at all.

Among the surviving candidates the resolver picks the newest: the one that is an ancestor of no other candidate, tested with `merge-base --is-ancestor`. When two candidates have each moved past the other, the remote-tracking one wins, and among remote-tracking refs the earlier in the order wins. `baseOid` is `merge-base <winner> <head>`. `baseRef` is the winner's short name (`origin/main`, `main`), which is what the working-tree capture records today.

Why the newest ref rather than the nearest merge-base: they are the same answer whenever the candidates are related, because a ref that contains another has a merge-base with the head at least as close to the head. Choosing the ref first keeps one choice per repository, so the row counts, which measure `ref...branch` without a merge-base, can share it. The two answers differ only when the candidates have diverged, and there the remote-tracking rule decides both.

*Rejected:* teaching `captureBranchPatchset` to prefix `origin/`. It would fix the reported case and leave the working-tree path trusting a stale remote-tracking ref over a fresh local one, and leave the row measuring against something else again.

### D2 — No fetch in the capture path

The resolver reads refs and never writes one. The local-review-capture spec's first requirement is that capture mutates no ref, a fetch writes `refs/remotes/<remote>/<name>`, and a fetch reaches the network with whatever credentials git finds, which the honest-copy rule would oblige a new sentence for. The case a fetch rescues is a branch that carries primary-branch commits no local ref knows, which happens when the branch was rebased in another clone and fetched here on its own. That is not the case reported, and Rai's worktree lanes share one clone whose `origin/main` moves on any lane's fetch. If that case bites later it is its own change, with a timeout, `GIT_TERMINAL_PROMPT=0`, and the egress sentence.

### D3 — The row and the review measure the same thing

`loadRepoLocalWork` resolves the primary ref once per repository through the same resolver (with no head, so the choice is the newest-ref half alone) and passes the ref to `aheadBehind` and `branchDiffstat`. A row's ahead count, diffstat and first-commit date then describe the range the row's click captures. The `null/null` answer for an unresolvable base survives: zero candidates yields no ref, and the row keeps saying it cannot measure rather than reading as even.

### D4 — Wire, identity and the round path are untouched

`baseRef` and `baseOid` keep their meaning and their position on `patchset.repository`. The branch-range capture takes only the resolved COMMIT from the resolver and keeps recording the name it was handed (`main`), because that `baseRef` is what an own-branch pull request opens against and a forge only knows its own branches; the working-tree capture still records the winning ref's spelling, and the publish seam — the one place that knows the repository's remotes — strips a leading `<remote>/` before the submission reaches the forge. Identity for a working-tree capture already hashes the sanitized tree and the diff bytes rather than the OIDs, and for a range capture the pinned pair is the identity, so a capture that resolves the same commits produces the same patchset. The round path's successor capture (`captureLandedBranchPatchset`) receives its base OID explicitly from the prior patchset and does not resolve one. `ensureProjectSnapshotPin` still pins the repo map at whatever `baseOid` the resolver produced.

## Risks / Trade-offs

- A repository with a remote named `origin` whose `main` is not the primary (a fork tracking `upstream`) picks `origin/main` before `upstream/main` when the two diverge. `origin/HEAD` still names the primary, and the ordering rule is stated, so the choice is inspectable rather than surprising. The user's fix is the same as today's: point `origin/HEAD` at the branch they mean.
- More git calls per capture: one `remote`, one `rev-parse` per candidate, and up to one `--is-ancestor` per candidate pair. All local, all sub-millisecond on a warm object store.
