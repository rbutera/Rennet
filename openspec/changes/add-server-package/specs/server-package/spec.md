# server-package Specification

## Purpose

Rennet's composition root and command routing live in `packages/server`, constructed by `createRennetServer(options)`; the Electron app is a shell that instantiates the server in-process and forwards its IPC to it. Behavior is identical to the pre-extraction app; persistence carries over byte-for-byte.

## ADDED Requirements

### Requirement: One composition factory, no module-level singletons

`packages/server` SHALL export `createRennetServer(options)` returning a handle with `dispatch` (the existing dispatch signature, including the `DispatchContext` push seam) and `shutdown`. All state formerly held in module-level singletons SHALL be instance state of the factory; two servers created in one process SHALL NOT share mutable state.

#### Scenario: two instances are independent

- **WHEN** `createRennetServer` is called twice in one process with distinct options
- **THEN** mutating one instance's state (e.g. granting a repository root, registering a live turn) is not observable through the other

#### Scenario: dispatch signature is unchanged

- **WHEN** the Electron invoke handler calls `server.dispatch(name, input, { emitProgress, emitAskStream, progressRecipientId })`
- **THEN** commands behave exactly as the pre-extraction dispatch did, including progress and ask-stream pushes through the provided closures

### Requirement: Electron-owned effects are injected, not imported

The server package SHALL NOT import Electron. The data directory, the repository-chooser fallback dialog, the progress broadcast used by background rehydration, and the process environment SHALL arrive as `createRennetServer` options; the Electron shell SHALL supply them from its own APIs.

#### Scenario: the server builds without Electron

- **WHEN** `packages/server` is built and its tests run
- **THEN** no module in the package imports `electron`, and the architecture gate enforces the package's declared import edges

#### Scenario: persistence carries over byte-for-byte

- **WHEN** the extracted app starts against an existing user data directory (previous `rennet.sqlite`, config, threads, projects)
- **THEN** the server opens the same files at the same paths, and no migration or data change occurs

### Requirement: Shutdown quiesces exactly as before-quit did

`shutdown()` SHALL abort live turns, close the repo watcher, close rehydration, and close the store — in that order — and SHALL be idempotent. The Electron shell's `before-quit` SHALL call it.

#### Scenario: shutdown is idempotent

- **WHEN** `shutdown()` is called twice
- **THEN** the second call completes without error and without repeating side effects

### Requirement: Behavior identity is proven by the untouched e2e suite

The existing e2e specs (`add-project`, `local-review`, `review-canvases`) SHALL pass without modification against the extracted app.

#### Scenario: e2e passes unmodified

- **WHEN** the e2e suite runs against the post-extraction build
- **THEN** all three specs pass with zero edits to the spec files or the harness
