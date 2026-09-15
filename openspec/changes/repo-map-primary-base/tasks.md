## 1. The resolver inside `resolveBaseRef` (D1, D2)

- [x] 1.1 `packages/adapters/src/project-snapshot-source.ts`: the `explicit-setting` tier resolves through `resolvePrimaryBase(git, topLevel, { primaryBranch })`, taking `baseRef` = the winning short name and `baseOid` = `baseTipOid` on a non-null answer, and falling back to today's `rev-parse <value>^{commit}` on null so an OID resolves verbatim; the `symbolic-head` tier resolves through `resolvePrimaryBase(git, topLevel, {})`; the `configured-upstream` tier, the tier order, the `baseRefResolution` labels, the `repoKey` computation and the fail-closed throw are unchanged. Read verbs only
- [x] 1.2 Tests, real git with a bare `origin` (a new `project-snapshot-source.test.ts`, or beside the existing `resolveBaseRef` coverage if a suite already holds it): local `main` behind `origin/main` with `explicitBaseRef: "main"` → `origin/main`'s tip and `baseRef === "origin/main"`, `baseRefResolution === "explicit-setting"`; the same fixture with no explicit ref and `origin/HEAD` set → the same OID, `baseRefResolution === "symbolic-head"`; local `main` ahead → local tip, `baseRef === "main"`; an explicit OID → that OID verbatim; no primary and no upstream → still throws. Control: replace the resolver call in the explicit tier with the bare `rev-parse` and watch the first case redden

## 2. The writers agree (D1)

- [x] 2.1 A test that builds the stale-local-`main` fixture, runs `ensureProjectSnapshotPin(store, root, <merge-base>)` once, then calls `baselineAdvanceDepsFor`'s `resolveCurrentBaseOid` (or the equivalent seam `proactive-rehydration.ts` wires with `explicitBaseRef: "main"`) and asserts it equals the manifest's `baseOid`, so the watcher's no-movement rule holds after a capture. Control: revert 1.1 and watch the two OIDs differ
- [x] 2.2 Confirm by reading, and state in the PR body, that `process-project.ts:405`, `proactive-rehydration.ts:274`, `baseline-advance-watcher.ts:177`, `project-snapshot-pin.ts:42`, `project-snapshot-generator.ts:188` and `live-review-backend.ts:666` need no edit; existing suites for each keep passing

## 3. Documentation and the cost sentence

- [x] 3.1 Read `docs/developing/concepts/architecture-overview.md` and `docs/developing/concepts/architecture-contracts.md` for any sentence naming which ref the map is built at; edit only if one is now wrong (the proposal expects none)
- [ ] 3.2 The PR body carries the cost sentence: nothing a session sends changes; a resolution runs a few more local git reads
