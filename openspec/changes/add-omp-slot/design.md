# Design — the omp adapter slot

## Context, and the one constraint that shapes everything

The Wingman Harness Adapter Protocol §2.3 opens with: *"The whole of this section is design-from-generic-shape. No turn was executed against either binary… the mapping table is deliberately not written, because writing it would mean inventing it."* No model turn has run yet. The implementation is based on npm metadata, `--help`, installed types, and installed 17.1.3 source: `--mode text|json|rpc|rpc-ui`, LF-delimited JSON RPC, prompt/abort response discriminators, project/extension `mcp.json` discovery, `--no-session`, and `engines.bun >= 1.3.14`. Stats exist in omp's protocol but remain deliberately unimplemented until the real transport owns their request lifecycle.

Verified live on this machine during authoring (2026-08-17): `omp` 17.1.3 at `~/.bun/bin/omp`, Bun 1.3.14, `--mode=rpc` present in `--help`. The binary exists and answers; its wire bytes remain unobserved.

The design answer to "how do you spec an adapter for a protocol you haven't watched": the same way #25 did, plus one honesty rule. The adapter is pure over an injected transport; hermetic fakes model only the *documented* shapes; and the conformance architecture makes a wrong guess self-limiting — if the real `omp --mode rpc` frames differ from the documented `.d.ts` shapes, the gated real run fails, no evidence beyond `implementedByAdapter` ever exists, and `testedRange` stays absent. The hermetic suite currently earns only `interrupt` and `textDeltas` at `implementedByAdapter`; every outer layer stays false. The system cannot overclaim by construction.

## Decision 1 — transport: `--mode rpc` NDJSON, not `omp acp`

The issue offers both. Pick RPC:

- It is the direct mirror of the twice-proven pattern: `ClaudeQueryFn` and `CodexTurnTransport` are both "spawn, stream line-delimited JSON, append one synthetic terminal frame". A third instance of the same seam (`OmpTurnTransport = (spec) => AsyncIterable<unknown>`) is the cheapest correct shape, and the adapter file stays process-free and fully hermetic.
- ACP's distinguishing machinery is `session/request_permission` — a write-gating protocol. Rennet builds no approval apparatus (Rule Zero); adopting a transport whose center of gravity is permission requests buys complexity we would immediately refuse to use.
- RPC is the `pi`-compatible surface. R23 names `pi` a compatible subset; ACP and MCP are omp-only. Keeping the wire mapping inside the shared subset means a `pi` binary could ride the same normalization later with zero rework (a design property, not a shipped slot).

The seam is where richer transports land if ever consumed — identical to the Codex verdict deferring app-server.

## Decision 2 — single-turn, fresh, ephemeral

Every live `HarnessPort` consumer is single-turn (create → send → drain → close). The composition root passes omp's ephemeral no-session flag so nothing accumulates in `~/.pi`-style session dirs, and `resume`/`fork`/`steer` stay unexercised — their conformance checks simply fail, which is the honest flag state. Exact CLI flags are pinned by the implementation against the installed binary's `--help` (red-first), not frozen in this spec; the behavioral contract is "non-interactive, full-capability, ephemeral, one turn".

## Decision 3 — Bun-aware health lives in discovery, not the adapter

omp's bin is a TypeScript entry point executed by Bun; without Bun the spawn fails with a confusing exec error. `discoverOmp` resolves Bun first, enforces `>=1.3.14`, and executes `omp --version` through that exact runtime rather than trusting the script's `#!/usr/bin/env bun` lookup. The proven Bun path is carried into the transport and launches the real turn too. Omp candidate ranking demotes the asdf shim behind a real install, and Windows matching consumes the locus's actual `PATHEXT`. Outcome mapping:

| omp | bun | health |
|---|---|---|
| found, probes through exact Bun | found at `>=1.3.14` | `ready` (version from omp) |
| found | missing, broken, or below floor | `unavailable`, reason names Bun, **resolved omp path still reported** |
| missing | — | `unavailable`, `not-found` |

The "found omp but not Bun" distinction is the same product move as the existing "found your Claude config but not the binary": the app tells the user the one true missing thing. This generalizes as a small delta on the promoted `harness-discovery` spec (runtime-dependent harness), not as omp-private logic, because it is a discovery property any future runtime-hosted harness shares.

## Decision 4 — conformance: consume, don't extend

`runConformance` is already pure over `HarnessPort` with per-check refuting controls; `harness-tested-range.json` is already keyed by `HarnessId`; `buildCapabilities` already makes absence-of-evidence indistinguishable from failure. The omp slot adds one documented-shape fake transport for the hermetic run and one gated real test (`RENNET_LIVE_OMP=1`). The honest expected matrix is `interrupt` and `textDeltas` passing; `structuredOutput`, `costUsd`, and `reportsContextWindow` failing. Omp's RPC prompt has no output-schema field, so JSON parsing is not schema enforcement and cannot earn `structuredOutput`. The real transport closes stdin after the prompt and does not request `get_session_stats`, so usage and cost are absent instead of existing as a fake-only surface. A full real matrix match alone records a tested range; without one the descriptor omits the range and health reports `untested`.

Stats can be added when the transport owns the full `agent_end` → `get_session_stats` → response → close lifecycle. Until then there is no normalization or descriptor claim for usage or cost.

## Decision 5 — orchestrator wiring mirrors Codex exactly, selection stays minimal

`OrchestratorHarnessSelection` gains `{ harness: "omp", model?, resolvePort }` — structurally identical to the codex variant. `runOmpOrchestratorTurn` mirrors `runCodexOrchestratorTurn`: the port receives the loopback canvasOps@2 URL. Omp does not read MCP declarations from `--config`; composition writes the supported `{ mcpServers: { name: { type: "http", url } } }` JSON to `<turn scratch>/mcp.json` and passes the scratch directory through `--extension`. The exact placement, parsed shape, URL, and argv are hermetically proven. Because no live turn has run, MCP discovery and connection remain unearned outer-layer claims.

Selection policy — the deliberately lazy part: `resolveHarness` in `main/index.ts` serves the seat with omp **only when neither Claude nor Codex is installed**. Today that case returns `null` ("no model harness is available"); omp upgrades it to a working orchestrator. The council's `scenarioFor` and three assignment tables stay untouched (the promoted `model-council` spec stands; extending it to 2³ scenarios for a harness with unobserved wire bytes is speculative). A user-facing harness picker is a separate product question; the selection variant built here is the seam it would drive.

## Risks

- **The documented shapes are wrong.** Contained by construction (flags stay false, real test fails loudly); the correction loop is "observe real frames in the gated run, fix the fake and the decoders". No published claim depends on the guess.
- **omp versions move fast** (17.1.3 installed vs 17.2.8 researched). Same containment: without a full-match run the range is absent and health is `untested`; once recorded, `above-tested` applies normally.
- **Bun discovery false-negative** (asdf shims, `~/.bun/bin`): reuse the existing curated-location + execute-to-prove machinery rather than a bare PATH check — that machinery exists precisely because PATH lies.
