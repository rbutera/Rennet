import { createServer } from "node:http";
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

  it("wsl mirrored networking keeps the 127.0.0.1 loopback when the distro reaches it", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const reachability: CanvasOpsReachability = {
      probeReachable: async (address) => address === "127.0.0.1",
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

  it("wsl with no distro-to-host route fails plainly (no 0.0.0.0, no silent host)", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const reachability: CanvasOpsReachability = {
      probeReachable: async () => false,
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
      probeReachable: async () => false,
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
