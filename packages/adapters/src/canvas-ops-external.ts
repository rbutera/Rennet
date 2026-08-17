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
  HOST_LOCUS,
  type Locus,
  locusCommand,
  type OrchestratorSession,
  type OrchestratorSessionConfig,
} from "@rennet/core";
import { execa } from "execa";
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

export interface CanvasOpsExternalServerOptions {
  /** Test seam; production always binds an ephemeral port. */
  readonly port?: number;
  /**
   * The executing codex's locus (#334). A host locus binds the shipped 127.0.0.1
   * loopback. A WSL locus must hand the distro an address it can actually reach:
   * shared localhost under mirrored networking, else the WSL-facing host address
   * (the distro's default-route gateway), with the listener bound no wider than
   * that route. When neither route can be established the start FAILS (the turn
   * settles failed) — never a 0.0.0.0 bind, never a silent host fallback.
   */
  readonly locus?: Locus;
  /** Injectable distro-reachability probes; defaults to real in-distro commands. */
  readonly reachability?: CanvasOpsReachability;
}

/** The empirical distro→host reachability probes (design §Decisions.3). */
export interface CanvasOpsReachability {
  /** True when the distro can open a TCP connection to `addr:port`. */
  probeReachable(addr: string, port: number): Promise<boolean>;
  /** The distro's default-route gateway (the WSL-facing host address), or null. */
  discoverGateway(): Promise<string | null>;
}

/**
 * Real reachability probes, executed inside the distro through `locusCommand`
 * (verbatim argv, no shell interpretation of user data — the addresses/ports are
 * our own values). The TCP probe uses bash's `/dev/tcp` so no `curl`/`nc` need be
 * installed; a clean connect (exit 0) proves the listener is reachable.
 */
export function defaultWslReachability(distro: string): CanvasOpsReachability {
  const locus: Locus = { kind: "wsl", distro };
  return {
    async probeReachable(addr, port) {
      const { file, args } = locusCommand(locus, "bash", [
        "-c",
        `exec 3<>/dev/tcp/${addr}/${port}`,
      ]);
      try {
        const result = await execa(file, [...args], {
          reject: false,
          stdin: "ignore",
          timeout: 3_000,
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    async discoverGateway() {
      const { file, args } = locusCommand(locus, "ip", ["-4", "route", "show", "default"]);
      try {
        const result = await execa(file, [...args], {
          reject: false,
          stdin: "ignore",
          timeout: 3_000,
        });
        if (result.exitCode !== 0) return null;
        return result.stdout.match(/default via (\S+)/)?.[1] ?? null;
      } catch {
        return null;
      }
    },
  };
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
  options: CanvasOpsExternalServerOptions = {},
): Promise<CanvasOpsExternalServer> {
  const mcp = buildExternalMcpServer(backend);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const makeHttp = (): Server =>
    createServer((req, res) => {
      if (!req.url?.startsWith(MCP_PATH)) {
        res.writeHead(404).end();
        return;
      }
      transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

  const listenOn = (http: Server, port: number, address: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        http.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        http.off("listening", onListening);
        reject(error);
      };
      http.once("listening", onListening);
      http.once("error", onError);
      http.listen(port, address);
    });

  const closeHttp = (http: Server): Promise<void> =>
    http.listening
      ? new Promise<void>((resolve) => http.close(() => resolve()))
      : Promise.resolve();

  const closeShared = async (errors: unknown[]): Promise<void> => {
    await transport.close().catch((error) => errors.push(error));
    await mcp.close().catch((error) => errors.push(error));
  };

  // Resolve the bind address + reachable URL. Host: the shipped 127.0.0.1 loopback.
  // WSL: probe shared-localhost first, then the discovered gateway; bind the listener
  // to exactly the address that passed, never wider. No route ⇒ throw (turn fails).
  const locus = options.locus ?? HOST_LOCUS;
  let http: Server;
  let url: string;
  if (locus.kind === "wsl") {
    const reach = options.reachability ?? defaultWslReachability(locus.distro);
    const candidates = ["127.0.0.1"];
    const gateway = await reach.discoverGateway();
    if (gateway && gateway !== "127.0.0.1") candidates.push(gateway);
    let chosen: { readonly http: Server; readonly url: string } | null = null;
    const tried: string[] = [];
    for (const address of candidates) {
      const candidate = makeHttp();
      let port: number;
      try {
        await listenOn(candidate, 0, address);
        port = (candidate.address() as AddressInfo).port;
      } catch {
        await closeHttp(candidate);
        tried.push(`${address} (bind failed)`);
        continue;
      }
      if (await reach.probeReachable(address, port)) {
        chosen = { http: candidate, url: `http://${address}:${port}${MCP_PATH}` };
        break;
      }
      await closeHttp(candidate);
      tried.push(`${address}:${port}`);
    }
    if (!chosen) {
      const errors: unknown[] = [];
      await closeShared(errors);
      throw new Error(
        `canvasOps loopback surface is unreachable from the "${locus.distro}" WSL distro ` +
          `(no distro-to-host route; tried ${tried.join(", ") || "no candidates"}). ` +
          `The codex turn cannot use canvas operations.`,
      );
    }
    http = chosen.http;
    url = chosen.url;
  } else {
    http = makeHttp();
    try {
      await listenOn(http, options.port ?? 0, "127.0.0.1");
    } catch (error) {
      await closeHttp(http);
      await closeShared([]);
      throw error; // preserve the raw listen error (e.g. EADDRINUSE) for callers
    }
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}${MCP_PATH}`;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    await closeShared(errors);
    await closeHttp(http).catch((error) => errors.push(error));
    if (errors.length > 0) throw new AggregateError(errors, "failed to close canvasOps server");
  };

  return { url, close };
}

// ── Codex-slot sibling of orchestrator-session-server.ts ─────────────────────

/** The booted session plus the loopback canvasOps@2 URL to hand to a codex session. */
export interface AttachedCodexOrchestratorSession {
  session: OrchestratorSession;
  /** Loopback canvasOps@2 URL (feeds `-c mcp_servers.canvasops.url=<url>`); null when
   *  no distro-reachable route to the canvas surface could be established (#334). */
  readonly url: string | null;
  /** Present when `url` is null: the plain reason the canvas surface is unreachable. */
  readonly unreachableReason?: string;
  /** The single lifecycle owner for the session's listener and MCP transport. */
  close(): Promise<void>;
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
  serverOptions: CanvasOpsExternalServerOptions = {},
): Promise<AttachedCodexOrchestratorSession> {
  const session = bootOrchestratorSession(config);
  try {
    const external = await startCanvasOpsExternalServer(backend, serverOptions);
    return { session, url: external.url, close: external.close };
  } catch (error) {
    // A WSL locus with no distro-to-host route: hand back the session with a null
    // URL and the plain reason, so the caller settles the turn FAILED rather than
    // silently running host-side against a WSL repo (spec: no silent substitute).
    return {
      session,
      url: null,
      unreachableReason: error instanceof Error ? error.message : String(error),
      close: async () => undefined,
    };
  }
}
