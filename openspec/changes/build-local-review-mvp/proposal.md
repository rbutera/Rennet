## Why

Rennet has decision-complete architecture and a realistic prototype, but no executable product loop. The safest autonomous work is a local-only vertical slice that proves the package boundaries, secure desktop transport, immutable review capture, persistence, and invalidation UX without spending money, calling a model, publishing anything, or settling deferred product choices.

## What Changes

- Add the first production Nx packages and an Electron desktop application using the dependency and licence boundaries already ratified in the repository.
- Let a user choose a local personal repository and capture committed branch changes, staged changes, unstaged tracked changes, and non-ignored untracked files into an immutable patchset.
- Persist review and patchset events locally in built-in SQLite, rebuild the current projection on launch, and retain the previous patchset when source changes are detected.
- Render a usable local review surface with repository identity, patchset provenance, changed-file summaries, raw diff content, per-file read state, and explicit stale/regenerate behavior.
- Add deterministic tests and Electron security assertions for the end-to-end command path.
- Update current authority and handoff documentation with the implemented slice and its remaining gaps.
- Keep harness execution, semantic angle generation, GitHub mutation, signing, updates, telemetry, client repositories, and public release out of scope.

## Capabilities

### New Capabilities

- `local-review-capture`: Select and validate a repository, resolve the review base, and produce immutable local patchsets without mutating the source repository.
- `local-review-persistence`: Store reviews, patchsets, read-state events, and current projections locally with replay-safe command receipts.
- `desktop-review-surface`: Securely expose the local-review command map to an Electron renderer and present review, invalidation, and regeneration states.

### Modified Capabilities

None.

## Impact

- Adds `apps/desktop` and the initial `packages/types`, `packages/protocol`, `packages/core`, `packages/adapters`, and `packages/ui` workspaces.
- Adds the eligible exact dependencies selected by [[Rennet Dependency Standard]] for Electron, React, schemas, processes, persistence, build, lint, and tests.
- Extends the Nx graph, cache inputs, root gates, and agent guidance with production targets.
- Adds only local filesystem, Git subprocess, and SQLite effects. There is no provider, GitHub, telemetry, remote cache, signing, notarization, or publishing effect.
