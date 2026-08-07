## Why

Issue #10 shipped the canvas state model, the actor-partitioned command vocabularies, and the L3 canvas-op event fold — the data the orchestrator would reason about, and the structural guarantee that no orchestrator op writes L2. What is still missing is the surface the orchestrator actually holds: `canvasOps@2`, the one versioned in-process MCP tool surface that is the orchestrator's entire world (Orchestrator Context Access §2). Without it the orchestrator has a canvas but no way to describe it, zoom into it, mark it up, propose to it, or retrieve the code and analysis behind it.

The design principle is Rai's product thesis pointed inward: the tool surface IS zoom for the orchestrator. `canvas.describe` at count → cohort → element depth, then `canvas.read` of one element's body, is the same roll-up-then-zoom ladder the user gets, machine-facing. Retrieval is addressable access to the durable state rather than a copy of it, so staleness comes for free (R30 at the reply) and the never-cap doctrine (correction 4) applies to the machine reader too.

## What Changes

- Add the pure `canvasOps@2` tool surface to `packages/core` (`canvas-ops.ts`): the uniform envelope `{data, evidence?, freshness, total?, cursor?, truncated?}`; a `CanvasOpsBackend` data-access port the host implements; and thirteen tool descriptors with pure handlers over that port — the six interaction ops (`canvas.describe` paginated with totality; `canvas.view`; `canvas.focus` presentational; `canvas.annotate` L3 ephemeral; `canvas.propose` bulk-capable L3, accepting is a user act; `canvas.recompute` RoutePlan-budget-gated) and the seven read-only retrieval tools (`canvas.read`, `canvas.thread`, `diff.read`, `diff.search`, `diff.structure`, `run.ledger`, `run.provenance`). Every reply carries a freshness verdict; a `stale` verdict rides on the answer itself; "nothing found" is a distinguished value (`total: 0` with the searched scope named), never an empty-looking success. The write ops route through issue #10's `dispatchOrchestratorCanvasOp`, so their effects are structurally L3-only.
- Add the SDK wiring to `packages/adapters` (`canvas-ops-server.ts`): `createCanvasOpsServer(backend)` builds an in-process MCP server via `@anthropic-ai/claude-agent-sdk`'s `createSdkMcpServer` + `tool()`, compiling each descriptor's neutral param spec into a Zod input schema, tagging read-only tools `readOnlyHint`, and marking the hot trio (`canvas.describe`, `canvas.view`) `alwaysLoad` so the core loop pays no tool-search round-trip. Codex/omp reach the same descriptors as external MCP later — one contract, no `if (harness === X)`. The SDK handler serializes the core envelope and applies the pure effects through the backend.

## Capabilities

### New Capabilities

- `canvasops-mcp-surface`: the versioned `canvasOps@2` interaction + retrieval tool surface, its uniform envelope with pagination-with-totality and reply-level freshness, the `CanvasOpsBackend` port, the structural actor partition (no user-only or engine-only op exists on the surface, and no handler can produce an L2 write), and the in-process SDK MCP server that exposes it to the Claude orchestrator slot.

## Impact

- Adds `packages/core/src/canvas-ops.ts` (re-exported from `core/index.ts`, colocated-tested) and `packages/adapters/src/canvas-ops-server.ts` (re-exported from `adapters/index.ts`, colocated-tested). No new package; no new external dependency (the SDK and Zod are already deps of `packages/adapters`); no dependency-arrow change — the architecture and licenses gates are untouched.
- L2 stays user-sovereign by construction: the surface contains no disposition-writer, `canvas.propose` raises an L3 proposal, and a proposal becomes L2 only when the user adjudicates it (a user command, off this surface).
- Deferred to follow-ups: the `context.*` bucket (`context.map`/`file`/`knowledge`/`ask` — the base-branch context issue); the async `context.ask` ticket path; the empirical primer/ask experiments (§6); richer per-element bodies as #26 lands them.
