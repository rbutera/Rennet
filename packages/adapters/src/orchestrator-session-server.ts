import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  bootOrchestratorSession,
  type CanvasOpsBackend,
  type OrchestratorSession,
  type OrchestratorSessionConfig,
} from "@rennet/core";
import { createCanvasOpsServer, type LoadCanvasOpsSdk } from "./canvas-ops-server";

// ─────────────────────────────────────────────────────────────────────────────
// Attach an orchestrator session to the live canvasOps@2 surface (issue #13).
//
// The core session is harness-agnostic and node-free — it holds the primer, the
// context-update stream, and the tool INDEX (names). This adapter turns that
// attachable surface into a LIVE in-process MCP server for the Claude slot via
// #12's `createCanvasOpsServer(backend)`, so the descriptors the session's tool
// index names are exactly the ones the model can call. The SDK is lazily loaded
// (injectable for tests); building the server config spawns no model — a model is
// only ever spawned when `query()` runs with this server in `mcpServers`.
//
// Codex/omp slots reach the same descriptors as external MCP later; this is the
// Claude-slot wiring. One contract, no `if (harness === X)`.
// ─────────────────────────────────────────────────────────────────────────────

/** The booted session plus the in-process canvasOps@2 MCP server to hand to `query()`. */
export interface AttachedOrchestratorSession {
  session: OrchestratorSession;
  /** Drop into `query()`'s `mcpServers` — the live canvasOps@2 surface. */
  mcpServer: McpSdkServerConfigWithInstance;
}

/**
 * Boot the core orchestrator session AND construct the in-process canvasOps@2 MCP
 * server bound to `backend`. Returns both: the session for the conversation loop,
 * the server for `query()`'s `mcpServers`. `loadSdk` is injectable so a hermetic
 * test builds the server without the real SDK.
 */
export async function attachOrchestratorSession(
  backend: CanvasOpsBackend,
  config: OrchestratorSessionConfig,
  loadSdk?: LoadCanvasOpsSdk,
): Promise<AttachedOrchestratorSession> {
  const session = bootOrchestratorSession(config);
  const mcpServer = await createCanvasOpsServer(backend, loadSdk);
  return { session, mcpServer };
}
