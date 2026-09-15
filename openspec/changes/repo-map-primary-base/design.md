## Context

`resolveBaseRef` (`packages/adapters/src/project-snapshot-source.ts:68`) tries three tiers in order and returns the first that resolves to a commit: the caller's `explicitBaseRef`, then `origin/HEAD`'s short target, then `@{upstream}`. Each tier is resolved with `rev-parse --verify --quiet <ref>^{commit}`. For a branch name that is git's own refname disambiguation, which reads `refs/heads/<name>` before `refs/remotes/*/<name>`, so an explicit `main` is the local branch even when `origin/main` is a week ahead of it.

Seven call sites use it: the initial map build (`project-snapshot-generator.ts:188`, handed `explicitBaseRef: project.primaryBranch` by `process-project.ts:405`), the proactive watcher's re-resolve and delta pass (`baseline-advance-watcher.ts:177`, `proactive-rehydration.ts:87`, both handed the same name), the capture-time pin (`project-snapshot-pin.ts:42`, no name, then the patchset's OID on fallback), and the live-review backend's rebuild (`live-review-backend.ts:666`, no name, then the patchset's `baseRef` on fallback).

`resolvePrimaryBase` (`primary-base.ts`, from `fresh-base-patchset`) already answers "given a branch name, which spelling in this clone is newest, and what is its tip". It returns `null` for a name that is not a branch in the clone, which is how `captureBranchPatchset` tells an OID from a name.

## Decisions

### D1 — The branch-name tiers of `resolveBaseRef` go through the resolver; OID tiers stay verbatim

For the `explicit-setting` tier: call `resolvePrimaryBase(git, topLevel, { primaryBranch: explicitBaseRef })`. A non-null answer wins the tier with `baseRef` = the winning short name and `baseOid` = `baseTipOid`. A null answer means the value is not a branch name in this clone, and the tier falls back to today's `rev-parse <value>^{commit}`, which is how an OID (the pin's fallback, the generator's `explicitBaseRef: defaultBase.baseOid`) keeps resolving verbatim.

For the `symbolic-head` tier: `resolvePrimaryBase(git, topLevel, {})` with no name, which reads `origin/HEAD` itself, falls through a dangling target to `main`/`master`, and picks the newest spelling. Today's tier only reads `origin/HEAD` and only takes the remote-tracking spelling; after this it also considers a local branch that is ahead.

The tier is **gated on `origin/HEAD` existing** (`symbolic-ref --quiet refs/remotes/origin/HEAD`, existence only — a dangling TARGET still exits 0, so the fallthrough above keeps working), because the resolver's caller-less probe does not require one: ungated, the tier would answer `main`/`master` in a clone that has no `origin/HEAD` at all, and `baseRefResolution` is provenance stamped on the manifest — a `symbolic-head` that read no symbolic head is a lie. The gate also keeps the tier's REACH where it is, so a remoteless clone still fails closed to the caller's own fallback rather than newly resolving.

The `configured-upstream` tier is untouched: `@{upstream}` is already a specific remote-tracking ref, not a name with several spellings.

The order of tiers, the `baseRefResolution` labels and the fail-closed throw are unchanged. `explicit-setting` still means the caller named the branch; which spelling of it won is what `baseRef` reports, exactly as a working-tree patchset reports `origin/main` or `main`.

*Rejected:* changing the three call sites to resolve the OID first and pass it as `explicitBaseRef`. It would fix the writers and leave the function itself still resolving a name to the stale spelling for the next caller, and it is three edits where one suffices.

### D2 — The store key and the resolution provenance do not move

`repoKey` is still the escaped realpath of the top level, computed before any tier runs. `ResolvedBase` keeps its shape. Nothing on the wire changes.

### D3 — No fetch

`fresh-base-patchset` D2 applies verbatim: the resolver reads refs and writes none.

## Risks / Trade-offs

- A stored manifest built at local `main` under the old rule will, once, resolve to a different OID (`origin/main`'s tip) and trigger one delta pass forward. That is the pass the old rule was already triggering at every capture, so the one-time cost is strictly less than today's recurring one.
- The `symbolic-head` tier can now answer a local branch name (`main`) where it only ever answered a remote-tracking one (`origin/main`). Every consumer of `baseRef` on this path treats it as a display string or re-resolves it; none parses the `origin/` prefix. Verified by reading `progress.detail` in the generator and the fallback in `live-review-backend.ts`.
