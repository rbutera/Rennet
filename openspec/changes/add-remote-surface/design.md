# Design — add-remote-surface (#380)

## Context

Recon facts (verified on main with phases 0-2 merged; phase 3 adds the daemon — re-verify seams):

- **R19** (contracts-and-rulings.md:110) + architecture-contracts.md:29 (remote row: "Host paths and raw events never cross the portable boundary"). Open item at contracts-and-rulings.md:262.
- **Host-path surface (outbound scrub targets)**: `repositoryProvenanceSchema.root/.commonDir` (protocol/src/index.ts:121-122, embedded in every patchset), `reviewSchema.repositoryRoot` (:288), `discoveredRepoSchema.path` (:656), `discoveryResultSchema.path` (:674), `projectSchema.path/.openPath/.includedRepoPaths` (:688,:701,:708), `processedRepoSummarySchema.path` (:758, rides progress events), `repository.choose` output (:1875).
- **Inbound host-path inputs (reverse-resolve targets)**: `review.capture.repoPath` (:1880), `review.openPr` (:1897), `review.checkFreshness` (:1942), `review.regenerate` (:1950), `review.canvases` (:1964), `project.discover.path` (:2194), `settings.guidance/.setRepoVisibility/.setRepoLocus/.resetRepoValue/.pinRepoValue` (:2506-2592).
- **Already repo-relative (do NOT touch)**: patchset file paths, disposition/canvas/refine/uiEvidence/openInEditor paths, conversation anchors. **Opaque IDs (no scrub)**: localWork/pullRequest/worktreeId.
- **Free-text leak surface**: progress `note`/`detail` (:801-803), ask-stream `delta`/`finalBody`, `patchset.rawDiff`.
- zod 4.4.3; `z.toJSONSchema` already used in `bodies.ts` (with `delete projected.$schema` workaround). No JSON-Schema fixture test yet; `schema-coverage.test.ts` is a compile-weld, different mechanism.
- Publish consent: single-use in-memory token authority (`publish-consent-authority.ts`), client-driven via `publish.requestConsent` → `publish.review` (dispatch.ts:682-701, :764-773). **Works over any connection already.**
- `canUseTool`: deterministic local predicate (orchestrator-turn.ts:327-337 allows only canvas-ops MCP); harness runs use bypassPermissions; codex adapter auto-grants. **No human question exists to forward.**
- ws-listener: `sockets: Set`, per-connection `connectionId` + `helloReceived`; bind hardcoded `httpServer.listen(0, "127.0.0.1")`; `features: {}`; deps `{dispatch, serverVersion}`. Bearer slots into `case "hello"`.
- Config: `~/.rennet/config.json` via FileConfigStore (atomic, malformed-protected); `globalConfigSchema` (:1562) currently `{version, appearance?, keybindings?}`. GitHub SecretStore is stubbed; no keychain wiring exists.
- No QR lib in tree. Settings screen = flat `settings-panel` sections invoking bridge commands directly.
- Session frames: exactly 7; no server-initiated request. Client bridge discards serverInfo today.

## Goals / Non-Goals

**Goals:**

- R19 exactly: token-bearing connections never see a host-absolute path, in either direction; loopback keeps the private contract untouched (zero risk to the existing app).
- Pairing that is pure bootstrap: one exchange, then a device works for weeks. Honest revocation.
- The public contract is a checked-in, drift-tested artifact — a future client team (mobile) builds against files, not against a running server.

**Non-Goals:**

- No relay (Rai-ratified). No TLS termination (Tailscale provides transport crypto). No account system.
- No auth on loopback. No per-action approval anywhere.
- No consumer for the server-request frames (wire support only — see proposal §4; the deviation is flagged, not silent).
- No keychain/safeStorage work: device tokens are server-side secrets hashed at rest; the CLIENT-side token lands in the client's own storage (browser localStorage / mobile Keychain in later phases — desktop loopback needs none).

## Decisions

**D1 — Connection classes at handshake, nothing later.** `hello` gains optional `deviceToken`. Listener classifies each connection once: `private` (socket's remote address is loopback) or `projected` (non-loopback; must present a token that hashes to a stored device — else the only accepted request is `pairing.exchange`). The class picks the frame codec for the whole connection lifetime. No mid-connection reclassification.

**D2 — The projection is a frame-boundary codec in `packages/server` (`projection.ts`), not a fork of dispatch.** Outbound: `projectFrame(frame, ctx)` deep-maps the structural host-path fields listed in Context (schema-driven table of {command/frame → JSON paths}, not reflection guessing) into `{repoKey, displayName}` refs or drops-with-substitution; free-text fields pass through `scrubRoots(text, ctx.roots)` (replace known repo roots + home dir with display tokens). Inbound: `resolveInputs(command, input, ctx)` maps projected refs back to host paths via the project store; an unresolvable ref is an `rpcError invalid_input`, never a guess. `ctx.roots` derives from the project store + review provenance at connection time and refreshes on project changes. Dispatch, stores, and the private contract are untouched.

**D3 — `repoKey` is the existing snapshot-store repo key** (the escaped-path key already used under `~/.rennet/projects/`) — stable, derivable both ways server-side, meaningless off-machine. `displayName` = basename + disambiguator. The public shape for a repo reference is `{repoKey, displayName, relativePath?}`.

**D4 — JSON-Schema fixtures: generate → check in → drift-test.** A build-adjacent script (`pnpm nx run rennet-protocol:public-schema`, cacheable, or a plain test-time generator) produces `packages/protocol/public-schema/*.json` from the projected Zod shapes via `z.toJSONSchema` (same `$schema`-strip workaround as bodies.ts). A vitest compares regenerated output to the checked-in fixtures byte-for-byte and fails on drift with "regenerate + review the diff" guidance. The fixtures ARE the public contract deliverable R19 names.

**D5 — Pairing store: `~/.rennet/devices.json`**, FileConfigStore-style atomic document: `{version, devices: [{deviceId, name, tokenHash, createdAt, lastSeenAt, expiresAt}]}`. Token = 32 random bytes base64url, shown once, stored SHA-256-hashed. 30-day sliding expiry (lastSeenAt + 30d), refreshed on successful hello. `pairing.mint` → `{code, expiresAt}` (code = 8-char base32, 5-minute TTL, single-use, in-memory). `pairing.exchange {code, deviceName}` (the ONLY command a token-less projected connection may invoke) → `{deviceToken, deviceId}`. `pairing.listDevices` / `pairing.revokeDevice` (private contract). CLI: `rennet pair`, `rennet devices [--revoke <id>]`.

**D6 — Bind config: `globalConfigSchema` gains optional `daemon: {listen?: {host: string, port?: number}}`** (append-only). Daemon reads it at start; default unchanged (`127.0.0.1:0`). Host-header allowlist on the HTTP server for non-loopback binds: allow the configured host, its IP literals, and `localhost` — a mismatched Host gets 403 before upgrade (DNS-rebinding guard; request-level, not a user gate). `daemon.json` records the bound host+port; `rennet status` prints it.

**D7 — Server-request frames (wire only):** `serverRequest {serverRequestId, kind, payload}` (server→client), `serverResponse {serverRequestId, payload}` (client→server), `serverRequestResolved {serverRequestId}` (server→client cleanup so no client shows a stale prompt — codex's `serverRequest/resolved` shape). Gated on `serverInfo.features.serverRequests: true`. Listener exposes `askConnection(connectionId, kind, payload) → Promise<payload>` with turn-end/disconnect rejection + resolved broadcast. Bridge exposes `onServerRequest(handler)`. Round-trip + cleanup pinned by tests. No product consumer this phase (proposal §4 rationale).

**D8 — QR: encode with a tiny zero-dependency QR encoder if one passes the Dependency Standard test (removes a real subsystem — QR matrix encoding — for a UI the phone story needs); render as SVG in the settings panel. If no candidate is clean, ship text-code-only this phase and let the mobile phase force the pick.** Implementer states the call in the PR. The pairing UX works with a typed code regardless.

**D9 — Client bridge grows: capture serverInfo (version + features), send deviceToken from constructor options, `onServerRequest` seam.** The bridge stays browser-safe; token persistence is the embedding client's concern (constructor input), not the bridge's.

**D10 — Remote e2e is a node-level contract test in `packages/server`** (vitest, no Playwright): start a daemon-configured listener on a non-loopback-capable bind (`0.0.0.0` or the machine's LAN address; skip-with-message if the environment forbids), mint + exchange, drive `review.capture` → canvases → dispositions over the projected connection against a fixture repo, sweep every serialized frame for `os.homedir()` and the fixture repo's absolute root. **Positive control:** a test-only injected leak (an absolute path smuggled into a response) must make the sweep fail — proving the sweep can go red.

## Risks / Trade-offs

- **Risk: the scrub table rots as commands are added.** Mitigation: the drift test regenerates the public schema from the live private contract — a new command with a host-path field that lacks a projection entry fails the generator (unknown-path-field check against a maintained allowlist of path-typed fields; loud, not silent).
- **Risk: reverse-resolution ambiguity** (two projects, same basename). repoKey is exact; only displayName is ambiguous, and displayName is never accepted inbound — only repoKey.
- **Trade-off: model prose can still name paths.** Stated in docs (R31 honesty); structural + known-root scrubbing is the contract, prose sanitization is not promised.
- **Trade-off: hashed tokens mean no token recovery** — re-pair instead. Correct for a personal product.
