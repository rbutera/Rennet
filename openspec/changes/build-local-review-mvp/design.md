## Context

Rennet currently contains authority documents, measured spikes, an interactive static prototype, and an Nx foundation. This change creates the first executable product slice without entering the unresolved harness, model-routing, GitHub publication, release, or client-data decisions. The source repository is untrusted input and must remain unmodified. The desktop app has no backend and stores its own state under Electron's application-data root.

## Goals / Non-Goals

**Goals:**

- Prove the ratified package arrows in production TypeScript code.
- Capture a local repository's complete current changeset as an immutable, content-addressed patchset using read-only Git operations.
- Persist an append-only review history with command idempotency and reconstructable projections in built-in SQLite.
- Show a coherent desktop review surface with explicit current, invalid, and regenerate states.
- Exercise a real renderer-to-preload-to-main-to-core-to-adapter round trip under secure Electron defaults.
- Keep builds, tests, lint, and typecheck inside the Nx graph with deterministic local caching.

**Non-Goals:**

- Model or harness execution, semantic angle synthesis, or generated findings.
- GitHub reads or writes, PR previews, reviews, comments, approvals, or source pushes.
- Production signing, notarization, updates, telemetry, remote caching, or release publication.
- Line-level diff parsing, lineage matching, LSP integration, project snapshots, or the full M0 dogfood contract.
- Client repository support or any fixture derived from client work.

## Decisions

### One local vertical slice across the final package arrows

Create `types`, `protocol`, `core`, `adapters`, `ui`, and `desktop` as real pnpm/Nx projects. `types` remains dependency-free; `protocol` imports `types`; `core` imports `protocol` and `types`; `adapters` imports `core`, `protocol`, and `types`; `ui` imports only `protocol` and `types`; desktop composes adapters, core, and UI. This costs more initial scaffolding than a single Electron folder, but proves the frozen licence and runtime boundaries before product code accumulates around the wrong shape.

### Git remains changeset truth

The adapter runs a resolved Git executable with argument arrays and `shell: false`. It resolves the repository root, git-common-dir, head, default-branch candidate, and merge base using plumbing commands. One tracked diff from the merge base includes committed branch work, index changes, and unstaged tracked changes. Non-ignored untracked paths come from `git ls-files --others --exclude-standard -z` and are appended as new-file patches without writing inside the repository. The patchset ID hashes canonical provenance plus exact captured bytes. Chokidar is only a recapture hint; a new Git capture decides whether the patchset changed.

Alternative rejected: `simple-git` and string-first diff parsers hide byte/output contracts. Alternative rejected: `git worktree add` mutates user Git metadata. Full byte-level ingestion and pathological-path parsing remain a later gated subsystem.

### Append-only SQLite events with a disposable projection

The adapter uses Electron's built-in `node:sqlite` in the main process for this slice. A `commands` table stores command ID, payload digest, and serialized result. An `events` table stores monotonic sequence, review ID, event type/version, privacy flag, and JSON payload. The current review is folded from events at read time and cached only in memory. Capture, read-state mutation, and command receipt commit in one transaction. Unknown event types fail loading instead of being skipped.

Alternative rejected: Kysely and event-sourcing frameworks were already retired by the Electron SQLite spike and would not remove Rennet's event, replay, idempotency, or fail-closed semantics.

### One typed IPC dispatcher

`packages/protocol` defines a Zod command map. The preload exposes only `invoke(command, input)` through `contextBridge`; the main process has one dispatcher that validates input and output. There is no Node integration in the renderer. Sender validation accepts only the exact development origin or the production `app://rennet` origin. Native folder selection is a command implemented by the desktop host, not renderer filesystem access.

Alternative rejected: electron-trpc and Comlink would bind the portable protocol to a second RPC model.

### Plain Vite plus Electron Forge ownership

Vite builds renderer, main, and preload through explicit configs. Forge owns packaging configuration but signing, notarization, publishing, and updating stay absent. The Nx project declares build, typecheck, test, e2e, dev, and package targets; only deterministic targets cache. This follows the dependency standard and avoids Forge's experimental Vite plugin and the duplicate electron-builder path.

### MVP invalidation is explicit and conservative

After capture, Chokidar watches the repository excluding `.git`, `node_modules`, `.rennet`, and ignored heavy directories. A debounced recapture compares the current content-addressed patchset ID. If it differs, the current review becomes `invalid` and retains the old patchset and read state. Regenerate is a user command that appends the new patchset and resets changed-file read state. No model call happens automatically. This is conservative compared with future item-level invalidation, but already obeys the never-silently-trust-stale rule.

## Risks / Trade-offs

- [Pathological Git paths and very large patches are not fully parsed] → Preserve raw captured bytes, impose a visible size cap, mark truncation, and do not claim the later totality gate is complete.
- [Watching can miss or duplicate filesystem events] → Watch events never decide state; each event triggers a debounced Git recapture and content-ID comparison.
- [Synchronous SQLite can block] → Keep transactions short and payload volume bounded in this slice; move the store into the engine utility process before heavy analysis lands.
- [Development HTTP origin differs from production custom protocol] → Validate an exact configured development origin and separately test the production protocol and security settings.
- [A stacked branch depends on the unmerged Nx foundation] → Keep the dependency explicit in the handoff and do not open or publish a PR automatically.
- [The UI can look more complete than the engine is] → Label deterministic/manual capabilities honestly and list unavailable model angles as not generated rather than empty-success states.
