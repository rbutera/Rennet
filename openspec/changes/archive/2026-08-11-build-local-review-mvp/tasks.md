## 1. Workspace foundation

- [x] 1.1 Add exact eligible production, build, lint, and test dependencies from the dependency standard
- [x] 1.2 Create Nx/pnpm projects for types, protocol, core, adapters, UI, and desktop with enforced package arrows
- [x] 1.3 Add shared TypeScript, Biome, ESLint boundary, Vite, Vitest, Playwright, and Forge configuration

## 2. Domain and protocol

- [x] 2.1 Define dependency-free repository, patchset, changed-file, review, and read-state types
- [x] 2.2 Define the Zod command map, structured errors, and typed invoke contract
- [x] 2.3 Implement pure review-event folding, patchset-scoped read state, invalidation, and command payload hashing

## 3. Local adapters

- [x] 3.1 Implement the read-only Git capture adapter with base resolution, mixed change sources, byte caps, and deterministic patchset IDs
- [x] 3.2 Implement the built-in SQLite event store with schema gate, replay, transactional command receipts, and idempotency
- [x] 3.3 Implement debounced repository watching that emits recapture hints without deciding review truth

## 4. Secure desktop vertical slice

- [x] 4.1 Implement the single validating IPC dispatcher, restricted preload API, and exact sender validation
- [x] 4.2 Implement the Electron main process, native repository picker, local store wiring, secure BrowserWindow, and production app protocol
- [x] 4.3 Build the React review surface for first run, capture, file selection, raw diff, read progress, invalidation, and explicit regeneration
- [x] 4.4 Add Forge packaging with hardened fuses, local ad-hoc macOS signing only, and no distribution signing, updater, publisher, telemetry, or remote effects

## 5. Verification and documentation

- [x] 5.1 Add Git fixture integration tests covering committed, staged, unstaged, untracked, empty, repeat, and changed captures
- [x] 5.2 Add event-store tests covering replay, restart, command retry, payload mismatch, read state, regeneration, and unknown-event failure
- [x] 5.3 Add protocol, Electron security, renderer, and real Electron IPC smoke tests with calibrated failing controls
- [x] 5.4 Run full Nx format, lint, architecture, typecheck, test, build, e2e, package, licence, and vulnerability gates
- [x] 5.5 Update README, master plan, evidence status, dependency standard, and Navi handoff with the implemented MVP boundary and remaining gaps
