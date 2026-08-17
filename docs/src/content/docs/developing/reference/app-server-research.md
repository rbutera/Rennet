---
title: App server research digest
description: What Paseo, T3 Code, Orca, codex-app-server, and the adjacent ecosystem teach Rennet about the local app server refactor, and what the repo recon found.
---

The evidence base for the [app server plan](/developing/reference/app-server-plan/):
a 2026-08-17 survey of the four reference architectures plus the adjacent
ecosystem, and a recon of where Rennet already stands. Read this before
arguing with a decision in the plan — most decisions trace to a finding here.

## The four reference architectures

### Paseo (getpaseo/paseo) — AGPL-3.0, architecture only

"Orchestrate multiple coding agents from desktop and mobile", ~14k stars,
TypeScript throughout. **AGPL license: Rennet may copy the architecture, never
the code — no line-level copying, no schema-file copying, no ports of files.**

- **Docker-model daemon.** One global daemon per machine (default
  `127.0.0.1:6767`, state under `~/.paseo`), projects and workspaces are rows
  inside it. The desktop app spawns it as a detached subprocess and manages it;
  the CLI, web UI, and Expo mobile app are peers over the same protocol.
- **Protocol.** One WebSocket per client; JSON frames plus a small binary
  framing for PTY streams. Zod schemas in a `protocol` package that depends on
  nothing are the single wire truth; inbound validation is AOT-compiled from
  those schemas.
- **The two-contract versioning discipline** (their best idea): wire schemas
  are append-only (new fields optional, never narrow, never remove); features
  are gated once on `server_info.features.*` with no fallback paths ("the user
  updates or doesn't get the feature"); every compat shim carries a dated
  `COMPAT(name)` tag so a grep is the cleanup backlog. App and daemon are
  "separate products that ship separately" — every version-skew combination is
  assumed live.
- **Timeline model.** Daemon-owned, append-only rows with monotonic sequence
  numbers and per-run epochs. The live stream exists for immediacy only; a
  paged fetch is authoritative for catch-up. Reconnecting clients dedupe by
  sequence. Multi-client "just works" because no per-client state sits on the
  acting path.
- **Remote.** Two paths: a zero-knowledge relay (daemon dials outbound;
  Curve25519 ECDH → NaCl box; pairing QR carries the daemon pubkey; relay sees
  ciphertext only; self-hostable) or direct Tailscale/VPN bind.
- **Harness integration.** Claude via `@anthropic-ai/claude-agent-sdk` with
  `pathToClaudeCodeExecutable` — the same choice Rennet made. Codex via
  `codex app-server` JSON-RPC. Six other providers via ACP. Resume rides the
  harness's own session files (`~/.claude/projects/…/{session-id}.jsonl`), not
  a home-grown replay log.
- **Cautionary mass.** Their Claude adapter is ~195KB and the Codex adapter
  ~226KB; the cross-provider normalization layer (`ToolCallDetail` and friends)
  is the reason. Their file-based JSON persistence ("no migrations,
  optional-fields-forever") is a permanent constraint they now document rules
  around; SQLite would have been a guarantee instead of a doc-rule.

### T3 Code (pingdotgg/t3code) — MIT, code copyable

Theo Browne's team (T3 Tools Inc), ~11k stars, TypeScript. An "agent harness
control surface": one server runtime driving Claude Code, Codex, Cursor, Grok,
and OpenCode, with web, Electron, and native mobile clients. **MIT: code may be
copied with copyright notices retained.**

- **"Server is the execution boundary."** Every provider process, terminal,
  git operation, and filesystem read happens in `apps/server`, never in a
  client. Clients are thin by doctrine.
- **Transport.** One authenticated Effect RPC WebSocket with a typed contract
  in `packages/contracts`; methods are unary or server-stream, and clients
  subscribe to exactly the streams they need (`orchestration.subscribeThread`,
  `subscribeShell`, …) — an explicit replacement for an earlier broadcast bus.
- **Event-sourced orchestration.** Typed commands → durable idempotency
  receipt → pure decider → one SQL transaction appending events, applying
  projections, writing the receipt → publish to subscribers. The read model
  cannot durably disagree with the event log; reconnect replay falls out.
- **Shared client runtime.** `packages/client-runtime` holds every non-visual
  client concern — connection supervisor with retry/backoff, auth, RPC session,
  domain state atoms. Web and mobile compose it identically; "React components
  never construct transports, retry loops, or RPC clients."
- **Claude driver uses the Agent SDK** (`ClaudeDriver.ts`), with isolated
  resolved-HOME per instance for multi-account support.
- **Remote.** `npx t3 pair` mints a one-time pairing token and prints a QR;
  `--tailscale` publishes via Tailscale Serve HTTPS. `npx t3 serve` runs
  headless. T3 Connect is their optional relay (Clerk-authenticated, not E2E).
  Linux gets a systemd service whose launcher snapshots the SQLite DB before
  remote updates so a bad candidate rolls back.
- **Auth for remote.** One-time pairing token → RFC 8693 token exchange →
  30-day bearer; short-lived single-purpose WebSocket tickets keep long-lived
  tokens out of socket URLs. A paired phone just works — this is connection
  bootstrap, not ceremony.

### Orca (stablyai/orca) — MIT, code copyable

Stably AI's "Agent Development Environment", ~47k stars, TypeScript
(Electron + React Native mobile + relay). **MIT.** (Disambiguation: not
orca-cli/orca, not the screen reader.)

- **One RPC server, N transports.** `OrcaRuntimeRpcServer` exposed over unix
  socket NDJSON (CLI), WebSocket (mobile/remote), and JSON-RPC over SSH
  channels — one contract everywhere.
- **The wire-compatibility contract** (their best idea): a single
  `RUNTIME_PROTOCOL_VERSION` with explicit min-compatible client/server
  versions, dozens of string capability flags for additive features, tolerant
  Zod `.strip()` decoders, and the axiom "mixed versions are the normal state,
  not an edge case", enforced by a cross-version wire e2e test.
- **Daemon owns sessions; app owns UI.** A local terminal daemon holds PTYs
  out-of-process so agents survive app quit/relaunch/update, with on-disk
  scrollback checkpoints for cold reattach.
- **Remote.** One-time code pairing → per-device token in
  Keychain/Keystore; direct LAN/Tailscale WebSocket as the fast path; their
  account-gated cloud relay as the default path; tweetnacl E2E over the mobile
  transport either way.
- **Cautionary tales.** They PTY-scrape vendor CLIs, so agent state detection
  is a three-signal fusion (terminal-title scraping + injected agent hooks +
  process-tree polling) plus a scanner that reads the agents' own transcript
  files — an entire subsystem the Agent SDK makes unnecessary. Their
  socket-endpoint handover protocol is correct but cost 23 documented defects;
  Rennet's daemon has one launcher and needs a pidfile and a health probe, not
  that protocol.

### codex-app-server (openai/codex) — Apache-2.0, shapes and ideas

The process/protocol behind the Codex desktop app and IDE extension; the
reference for "harness exposes a first-class app protocol". Rennet already
speaks it from the Codex adapter (see the
[Codex app-server integration reference](/developing/reference/codex-app-server/)).

- **Placement.** The TUI and `codex exec` are themselves app-server clients:
  an in-process runtime host (`in_process.rs`) runs the same message processor
  over bounded in-memory channels, while external clients use
  stdio/WebSocket/unix-socket listeners. **One contract, with or without a
  process boundary** — the single most transferable idea.
- **Domain model.** Thread → Turn → Item, with a uniform
  `item/started → typed deltas → item/completed` lifecycle over a closed item
  union. `turn/diff/updated` streams an aggregated unified diff of the whole
  turn after every file change — a diff digest as a protocol event.
- **Server-initiated requests.** Approvals and human-input moments are
  JSON-RPC requests from server to client, answered with a decision, followed
  by a `serverRequest/resolved` notification (also emitted on turn
  start/complete/interrupt) so no client ever shows a stale dialog.
- **Schema discipline.** All wire types in one protocol crate; TS/JSON-schema
  exports generated and checked in as fixtures with a drift test.
- **Multi-client.** Initialize is per-connection with clientInfo and
  per-connection notification opt-out; threads auto-subscribe the starting
  connection. stdio remains the only *supported* transport; ws is labeled
  experimental — a caution Rennet does not inherit (Rennet owns all clients).
- **Not worth copying:** the v1/v2 dual-module legacy drag and
  `#[experimental]` gating macros (costs of a public protocol), the hourly
  daemon self-updater, the stdio-primary posture.

## Adjacent ecosystem, briefly

- **Happy Coder** (slopus/happy, MIT): wrapper around the Claude CLI, not a
  daemon; its server is a dumb sync relay storing **ciphertext only** — keys
  never leave paired devices. The E2E envelope design to copy if Rennet ever
  runs a relay. The wrapper model itself is weaker than a daemon: the session
  dies with the terminal.
- **opencode** (MIT): the cleanest precedent for the split itself — the TUI is
  just a client of a local HTTP server with an OpenAPI spec; `opencode serve`
  runs headless and `attach` joins from any terminal; the server serves its
  own web UI.
- **Claude Code remote control**: first-party `/remote-control` makes the
  local process dial outbound to Anthropic's bridge and poll — zero inbound
  ports, QR pairing. Validates the outbound-only pattern; also the incumbent
  Rennet's remote story competes with. Terminal must stay open.
- **Conductor** (closed): workspace-per-worktree UX and the one-button
  push-and-PR flow; patterns only, no code.
- **Omnara** (Apache-2.0): cloud-relay wrapper with session migration to
  cloud; ideas only (NOTICE obligations).

## License summary

| Source | License | Rennet may take |
| --- | --- | --- |
| T3 Code, Orca, opencode, Happy | MIT | Code verbatim (retain copyright notices) and architecture |
| codex / codex-app-server | Apache-2.0 | Protocol shapes and ideas; avoid verbatim code |
| Paseo | AGPL-3.0 | **Architecture only. No code, no schema files.** |
| Conductor, Claude remote control | Closed | UX patterns; validation of the outbound-only model |

## What the repo recon found

The refactor is smaller than it sounds because the seam already exists:

- **The UI is transport-agnostic today.** `packages/ui` never imports
  Electron; `RennetApp` takes a `RennetBridge` and only calls
  `bridge.invoke(name, input)` / `onProgress` / `onAskStream`. `RennetBridge`
  is defined in `packages/protocol` (`src/index.ts:2675`), not in the desktop
  app. The Electron preload is merely one implementation of that interface
  over `ipcRenderer.invoke`.
- **The wire contract exists.** `commandDefinitions`
  (`packages/protocol/src/index.ts:1867`) maps 49 command names to Zod
  input/output schemas — already a clean, serializable RPC envelope with
  validation gates (`parseCommandInput/Output`).
- **The command router is already Electron-free.** `apps/desktop/src/main/dispatch.ts`
  (~1,700 lines) was deliberately extracted so it unit-tests without an
  Electron runtime; every Electron side effect is injected. It is the natural
  server request handler as-is, and its tests are the refactor's safety net.
- **The composition root is the daemon-to-be.**
  `apps/desktop/src/main/index.ts` (~2,400 lines) instantiates every adapter
  and holds the singletons. Around thirty more modules under
  `apps/desktop/src/main/` (orchestrator, live review backend, review
  intelligence session, the `*-live.ts` turn runners) are product wiring that
  never needed Electron — they move to the server, not stay with the shell.
- **The hand-rolled plumbing to delete** is exactly: the
  `ipcMain.handle("rennet:invoke")` / `ipcRenderer.invoke` pair, the
  `webContents.send` push channels (`rennet:progress` by `commandId`,
  `rennet:ask-stream` by `reviewId`) with preload-side per-id filtering, and
  the preload `contextBridge` bridge implementation.
- **Persistence is nearly daemon-ready.** `SqliteReviewStore` uses
  `node:sqlite` (no Electron dependency); file stores live under `~/.rennet/`.
  The one hard coupling is the DB path from `app.getPath("userData")`.
- **A loopback listener already ships.** `packages/adapters/src/canvas-ops-external.ts`
  binds a `node:http` server on `127.0.0.1` for the MCP canvasOps surface —
  in-repo precedent for local socket serving.
- **Reattach exists.** `review.reattach` plus ask-streams keyed by `reviewId`
  already survive a renderer reload; a daemon generalizes this to any client
  reconnect.
- **Harness adapters are plural today.** Claude (Agent SDK, lazy dynamic
  import, `bypassPermissions`, abort threading), Codex (`codex app-server`
  JSON-RPC over stdio), and omp all sit behind the injected `HarnessPort`
  seam. The daemon inherits all of them.
- **The genuinely new work is R19.** The contracts already mandate that
  remote clients receive a JSON-Schema-first, recipient-specific projection —
  host paths and raw event envelopes never cross the portable boundary.
  Nothing implements that today; everything else in the plan is a move, this
  is a build.

## Authorities check

- `delivery-order.md`: every numbered wave delivered; no daemon/remote/mobile
  work was scheduled before this plan.
- Contracts and rulings: R19 (transport-neutral public protocol, projections
  for remote clients), R17 (durable receipts and events; projections rebuild),
  and the architecture-contracts row "Remote/mobile client — protocol seam
  only; host paths and raw events never cross the portable boundary" all
  *anticipate* this split. The "still open" list names "the product shape and
  transport work for a future remote/mobile client" — the app server plan
  closes that question.
- Rule Zero: pairing and device tokens are connection bootstrap (key exchange
  so a phone can find the daemon), not consent ceremony. Publishing stays
  "Rai clicks post" from any client — a product feature, not a gate.
