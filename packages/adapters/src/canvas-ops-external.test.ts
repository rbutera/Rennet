import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CANVAS_OPS_TOOLS,
  type ElementDetail,
  type OpsEnvelope,
  type OrchestratorPrimerState,
} from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachCodexOrchestratorSession,
  type CanvasOpsExternalServer,
  type CanvasOpsReachability,
  startCanvasOpsExternalServer,
} from "./canvas-ops-external";
import { makeCanvasOpsTestBackend } from "./canvas-ops-test-backend";

let server: CanvasOpsExternalServer | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  clients.length = 0;
  if (server) await server.close();
  server = null;
});

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "rennet-conformance-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

function envelopeOf(result: unknown): OpsEnvelope {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as OpsEnvelope;
}

const primer: OrchestratorPrimerState = {
  identity: { reviewId: "rev_1", patchsetId: "ps_1", mode: "own-branch-handoff" },
  freshness: [],
  canvasState: [],
  runLedger: { fleetTasks: 0, admitted: 0, rejected: 0 },
};

describe("canvasOps@2 external streamable-HTTP transport", () => {
  it("serves a loopback URL and lists the identical tool catalogue", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    server = await startCanvasOpsExternalServer(backend);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const client = await connect(server.url);
    const listed = await client.listTools();
    const listedNames = listed.tools.map((t) => t.name).sort();
    const catalogueNames = CANVAS_OPS_TOOLS.map((t) => t.name).sort();
    expect(listedNames).toEqual(catalogueNames);

    // Each tool's input schema carries the SAME property names as its descriptor's
    // params — proof both transports compile from the one CANVAS_OPS_TOOLS catalogue.
    for (const descriptor of CANVAS_OPS_TOOLS) {
      const tool = listed.tools.find((t) => t.name === descriptor.name);
      const props = Object.keys(
        (tool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
      ).sort();
      const paramNames = descriptor.params.map((p) => p.name).sort();
      expect(props, `${descriptor.name} params`).toEqual(paramNames);
    }
  });

  it("round-trips describe(counts) → describe(cohorts) → read against the live backend", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    server = await startCanvasOpsExternalServer(backend);
    const client = await connect(server.url);

    const counts = envelopeOf(
      await client.callTool({ name: "canvas.describe", arguments: { depth: "counts" } }),
    );
    expect((counts.data as { elements: number }).elements).toBe(3);
    expect(counts.freshness).toBe("current");

    const cohorts = envelopeOf(
      await client.callTool({ name: "canvas.describe", arguments: { depth: "cohorts" } }),
    );
    expect(cohorts.total).toBe(2);

    const elements = envelopeOf(
      await client.callTool({ name: "canvas.describe", arguments: { depth: "elements" } }),
    );
    const firstKey = (elements.data as Array<{ elementKey: string }>)[0]?.elementKey ?? "";

    const element = envelopeOf(
      await client.callTool({ name: "canvas.read", arguments: { ref: firstKey } }),
    );
    const detail = element.data as ElementDetail;
    expect(detail.ref).toBe(firstKey);
    expect(detail.element?.elementKey).toBe(firstKey);
  });

  it("owns listener and MCP teardown behind one idempotent session close", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const attached = await attachCodexOrchestratorSession(backend, {
      primer,
      harness: "codex",
      fresh: true,
    });
    // Host locus always resolves a reachable 127.0.0.1 URL.
    expect(attached.url).not.toBeNull();
    const url = attached.url as string;
    const client = await connect(url);
    await expect(client.listTools()).resolves.toBeDefined();

    await attached.close();
    await attached.close();

    const afterClose = new Client({ name: "after-close", version: "0.0.0" });
    await expect(
      afterClose.connect(new StreamableHTTPClientTransport(new URL(url))),
    ).rejects.toThrow();
  });

  // ── WSL distro-reachability (#334), hermetic (faked probe outcomes) ──────────

  // A hermetic stand-in for the real in-distro probe: fetch the listener's probe
  // path over loopback (in a test every candidate binds loopback via `listen`), so
  // the token round-trip is genuinely exercised — the token must match to select.
  const loopbackProbe = async (
    _addr: string,
    port: number,
    path: string,
  ): Promise<string | null> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  // Bind every candidate to loopback regardless of the requested address (extra
  // positional args ignored), so a non-loopback gateway URL is selectable on a host
  // that cannot bind arbitrary IPs.
  const loopbackListen = (http: Server): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      http.once("listening", () => resolve());
      http.once("error", reject);
      http.listen(0, "127.0.0.1");
    });

  it("wsl mirrored networking keeps the 127.0.0.1 loopback when the distro reaches it", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const reachability: CanvasOpsReachability = {
      probe: async (address, port, path) =>
        address === "127.0.0.1" ? loopbackProbe(address, port, path) : null,
      discoverGateway: async () => null,
    };
    server = await startCanvasOpsExternalServer(backend, {
      locus: { kind: "wsl", distro: "Ubuntu" },
      reachability,
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // The kept listener is genuinely serving on that URL.
    const client = await connect(server.url);
    await expect(client.listTools()).resolves.toBeDefined();
  });

  it("selects the gateway address when only the gateway probe echoes this listener's token", async () => {
    // Off-Windows the gateway can't be a real bind, so `listen` binds loopback while
    // the URL still reflects the gateway. Deleting `candidates.push(gateway)` in the
    // implementation makes this the only candidate vanish → no route → this reddens.
    const { backend } = makeCanvasOpsTestBackend();
    const gateway = "172.20.16.1";
    const reachability: CanvasOpsReachability = {
      // 127.0.0.1 is not reachable (NAT); only the gateway route certifies.
      probe: async (address, port, path) =>
        address === gateway ? loopbackProbe(address, port, path) : null,
      discoverGateway: async () => gateway,
    };
    server = await startCanvasOpsExternalServer(backend, {
      locus: { kind: "wsl", distro: "Ubuntu" },
      reachability,
      listen: loopbackListen,
    });
    expect(server.url).toMatch(/^http:\/\/172\.20\.16\.1:\d+\/mcp$/);
  });

  it("rejects a squatter: a probe that connects but does not echo this token is not reachable", async () => {
    // Bare-TCP-success + wrong token ⇒ candidate rejected. Models an unrelated distro
    // service holding the port and answering with its own (non-matching) body.
    const { backend } = makeCanvasOpsTestBackend();
    let sawProbe = false;
    const reachability: CanvasOpsReachability = {
      probe: async () => {
        sawProbe = true;
        return "HTTP/1.0 200 OK\r\n\r\nsome-other-service"; // connects, wrong token
      },
      discoverGateway: async () => null,
    };
    await expect(
      startCanvasOpsExternalServer(backend, {
        locus: { kind: "wsl", distro: "Ubuntu" },
        reachability,
      }),
    ).rejects.toThrow(/unreachable from the "Ubuntu" WSL distro/);
    expect(sawProbe).toBe(true); // the token check ran and rejected the squatter
  });

  it("wsl with no distro-to-host route fails plainly (no 0.0.0.0, no silent host)", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const reachability: CanvasOpsReachability = {
      probe: async () => null,
      discoverGateway: async () => "172.20.16.1",
    };
    await expect(
      startCanvasOpsExternalServer(backend, {
        locus: { kind: "wsl", distro: "Ubuntu" },
        reachability,
      }),
    ).rejects.toThrow(/unreachable from the "Ubuntu" WSL distro/);
  });

  it("attach settles an unreachable WSL turn as a null-url session with a reason", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const reachability: CanvasOpsReachability = {
      probe: async () => null,
      discoverGateway: async () => null,
    };
    const attached = await attachCodexOrchestratorSession(
      backend,
      { primer, harness: "codex", fresh: true },
      { locus: { kind: "wsl", distro: "Ubuntu" }, reachability },
    );
    try {
      expect(attached.url).toBeNull();
      expect(attached.unreachableReason).toMatch(/unreachable from the "Ubuntu" WSL distro/);
    } finally {
      await attached.close();
    }
  });

  it("rejects and cleans up when the listener errors before listening", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const port = (occupied.address() as AddressInfo).port;
    try {
      const { backend } = makeCanvasOpsTestBackend();
      await expect(startCanvasOpsExternalServer(backend, { port })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
