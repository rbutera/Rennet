import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  bootOrchestratorSession,
  CANVAS_OPS_TOOLS,
  type CanvasOpsBackend,
  type OrchestratorSession,
  type OrchestratorSessionConfig,
} from "@rennet/core";
import {
  CANVAS_OPS_INSTRUCTIONS,
  CANVAS_OPS_SERVER_NAME,
  CANVAS_OPS_SERVER_VERSION,
  toSdkHandler,
  toZodShape,
} from "./canvas-ops-server";

// ─────────────────────────────────────────────────────────────────────────────
// canvasOps@2 — the EXTERNAL transport (issue #25, design §5)
//
// The Claude slot reaches canvasOps@2 as an in-process SDK MCP server. Every
// OTHER slot (codex, later omp) reaches the SAME descriptors through this second
// transport: a loopback streamable-HTTP MCP server served FROM the desktop
// process, so it shares the live in-memory backend state (a codex-spawned stdio
// server would be a child of codex with no channel back to that state).
//
// One contract, two transports, no `if (harness === X)`: both compile the same
// neutral `CANVAS_OPS_TOOLS` catalogue through the same `toZodShape` /
// `toSdkHandler` helpers. Honest egress note, not a gate: this is a 127.0.0.1
// listener on an ephemeral port, handed only to the local codex session — no
// Rennet backend, nothing exposed off-host.
// ─────────────────────────────────────────────────────────────────────────────

/** A running loopback canvasOps@2 MCP server. `url` drops into a codex session's
 *  `-c mcp_servers.canvasops.url=<url>` override. */
export interface CanvasOpsExternalServer {
  /** `http://127.0.0.1:<ephemeral>/mcp` — loopback only. */
  readonly url: string;
  /** Tear down the HTTP listener, the transport, and the MCP server. */
  close(): Promise<void>;
}

/** Build the canvasOps@2 `McpServer` bound to `backend` from the neutral catalogue. */
function buildExternalMcpServer(backend: CanvasOpsBackend): McpServer {
  const mcp = new McpServer(
    { name: CANVAS_OPS_SERVER_NAME, version: CANVAS_OPS_SERVER_VERSION },
    { instructions: CANVAS_OPS_INSTRUCTIONS },
  );
  for (const descriptor of CANVAS_OPS_TOOLS) {
    const handler = toSdkHandler(descriptor, backend);
    mcp.registerTool(
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: toZodShape(descriptor.params),
        annotations: { readOnlyHint: descriptor.readOnly },
      },
      (args: Record<string, unknown>): Promise<CallToolResult> => handler(args),
    );
  }
  return mcp;
}

const MCP_PATH = "/mcp";

/**
 * Start the loopback canvasOps@2 streamable-HTTP server bound to `backend`. Binds
 * `127.0.0.1` on an ephemeral port and routes `/mcp` to the MCP transport. The
 * returned `close()` is tied to the session's lifetime — call it when the codex
 * session ends so no listener outlives the review.
 */
export async function startCanvasOpsExternalServer(
  backend: CanvasOpsBackend,
): Promise<CanvasOpsExternalServer> {
  const mcp = buildExternalMcpServer(backend);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const http: Server = createServer((req, res) => {
    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404).end();
      return;
    }
    transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}${MCP_PATH}`;

  return {
    url,
    async close(): Promise<void> {
      await transport.close();
      await mcp.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

// ── Codex-slot sibling of orchestrator-session-server.ts ─────────────────────

/** The booted session plus the loopback canvasOps@2 URL to hand to a codex session. */
export interface AttachedCodexOrchestratorSession {
  session: OrchestratorSession;
  /** Loopback canvasOps@2 server; its URL feeds `-c mcp_servers.canvasops.url=<url>`. */
  external: CanvasOpsExternalServer;
}

/**
 * Boot the core orchestrator session AND start the external canvasOps@2 server
 * bound to `backend` — the codex-slot peer of `attachOrchestratorSession`. Same
 * core session, same descriptors; the fork is purely the transport (external URL
 * vs in-process SDK instance), which is where composition-root wiring belongs.
 */
export async function attachCodexOrchestratorSession(
  backend: CanvasOpsBackend,
  config: OrchestratorSessionConfig,
): Promise<AttachedCodexOrchestratorSession> {
  const session = bootOrchestratorSession(config);
  const external = await startCanvasOpsExternalServer(backend);
  return { session, external };
}
