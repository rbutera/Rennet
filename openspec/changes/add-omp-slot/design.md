# Design — the omp adapter slot

## Context, and the one constraint that shapes everything

The Wingman Harness Adapter Protocol §2.3 opens with: *"The whole of this section is design-from-generic-shape. No turn was executed against either binary… the mapping table is deliberately not written, because writing it would mean inventing it."* That is still true. Everything verified about omp comes from npm metadata, `--help`, and installed `.d.ts` files: `--mode text|json|rpc|rpc-ui` with strict LF-only JSONL framing (`modes/rpc/jsonl.d.ts`), 34 RPC command types (`prompt`, `steer`, `abort`, `fork`, …), `SessionStats` carrying tokens *and* `cost: number`, MCP support in omp (calibrated 156 hits; `pi` has calibrated zero), `--no-session` ephemeral runs, and `engines.bun >= 1.3.14`.

Verified live on this machine during authoring (2026-08-17): `omp` 17.1.3 at `~/.bun/bin/omp`, Bun 1.3.14, `--mode=rpc` present in `--help`. The binary exists and answers; its wire bytes remain unobserved.

The design answer to "how do you spec an adapter for a protocol you haven't watched": the same way #25 did, plus one honesty rule. The adapter is pure over an injected transport; hermetic fakes model only the *documented* shapes; and the conformance architecture makes a wrong guess self-limiting — if the real `omp --mode rpc` frames differ from the documented `.d.ts` shapes, the gated real run fails, no evidence beyond `implementedByAdapter` ever exists, `testedRange` stays absent, and every descriptor flag stays `false`. The system cannot overclaim by construction. Red-first implementation then corrects the fakes against observed bytes as part of the real-run task, not by editing history.

## Decision 1 — transport: `--mode rpc` NDJSON, not `omp acp`

The issue offers both. Pick RPC:

- It is the direct mirror of the twice-proven pattern: `ClaudeQueryFn` and `CodexTurnTransport` are both "spawn, stream line-delimited JSON, append one synthetic terminal frame". A third instance of the same seam (`OmpTurnTransport = (spec) => AsyncIterable<unknown>`) is the cheapest correct shape, and the adapter file stays process-free and fully hermetic.
- ACP's distinguishing machinery is `session/request_permission` — a write-gating protocol. Rennet builds no approval apparatus (Rule Zero); adopting a transport whose center of gravity is permission requests buys complexity we would immediately refuse to use.
- RPC is the `pi`-compatible surface. R23 names `pi` a compatible subset; ACP and MCP are omp-only. Keeping the wire mapping inside the shared subset means a `pi` binary could ride the same normalization later with zero rework (a design property, not a shipped slot).

The seam is where richer transports land if ever consumed — identical to the Codex verdict deferring app-server.

## Decision 2 — single-turn, fresh, ephemeral

Every live `HarnessPort` consumer is single-turn (create → send → drain → close). The composition root passes omp's ephemeral no-session flag so nothing accumulates in `~/.pi`-style session dirs, and `resume`/`fork`/`steer` stay unexercised — their conformance checks simply fail, which is the honest flag state. Exact CLI flags are pinned by the implementation against the installed binary's `--help` (red-first), not frozen in this spec; the behavioral contract is "non-interactive, full-capability, ephemeral, one turn".

## Decision 3 — Bun-aware health lives in discovery, not the adapter

omp's bin is a TypeScript entry point executed by Bun; without Bun the spawn fails with a confusing exec error. `discoverOmp` follows `discoverCodex`'s structure (explicit `RENNET_OMP_BIN` override → harvested PATH ∪ curated dirs, `~/.bun/bin` first, X_OK check, execute-to-prove `--version`) and additionally proves a runnable `bun`. Outcome mapping:

| omp | bun | health |
|---|---|---|
| found, probes | found, probes | `ready` (version from omp) |
| found | missing | `unavailable`, reason names Bun, **resolved omp path still reported** |
| missing | — | `unavailable`, `not-found` |

The "found omp but not Bun" distinction is the same product move as the existing "found your Claude config but not the binary": the app tells the user the one true missing thing. This generalizes as a small delta on the promoted `harness-discovery` spec (runtime-dependent harness), not as omp-private logic, because it is a discovery property any future runtime-hosted harness shares.

## Decision 4 — conformance: consume, don't extend

`runConformance` is already pure over `HarnessPort` with per-check refuting controls; `harness-tested-range.json` is already keyed by `HarnessId`; `buildCapabilities` already makes absence-of-evidence indistinguishable from failure. The omp slot adds: one omp-shaped fake transport (documented shapes only) for the hermetic run, and one gated real test (`RENNET_LIVE_OMP=1`, the `RENNET_LIVE_CODEX` precedent) that runs the suite against the installed binary, and on a full expected-matrix match records the tested range. Expected matrix at introduction: `structuredOutput`/`textDeltas`/`interrupt` plausible passes, everything else expected-fail — but the committed expectation is set by what the fake proves, and corrected by the first real run's observed truth before any range is recorded. No suite code changes. That is the whole point of #25's generalisation, and the evidence it worked.

`costUsd` note: `SessionStats.cost: number` suggests omp may be the second harness to pass `costUsd` — pending the real run confirming the unit. The fake does not model it as passing until then.

## Decision 5 — orchestrator wiring mirrors Codex exactly, selection stays minimal

`OrchestratorHarnessSelection` gains `{ harness: "omp", model?, resolvePort }` — structurally identical to the codex variant. `runOmpOrchestratorTurn` mirrors `runCodexOrchestratorTurn`: the port receives the loopback canvasOps@2 URL (`canvas-ops-external.ts` — already harness-agnostic external streamable-HTTP; zero changes there). omp has MCP (calibrated), so the same external-MCP contract holds; this is precisely the issue's "canvasOps@2 as external MCP, same contract".

Selection policy — the deliberately lazy part: `resolveHarness` in `main/index.ts` serves the seat with omp **only when neither Claude nor Codex is installed**. Today that case returns `null` ("no model harness is available"); omp upgrades it to a working orchestrator. The council's `scenarioFor` and three assignment tables stay untouched (the promoted `model-council` spec stands; extending it to 2³ scenarios for a harness with unobserved wire bytes is speculative). A user-facing harness picker is a separate product question; the selection variant built here is the seam it would drive.

## Risks

- **The documented shapes are wrong.** Contained by construction (flags stay false, real test fails loudly); the correction loop is "observe real frames in the gated run, fix the fake and the decoders". No published claim depends on the guess.
- **omp versions move fast** (17.1.3 installed vs 17.2.8 researched). Same containment: the tested-range artifact records exactly what a full-match run proved; `above-tested` degrades health, never lies.
- **Bun discovery false-negative** (asdf shims, `~/.bun/bin`): reuse the existing curated-location + execute-to-prove machinery rather than a bare PATH check — that machinery exists precisely because PATH lies.
