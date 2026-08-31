import { describe, expect, it } from "vitest";
import {
  buildAppServerArgs,
  defaultRunCodexMcpList,
  readCodexMcpServerInventory,
} from "./codex-app-server";

const LIVE = process.env.RENNET_LIVE_CODEX_MCP_CONFIG === "1";
const CODEX_BIN = process.env.RENNET_CODEX_BIN ?? "codex";

interface ListedServer {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: {
    readonly type: string;
    readonly url?: string;
  };
}

async function listConfiguredServers(config?: string): Promise<readonly ListedServer[]> {
  const result = await defaultRunCodexMcpList({
    bin: CODEX_BIN,
    args: [...(config === undefined ? [] : ["-c", config]), "mcp", "list", "--json"],
    cwd: process.cwd(),
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as readonly ListedServer[];
}

describe("Codex MCP isolation — installed CLI (gated, no model turn)", () => {
  it.skipIf(!LIVE)("disables every ambient server for an explicit empty policy", async () => {
    const baseline = await listConfiguredServers();
    expect(baseline.some((server) => server.enabled)).toBe(true);
    const inventory = await readCodexMcpServerInventory(defaultRunCodexMcpList, {
      bin: CODEX_BIN,
      args: ["mcp", "list", "--json"],
      cwd: process.cwd(),
    });
    const config = buildAppServerArgs({}, inventory)[2];
    expect(config).toBeDefined();

    const isolated = await listConfiguredServers(config);
    expect(isolated).toHaveLength(baseline.length);
    expect(isolated.every((server) => !server.enabled)).toBe(true);
  });

  it.skipIf(!LIVE)("keeps only Rennet's requested loopback server enabled", async () => {
    const inventory = await readCodexMcpServerInventory(defaultRunCodexMcpList, {
      bin: CODEX_BIN,
      args: ["mcp", "list", "--json"],
      cwd: process.cwd(),
    });
    const requestedName = "rennet-proof-canvasops";
    expect(inventory.some((server) => server.name === requestedName)).toBe(false);
    const config = buildAppServerArgs(
      { [requestedName]: { url: "http://127.0.0.1:9/mcp" } },
      inventory,
    )[2];
    expect(config).toBeDefined();

    const isolated = await listConfiguredServers(config);
    const requested = isolated.find((server) => server.name === requestedName);
    expect(requested).toMatchObject({
      enabled: true,
      transport: { type: "streamable_http", url: "http://127.0.0.1:9/mcp" },
    });
    expect(
      isolated.filter((server) => server.name !== requestedName).every((server) => !server.enabled),
    ).toBe(true);
  });
});
