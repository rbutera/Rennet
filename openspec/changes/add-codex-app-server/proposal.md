## Why

Issue #25 (wave 10 head, deferred tier: #25 → #41 → #26) asks for the second harness slot — the proof the whole surface is harness-agnostic — and the generalised conformance suite the issue itself names as its core ask. Today Codex drives Rennet only as a **non-agentic structured-completion seat**: `CodexUtilityPort` + `createCodexRunTurn` (light-tier council seats, dual-seat second opinions) shell `codex exec` in a scratch cwd with no tools. Every **agentic** consumer of `HarnessPort` — `createHarnessRunTurn`, finding verification, knowledge enrichment, context.ask, CI refinement — has exactly one implementation: `ClaudeAdapter`. #41 (cross-harness adjudication) depends on "a second real adapter" generating findings in fresh independent sessions; that is this change.

**Transport verdict (the one deliberate divergence from the issue's letter):** the adapter speaks `codex exec --json`, not the `codex app-server` JSON-RPC protocol, behind an injected transport seam where an app-server transport can later slot in. Evidence:

- The installed `codex` 0.146.0 labels `app-server` **[experimental]** and its shape has already drifted from the issue's description (`--stdio` → a daemon/proxy model with `generate-ts --experimental` bindings). The issue itself says to treat it as a volatile vendor protocol and implement only the consumed subset — and the consumed subset today is *one turn per session*: `harness-run-turn.ts` documents "slice-1 adapters are single-turn", and every live consumer creates a session, sends one prompt, drains events, closes.
- The Rule Zero amendment struck the approval apparatus (the eleven fail-closed server-initiated requests, approval binding, invalidation-on-interrupt) — which was the main machinery that *required* the app-server protocol. `codex exec` has no approvals at all: it is non-interactive and runs at exactly the capable-by-default posture Rule Zero demands.
- `codex exec` covers everything the acceptance criteria still need: agentic tool use in the repo cwd, `--output-schema` structured output, `--json` streamed events, streamable-HTTP MCP servers via config (`canvasOps@2` round-trip), and interrupt by killing the subprocess.

Building a JSON-RPC client for an experimental protocol to serve capabilities nothing consumes is robustness for robustness' sake. The change name keeps the issue's `add-codex-app-server` slug; the design records the seam where that transport lands when steering or thread-resume is actually consumed.

## What Changes

- **`CodexAdapter implements HarnessPort`** in `@rennet/adapters` — the second harness slot, peer of `ClaudeAdapter`. Injected transport seam (mirroring `ClaudeQueryFn`): the composition root spawns the discovered `codex` binary (`discoverCodex`) with `codex exec --json` in the session's cwd, full capability, no approval plumbing, no read-only posture. JSONL frames normalize into the existing `HarnessEvent` protocol (monotonic `seq`, raw native frame retained, `passthrough` for anything unmodelled); errors map into the class+origin taxonomy; `AbortSignal`/`interrupt()` kills the subprocess. Never reads a credential (Codex `auth.json` included). Host locus only; WSL codex is #334's seam.
- **Generalised conformance suite** (`@rennet/core`, pure over `HarnessPort`): one suite run against every adapter; each passing check flips exactly one capability layer from `false` via the existing `buildCapabilities` evidence mechanism — flags are exactly the passing set, never declared. A positive control proves the suite can fail (a deliberately broken transport must yield a `false` flag). The default gate runs it hermetically against fake transports (zero spend); a gated `.real.test.ts` runs it against the real binaries.
- **`testedRange` derived, never hand-edited** (backlog bead 63): real conformance runs record the binary versions they passed against into a committed per-harness artifact; adapter descriptors read `testedRange` from that artifact. `ClaudeAdapter`'s hand-written `CLAUDE_TESTED_RANGE` migrates onto the same mechanism.
- **canvasOps@2 as external MCP**: the same neutral `CANVAS_OPS_TOOLS` descriptors served over a loopback streamable-HTTP transport (in the desktop process, next to the live backend), so a codex session reaches the identical contract via `-c mcp_servers.canvasops.url=…` — no `if (harness === X)` anywhere. The orchestrator slot with codex picked round-trips describe→read (hermetic via an MCP client in the gate; proven live in the gated real test). This also fixes an existing phantom dependency: `canvas-ops-server.ts` already imports `@modelcontextprotocol/sdk/types.js` without declaring it.
- **Docs in the same change**: delivery-order wave-10 entry; a Developing-Rennet page for the codex adapter + conformance suite.
- **Struck scope honored (Rule Zero amendment, 2026-08-11)**: no consent/approval apparatus, no fail-closed request handling, no capability withholding. Not built, not tested for.

## Capabilities

### New Capabilities
- `codex-harness-adapter`: the `HarnessPort` codex adapter — injected exec transport, capable-by-default sessions, event normalization with passthrough, error taxonomy mapping, interrupt-by-kill, no credential reads, evidence-derived descriptor.
- `harness-conformance`: the cross-adapter conformance suite — one suite over any `HarnessPort`, derived capability flags, positive control, hermetic-by-default with gated real runs, recorded `testedRange`.

### Modified Capabilities
- `canvasops-mcp-surface`: the "other slots reach the same descriptors as external MCP later" clause becomes real — the surface SHALL also be reachable as an external streamable-HTTP MCP server on loopback, same descriptors, no harness branching.

## Impact

- **`packages/adapters/src/codex-adapter.ts`** (new) + its transport in **`codex-exec.ts`** territory — reuses the proven spawn discipline (stdin ignored, `--ignore-user-config`, `-o` last-message capture) with the agentic flags added; `harness-discovery.ts:discoverCodex` supplies the binary.
- **`packages/core/src/harness-conformance.ts`** (new) — pure over `HarnessPort` + `buildCapabilities`; no Node at module scope.
- **`packages/adapters/src/canvas-ops-server.ts`** + a new external-transport module — same compiled tools, second transport; `@modelcontextprotocol/sdk` becomes a declared direct dependency of `@rennet/adapters` (already in-tree transitively via the agent SDK; MIT).
- **`packages/adapters/src/claude-adapter.ts`** — `CLAUDE_TESTED_RANGE` migrates to the recorded-artifact mechanism (no behavior change otherwise).
- **`docs/src/content/docs/developing/reference/delivery-order.md`** and a new developing/concepts or reference page.
- No new harness binary bundled; no credential read; no per-token spend in the default gate.
