# The omp adapter slot — third harness

Closes the live remainder of [#26](https://github.com/rbutera/rennet/issues/26).

## Why

R23 ratified `omp` (`@oh-my-pi/pi-coding-agent`, bin `omp`, can1357/oh-my-pi, MIT — never the abandoned npm namesake `oh-my-pi`) as the third harness. Nothing of it exists in code today beyond the reserved union members (`HarnessId` and `OrchestratorHarness` both already carry `"omp"`; `scenarioFor` deliberately ignores it; no adapter, no discovery, no orchestrator wiring). What #344 changed is the cost: `CodexAdapter` proved the injected-transport adapter pattern a second time, the cross-adapter conformance suite (`runConformance` over any `HarnessPort`) makes capability flags earned rather than declared for *any* new slot, `harness-tested-range.json` is already keyed by `HarnessId`, and canvasOps@2 already reaches a non-Claude harness as an external loopback MCP transport with no `if (harness === X)` branching. The omp slot is now mostly one thin adapter plus discovery — the generalisation work is done and this change deliberately rides it rather than rebuilding any of it.

One honest constraint shapes the whole change: the Wingman Harness Adapter Protocol §2.3 mapping table was **deliberately never written** — no turn has ever been executed against `omp`, and every claim about its wire shapes comes from `--help` output and installed `.d.ts` files. This change does not pretend otherwise. The adapter is specced behaviorally over an injected transport (the proven `ClaudeQueryFn` / `CodexTurnTransport` seam), hermetic fakes model only the documented JSONL RPC shapes, and nothing above `implementedByAdapter` is claimed until a gated real run against the installed binary passes the conformance suite. A wrong guess about omp's wire bytes therefore cannot overclaim: the flags stay `false`.

## What Changes

- **`OmpAdapter implements HarnessPort`** in `@rennet/adapters`: the third slot, peer of `ClaudeAdapter` and `CodexAdapter`, written against an injected `OmpTurnTransport` seam. Transport verdict (argued in design): `omp --mode rpc` NDJSON — the direct mirror of the twice-proven JSONL pattern — not `omp acp` (ACP's distinguishing feature is `session/request_permission` write-gating, which is approval apparatus Rennet does not build; Rule Zero). The adapter restricts itself to the RPC subset `pi` shares (R23's "pi as a compatible subset"), so a future `pi` binary rides the same normalization; omp-only extras (MCP config, `rpc-ui`) live in the composition root's invocation, not the wire mapping.
- **Capable by default, single-turn, no approval plumbing**: the composed invocation selects omp's non-interactive full-capability mode, fresh ephemeral session per turn (the slice-1 single-turn contract every live `HarnessPort` consumer holds), no approval-request handling, no consent surface.
- **Discovery and Bun-aware health**: `discoverOmp` reuses the shared discovery machinery (login-shell PATH harvest + curated locations including `~/.bun/bin`, execute-to-prove, `RENNET_OMP_BIN` override). omp is Bun-first (`engines.bun >= 1.3.14`, TS entry point) — a discovered `omp` with no runnable `bun` reports health honestly (degraded/unavailable with a reason naming Bun) instead of crashing at first spawn. The issue's acceptance criterion.
- **Descriptor is evidence-derived**: every capability flag starts `false` and is built only from `buildCapabilities` over conformance evidence; `testedRange` reads `harness-tested-range.json`, which has **no omp entry until the first genuine full-match real run** (the Codex precedent, verbatim).
- **Conformance, hermetic by default**: the existing suite runs against an omp-shaped fake transport in the default gate (zero spawns, zero spend); a gated `.real` test (`RENNET_LIVE_OMP=1`) runs it against the installed binary, earns the outer evidence layers, and records the tested range. No suite changes — the whole point of #25's generalisation is that the third slot consumes it as-is.
- **The orchestrator slot works with omp picked**: `OrchestratorHarnessSelection` gains an omp variant mirroring the codex one (`resolvePort` receiving the loopback canvasOps@2 URL — the same external MCP transport, same contract, still no `if (harness === X)` in the canvasOps layer). The default resolution policy serves the seat with omp when it is the only installed harness (today that path returns `null` and no orchestrator exists at all); the council's Claude/Codex assignment tables are untouched (`scenarioFor` still ignores omp — the promoted `model-council` spec stands).

Deliberately cut (Rule Zero / YAGNI):

- No `pi` discovery or `pi` slot — compatibility is a wire-subset discipline in the adapter, not a fourth binary to find.
- No council table extension (three-scenario tables stay Claude/Codex; omp enters as an orchestrator selection, not a council seat).
- No steer/resume/fork consumers — the seam is where they land when something consumes them, exactly like codex's deferred app-server transport.
- No approval/ACP mode, no sandbox flags, no read-only posture.
- No harness-picker UI — the selection seam is composition-level; a picker is its own product question.

## Capabilities

### New Capabilities

- `omp-harness-adapter`: the omp adapter, its injected transport seam, capable-by-default invocation, Bun-aware discovery health, evidence-derived descriptor, and the omp-selected orchestrator path.

### Modified Capabilities

- `harness-discovery`: one added requirement — discovery of a runtime-dependent harness (omp needs Bun) reports the missing runtime as the health reason instead of failing at spawn time.

## Impact

- `packages/adapters`: new `omp-adapter.ts` (+tests), new `omp-turn-transport.ts` composition root (+tests), `discoverOmp` in `harness-discovery.ts` (+tests), gated `omp-conformance.real.test.ts`; `harness-tested-range.json` untouched until a real run.
- `packages/core`: no suite changes; `harness.ts` already carries `"omp"` in `HarnessId`. A conformance fake for the omp shape lives with the existing fakes in tests.
- `apps/desktop`: `OrchestratorHarnessSelection` omp variant in `main/orchestrator.ts`; `resolveHarness` in `main/index.ts` offers omp when it is the sole installed harness; `runOmpOrchestratorTurn` wiring mirroring the codex path (external loopback canvasOps@2).
- Docs (same change, definition of done): delivery-order wave-10 entry, `developing/concepts/harness-adapters.md` gains the omp slot.
- No new dependencies. Zero model spend in the default gate. Never bundles a binary, never reads a credential — `omp` authenticates itself on the user's own configuration.
