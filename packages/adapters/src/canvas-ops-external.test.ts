import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CANVAS_OPS_TOOLS, type ElementDetail, type OpsEnvelope } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CanvasOpsExternalServer,
  startCanvasOpsExternalServer,
} from "./canvas-ops-external";
import { makeCanvasOpsTestBackend } from "./canvas-ops-test-backend";

let server: CanvasOpsExternalServer | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
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
});
