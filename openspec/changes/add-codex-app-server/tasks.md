# Tasks — add-codex-app-server

Red-first throughout: each group starts with failing tests against fake transports; no real codex spend enters the default gate. Wrap `git`/`pnpm`/`nx` in `sh -c '...'`.

## 1. Conformance suite (core)

- [x] 1.1 RED: `packages/core/src/harness-conformance.test.ts` — suite over a fake `HarnessPort` maps each check to exactly one `CapabilityName`; a skipped check leaves the flag false; output feeds `buildCapabilities` and the descriptor's true flags equal the passing set exactly.
- [x] 1.2 RED: positive control — the `structuredOutput` check against a deliberately-broken fake transport fails, and a suite run that cannot demonstrate the control failing refuses to certify.
- [x] 1.3 GREEN: implement `packages/core/src/harness-conformance.ts` — pure over `HarnessPort`, no Node at module scope; checks for `structuredOutput`, `interrupt`, `textDeltas`, `reportsContextWindow`, `costUsd`; layer attribution (fake runs cap at `implementedByAdapter`); export from core index.
- [x] 1.4 testedRange artifact: `packages/adapters/src/harness-tested-range.json` seeded with claude `{min: 2.0.0, maxTested: 2.1.220}`; descriptor reader; delete `CLAUDE_TESTED_RANGE` and migrate `ClaudeAdapter` + its tests onto the artifact. Test: descriptor range equals artifact, no other source.

## 2. Codex adapter (adapters)

- [x] 2.1 RED: `packages/adapters/src/codex-adapter.test.ts` against fake `CodexTurnTransport` frames — completed turn with structured output + usage and strictly increasing `seq`; unmodelled frame → `passthrough` with raw native; exec/MCP/write items classified by `ToolKind`; nonzero exit → `failed` outcome with class+origin; abort → subprocess kill + `cancelled`; transport not invoked before a turn.
- [x] 2.2 GREEN: `packages/adapters/src/codex-adapter.ts` — `CodexAdapter implements HarnessPort`, injected `CodexTurnTransport`, tolerant decoders, `mapCodexError`, evidence-derived descriptor (no evidence → all false).
- [x] 2.3 Composition-root transport: pure `buildCodexTurnArgs` (asserted without spawning: `--json`, `--ignore-user-config`, `-C <cwd>` with NO `--skip-git-repo-check`, full-access flag, no approval/gating/read-only flag, `--output-schema`/`-o` when schema present, `-c mcp_servers.*.url` rendering) + the real spawn via `discoverCodex` path, `stdin: "ignore"`, host locus only (`// #334 seam` noted at the spawn site). Reuse `codex-exec.ts` helpers where they fit; do not fork the schema-nullability logic.
- [x] 2.4 Credential tripwire: test proving no read of `~/.codex/auth.json` (or any credential path) across construction + a fake turn, with the check itself proven able to fire (claude-harness-adapter precedent).

## 3. canvasOps@2 external transport

- [x] 3.1 Declare `@modelcontextprotocol/sdk` as a direct pinned dependency of `@rennet/adapters` (repairs the existing phantom import in `canvas-ops-server.ts`); licence gate stays green.
- [x] 3.2 RED: `canvas-ops-external.test.ts` — an in-test MCP client over loopback streamable HTTP lists the identical tool names/schemas as the in-process server and round-trips describe(counts)→describe(cohorts)→read against a fixture backend.
- [x] 3.3 GREEN: `packages/adapters/src/canvas-ops-external.ts` — same `CANVAS_OPS_TOOLS` compilation, `McpServer` + `StreamableHTTPServerTransport` on `127.0.0.1:<ephemeral>`, close semantics tied to the session; codex-slot sibling of `orchestrator-session-server.ts` returning the URL.

## 4. Gated real runs (not in `pnpm check`)

- [ ] 4.1 `harness-conformance.real.test.ts` (env-var gated, `codex-utility-port.real.test.ts` pattern): suite vs the installed `codex`; passing checks earn `advertisedByHarness`/`availableInSession`; run records/extends the codex entry in `harness-tested-range.json` (seeded from this first run).
- [ ] 4.2 Gated real orchestrator round-trip: codex picked, session configured with the loopback canvasOps URL, describe→read round-trips against the live backend.

## 5. Docs + gate (same change, definition of done)

- [ ] 5.1 `docs/src/content/docs/developing/reference/delivery-order.md` — wave-10 entry: #25 scope as built (exec transport, app-server seam named and deferred, struck approval scope honored), #41 next.
- [ ] 5.2 Developing-Rennet harness page: two-adapter architecture, `CodexTurnTransport` seam, derived capabilities + conformance, testedRange mechanism, honest egress line (user's own codex binary/subscription; canvasOps listener loopback-only, no Rennet backend).
- [ ] 5.3 Full gate: `sh -c 'pnpm check'` green, including the conformance positive control and the licence-gate control.
