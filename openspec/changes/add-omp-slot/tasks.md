# Tasks: the omp adapter slot

Red-first throughout: each group starts with the failing test, then the code that turns it green. Wrap `git`/`gh`/`pnpm` in `sh -c '...'`; the default gate stays at zero model spend and zero process spawns for this slot. Target `@oh-my-pi/pi-coding-agent` (bin `omp`) only — ⛔ never the abandoned npm namesake `oh-my-pi`.

## 1. Discovery with Bun-aware health

- [ ] 1.1 RED: `harness-discovery.test.ts` — `discoverOmp`: resolves `~/.bun/bin/omp` from curated locations when the login-shell PATH omits it; honours a probing `RENNET_OMP_BIN` override and falls through a stale one; omp present + `bun` absent → health reason names Bun and the resolved omp path is still reported ("found omp but not Bun", never `not-found`); both present and probing → `ready` with the proven version; neither → `unavailable`/`not-found`.
- [ ] 1.2 Implement `discoverOmp` in `packages/adapters/src/harness-discovery.ts`, reusing the shared machinery (`loginShellPath` harvest ∪ env PATH ∪ curated dirs with `~/.bun/bin`, X_OK, execute-to-prove `--version`, asdf-shim demotion) plus the bun-runtime probe. Green.

## 2. The adapter over the injected transport (pure, hermetic)

- [ ] 2.1 RED: `omp-adapter.test.ts` — descriptor: with no evidence every layer of every capability is `false`, `testedRange` is honest-absent (no omp entry in `harness-tested-range.json`); constructing the adapter and reading the descriptor invokes no transport.
- [ ] 2.2 RED: turn round-trip — an injected transport yielding documented-shape frames (session start, streamed text, tool frames, terminal with usage) produces `session.started` → events → `session.ended` completed with final text and normalized usage, strictly increasing `seq`; an unmodelled frame surfaces as `passthrough` with the verbatim native frame; tool frames classify `ToolKind`.
- [ ] 2.3 RED: failure and cancellation — nonzero exit / unparseable terminal → `failed` outcome with a closed error `class` and `origin`, raw output preserved; an aborted `signal` → `cancelled`, and `interrupt()`/`close()` resolve only after transport completion; `events` is subscribe-once.
- [ ] 2.4 Implement `OmpAdapter implements HarnessPort` in `packages/adapters/src/omp-adapter.ts` against `OmpTurnSpec`/`OmpTurnTransport` (the `CodexTurnTransport` mirror: raw frames then one synthetic `{ rennet: "turn-result", exitCode, ... }` terminal frame), tolerant structural decoders over the RPC subset shared with `pi`. Green on 2.1–2.3.

## 3. The composition-root transport (spawn discipline)

- [ ] 3.1 RED: `omp-turn-transport.test.ts` — pure invocation assembly selects `--mode rpc`, the non-interactive full-capability mode, the ephemeral no-session flag, the session `cwd`, and the model when given; it contains no approval, sandbox, or read-only flag (assert against a denylist); MCP loopback config (canvasOps@2 URL) is rendered when the spec carries it. Pin exact flags against the installed binary's `--help` here, not from memory.
- [ ] 3.2 Implement `createOmpTurnTransport` in `packages/adapters/src/omp-turn-transport.ts` with injected effects (the `CodexTransportEffects` pattern): spawn the discovered `omp`, stream LF-delimited JSON frames, append the synthetic terminal frame, kill the process tree on abort. Never read a credential path (mirror the codex safety check and prove it can fire). Green.

## 4. Conformance: hermetic default, gated real, recorded range

- [ ] 4.1 RED: hermetic conformance test — `runConformance` over the omp adapter with an omp-shaped fake transport (documented shapes only; no `costUsd` pass until a real run confirms the unit) yields evidence capped at `implementedByAdapter`; the derived descriptor's `true` flags are exactly the passing set; the refuting controls all fire (suite refuses on a passing control — positive control capable of failing).
- [ ] 4.2 Green: wire the fake and expected matrix; assert the default gate spawns no process for this slot.
- [ ] 4.3 Add `omp-conformance.real.test.ts`, env-gated behind `RENNET_LIVE_OMP=1` (the `RENNET_LIVE_CODEX` precedent): discover the real binary, run the suite, and only on a full expected-matrix match call `recordTestedRange("omp", version)`. First observed divergence from the documented shapes fixes the fake and decoders against real bytes — the committed expectation follows observation, never the reverse. `harness-tested-range.json` stays without an omp entry until a genuine full-match run.

## 5. The orchestrator slot with omp picked

- [ ] 5.1 RED: `orchestrator.test.ts` — an omp selection (`{ harness: "omp", resolvePort }`) drives the turn through the injected port and passes the loopback canvasOps@2 URL (same external-MCP contract as codex, no harness conditional in the canvasOps layer); with neither claude nor codex installed and a healthy omp slot, `resolveHarness` returns the omp selection instead of `null`; with claude or codex present the existing council resolution is byte-identical to today.
- [ ] 5.2 Implement the `OrchestratorHarnessSelection` omp variant + `runOmpOrchestratorTurn` (mirror of `runCodexOrchestratorTurn`) in `apps/desktop/src/main/orchestrator.ts`, and the sole-installed-harness fallback in `main/index.ts`'s `resolveHarness`, memoizing `discoverOmp` like the other discoveries. Council tables and `scenarioFor` untouched. Green.

## 6. Docs and delivery (same change — definition of done)

- [ ] 6.1 Update `docs/src/content/docs/developing/concepts/harness-adapters.md`: the omp slot (R23 target and the namesake trap, the RPC transport verdict, Bun-aware health, evidence-derived flags, the pi-subset discipline).
- [ ] 6.2 Update `docs/src/content/docs/developing/reference/delivery-order.md`: mark the #26 wave-10 entry delivered with the honest account (what shipped; deliberate cuts — no pi slot, no council-table extension, no ACP, no picker UI; flags false until the first real run).
- [ ] 6.3 Full gate `sh -c 'pnpm check'` green with a positive control; confirm zero spend and zero omp spawns in the default gate; stage `openspec/` with `git add -f`.
- [ ] 6.4 PR closes #26; the closing note states the flag posture honestly (descriptor exists, all capability layers `false` pending the first gated real run) and where `RENNET_LIVE_OMP=1` earns them.
