## 1. The resolver (D1, D2)

- [ ] 1.1 Adapters: `resolvePrimaryBase(git, root, { primaryBranch?, head? })` in `packages/adapters/src/primary-base.ts`, exported from `index.ts`. Candidates: `refs/remotes/<remote>/<name>` per `git remote` with `origin` first, then `refs/heads/<name>`; drop what does not resolve; choose the newest by `merge-base --is-ancestor`; diverged ⇒ remote-tracking first in remote order. With `head`, also return `merge-base <winner> <head>`. Without a caller name: `origin/HEAD`'s target, else the first of `main`, `master` with any candidate. Zero candidates ⇒ `{ baseRef: null }`, no throw. Read verbs only: no `fetch`, no ref write
- [ ] 1.2 Tests on a real git fixture with a bare remote: local behind remote picks `origin/main`; local ahead picks `main`; diverged picks `origin/main`; no remote picks `main`; nothing ⇒ null; with a head, the base is the merge-base and a branch cut from the fresher spelling gets that spelling's tip. Control: replace the newest-ref choice with "first candidate" and watch the local-ahead case redden

## 2. The two capture paths (D1, D4)

- [ ] 2.1 `git-capture.ts`: `resolveBase` delegates to the resolver, keeping `HEAD` as the zero-candidate fallback so `baseRef`/`baseOid` keep today's shape. The existing mocked-git tests keep passing with their `origin/main` answers
- [ ] 2.2 `git-capture.test.ts`: a real-repo fixture with a bare `origin`, local `main` at X, `origin/main` at Y (a sibling's file landed between), the checked-out branch cut from Y with one commit; the patchset's `baseOid` is Y and the sibling's path is absent from `files`. Control: point the resolver at `refs/heads/main` alone and watch the sibling's path appear
- [ ] 2.3 `create-server.ts`: `captureBranchPatchset` resolves `{ baseRef, baseOid }` through the resolver from `input.base` as the primary name and `headOid` as the head, records the resolved `baseRef`, and falls back to `input.base` verbatim when the resolver has no candidate (so a caller passing an OID or `HEAD` still works). The `create-server.test.ts` fixture that passes `base: "main"` keeps passing
- [ ] 2.4 `create-server.test.ts` (or `work-branch.test.ts`, whichever holds the branch-capture fixtures): the same stale-local-`main` fixture through `captureBranchPatchset` with `base: "main"`; `baseOid` is `origin/main`'s tip and the sibling's path is absent. Control as 2.2

## 3. The row (D3)

- [ ] 3.1 `project-detail-source.ts`: `loadRepoLocalWork` resolves the primary ref once per repository and passes it to `aheadBehind` and `branchDiffstat`; an unresolvable primary still yields `null/null` and an empty diffstat, never `0/0`
- [ ] 3.2 `project-detail-source.test.ts`: the stale-local-`main` fixture yields ahead `1`, behind `0` and a diffstat of the branch's own file; a repo with no primary ref keeps `null/null`. Control: measure against the bare name and watch ahead grow past 1

## 4. Documentation

- [x] 4.1 `docs/using/guides/getting-started.md`: the two sentences about a local branch's numbers and what a branch row captures say the measurement is against the newest of the clone's spellings of the primary branch (`origin/main` or `main`, whichever is ahead), in the guide's voice, without narrating the old behaviour
- [x] 4.2 `docs/developing/concepts/architecture-overview.md`: the capture step names the resolved primary base rather than "the merge-base"
- [ ] 4.3 The cost sentence goes in the PR description, delivered by the orchestrator: nothing a session sends changes; capture runs a few more local `rev-parse` / `merge-base --is-ancestor` calls
