## Why

The repo map's baseline and the review's base are resolved by two different rules, and they disagree. `fresh-base-patchset` (#946) made every local capture measure against the newest spelling of the primary branch, `origin/main` or `main`, whichever is ahead. The repo map still pins its base map wherever `resolveBaseRef` lands, and that function takes an explicit branch name as the highest-precedence tier and resolves it with a bare `rev-parse`, which reads the local branch. Two writers pass the bare `project.primaryBranch`: the initial build when a project is added (`process-project.ts`) and the proactive watcher that advances the map as refs move (`proactive-rehydration.ts`, through `baseline-advance-watcher.ts`). A third path, `ensureProjectSnapshotPin` at capture time, passes no name and so lands on `origin/HEAD`'s target instead.

The result is a ping-pong. The watcher keeps the base map at local `main`. The capture-time pin wants it at `origin/main`, finds the manifest elsewhere, and regenerates the whole base map synchronously before the review can proceed. On the next ref write the watcher re-resolves to local `main` and runs a delta pass back to the older commit. The next capture rebuilds forward again. Every review is still correct, because the pin overlays to the patchset's exact merge-base and `loadFresh` gates on it, but the reviewer pays a full map build at capture time that the proactive pass exists to have already paid, and the warm cache is warm at the wrong commit.

## What Changes

- **`resolveBaseRef` resolves a branch name through the primary-base resolver.** When the explicit ref, or the `origin/HEAD` target, is a branch name, the function considers every spelling of that name in the clone and takes the newest, exactly as capture does, reporting the winning short name as `baseRef` and its tip as `baseOid`. An explicit value that is not a branch name in this clone (an OID, which the pin and the generator already pass) is taken verbatim, as today. The `@{upstream}` tier and the fail-closed throw survive unchanged.
- **Every repo-map writer and the pin inherit it without a call-site change.** The initial build, the proactive watcher's re-resolve and delta pass, the capture-time pin's default base and the live-review backend's rebuild all go through this one function, so the three resolutions land on one OID and the ping-pong stops.
- **No fetch.** Same decision as `fresh-base-patchset` D2, for the same reasons.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repo-map-delta-pass`: the resolved default-branch OID that baseline detection and the delta pass advance to is the primary base as `primary-base-resolution` defines it, so the proactive pass and the capture-time pin agree.

## Impact

- `packages/adapters/src/project-snapshot-source.ts`: `resolveBaseRef` resolves branch-name tiers through `resolvePrimaryBase`; OID tiers stay verbatim.
- No change to `process-project.ts`, `proactive-rehydration.ts`, `baseline-advance-watcher.ts`, `project-snapshot-pin.ts`, `project-snapshot-generator.ts` or `live-review-backend.ts`: their calls are unchanged and now agree.
- `baseRefResolution` provenance keeps its three values; `explicit-setting` still means "the caller named it", `symbolic-head` still means "`origin/HEAD` named it" — the tier is gated on that symbolic ref existing, so the label never claims a symbolic head nobody read, and a clone without one fails closed exactly as it does today. Which spelling won is visible in `baseRef`.
- Tests: a real-git fixture with local `main` behind `origin/main` proves the explicit-name tier and the `origin/HEAD` tier both land on `origin/main`'s tip, and that an explicit OID is taken verbatim; a second fixture with local `main` ahead proves `main` wins; an end-to-end check that the pin's default base and the watcher's re-resolve are the same OID on the stale fixture.
- Docs: none of the reader-facing pages name which ref the map is built at; `docs/developing/concepts/architecture-overview.md` already says the capture step resolves the primary base and the map is pinned at it, which is now true for the map's own baseline too. No page becomes wrong.
- Harness cost: **nothing a session sends changes.** The resolver runs a few more local `rev-parse` / `merge-base --is-ancestor` calls per resolution.
