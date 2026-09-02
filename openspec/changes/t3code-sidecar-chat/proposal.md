## Why

Rennet's orchestrator chat is a hand-rolled, fresh-process-per-turn transcript with none of the session features an agentic engineer expects: inline approvals, agent questions, plan capture, subagent tracking, a context meter, per-turn diffs. T3 Code (pingdotgg/t3code, MIT) ships all of it, defaults to the same full-access posture Rule Zero mandates, and drives the same two harnesses the same way. Rai's direction on 2026-09-02: stop re-implementing it and take the code. This change vendors a snapshot of T3 Code's inner layers into the Rennet monorepo with a documented strategy for inspecting and folding upstream changes, runs the vendored server as a sidecar the Rennet daemon owns, puts T3's thread UI in the chat slot, and keeps Rennet's own adapters for lens seats.

## What Changes

- A selected set of T3 Code paths is vendored under `vendor/t3code/` at a recorded upstream commit: `packages/{contracts,shared,client-runtime,effect-codex-app-server,effect-acp}`, `apps/server` source, and `apps/web` source. The MIT licence and notices travel with it. Vendored code keeps upstream formatting and is excluded from Rennet's formatter and linter.
- A `t3-vendor` branch holds pristine upstream snapshots of exactly those paths. Two scripts drive upkeep: `t3:inspect` writes a dated digest of upstream commits touching vendored paths, flagging conflict risk against local edits; `t3:fold` advances the vendor branch to a chosen upstream commit and merges it. Every local edit to a vendored file is recorded in a patch ledger with its reason and upstream status.
- The Rennet daemon builds the vendored server with T3's own bundler and spawns it as a sidecar under a private base directory in Rennet's data directory, never the user's `~/.t3`. Startup passes a one-time bootstrap credential over a file descriptor, seeds the sidecar's provider settings with the absolute harness binary paths Rennet already discovered, disables T3 telemetry, and passes no T3 Connect configuration. Quit stops the sidecar with the daemon.
- The chat slot in the review workspace can render the T3 thread for the session's thread. First rung is an embedded webview of the sidecar's served UI at a thread route; second rung is a native mount of T3's `ChatView` over the vendored client runtime with a theme bridge from Rennet's tokens. Which rung ships is a spike outcome.
- A handoff work order can be dispatched as a turn on a T3 thread whose cwd is the review's checkout, in full-access mode, so the coding-agent loop runs through T3's session model with approvals, questions and per-turn diffs visible.
- A per-project chat engine setting chooses the Rennet orchestrator or the T3 sidecar. Default stays Rennet until the spike is judged.
- Health and the connection bar disclose the sidecar as a second owned process with harness-only egress. The engine setting states that T3 threads persist to the harness's own history, that their usage shows in T3's usage view rather than Rennet's seat collector, and that T3 writes hidden checkpoint refs into the reviewed repository.

Out of scope: retiring the Rennet orchestrator, moving lens seats onto T3, T3's mobile client, T3's right-panel tabs beyond what the thread view mounts on its own, running the vendored server in-process.

## Capabilities

### New Capabilities
- `t3code-vendoring`: a snapshot of T3 Code lives in the monorepo with a recorded base, a pristine vendor branch, inspect and fold scripts, and a patch ledger.
- `t3code-sidecar`: the Rennet daemon owns a T3 Code server built from the vendored source: spawn, bootstrap credential, provider seeding, telemetry posture, disclosure, stop.
- `t3code-chat-surface`: the review workspace renders a T3 thread for the session and can route a handoff work order to it.

### Modified Capabilities
- `tray-presence`: Quit stops the owned sidecar alongside the owned daemon.

## Impact

- New top-level `vendor/t3code/` with `UPSTREAM.json`, `PATCHES.md`, `digests/`, and the upstream `LICENSE`; `scripts/t3-upstream.mjs` for inspect and fold; the `t3-vendor` branch.
- Workspace: `pnpm-workspace.yaml` gains the vendored packages and T3's catalog entries plus its pnpm patch on Effect; `vp` (vite-plus) and `tsgo` as dev dependencies; Biome and ESLint ignore `vendor/`; an Nx project per vendored package with test and build targets wrapping T3's runner.
- `packages/server`: sidecar supervisor beside the daemon lifecycle, a T3 RPC client module (the one place `effect` and `@t3tools/*` are imported by Rennet code), `/health` fields, `chat.engine` setting, a T3 exit on the handoff loop.
- `apps/desktop`: tray Quit and `stopOwnedDaemon` extend to the sidecar; a `<webview>` host for rung one.
- `packages/app-ui`: chat slot switch on the engine setting; rung two mounts `ChatView` with a Vite alias into the vendored web source and a CSS theme bridge.
- `packages/protocol`: health and settings shapes gain sidecar fields.
- Docs: new `docs/developing/concepts/t3code-vendoring.md` and `t3code-sidecar.md`; the dependency standard entry for the vendored snapshot; the egress statement in `product-and-vision.md`; `harness-adapters.md` cross-reference; CLAUDE.md gains the vendoring rules.
- Egress and size: the sidecar adds a second local server process; the renderer bundle grows by the vendored web packages and Effect on rung two, with the measured delta reported in the PR.
