import { describe, expect, it } from "vitest";
import {
  buildAppServerArgs,
  CODEX_CLIENT_INFO,
  defaultRunCodexMcpList,
  defaultSpawnAppServer,
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

async function initializeAppServer(args: readonly string[]): Promise<void> {
  const connection = defaultSpawnAppServer({ bin: CODEX_BIN, args, cwd: process.cwd() });
  const timeout = setTimeout(() => connection.kill(), 5_000);
  try {
    connection.send({ id: 1, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } });
    for await (const message of connection.messages) {
      if (message.id !== 1) continue;
      if (message.error !== undefined) {
        throw new Error(`app-server rejected initialize: ${JSON.stringify(message.error)}`);
      }
      expect(message.result).toBeDefined();
      return;
    }
    const exit = await connection.exit;
    const detail =
      exit.spawnError ?? (exit.stderr.trim() || `exit code ${exit.exitCode ?? "unknown"}`);
    throw new Error(`app-server exited before initialize: ${detail}`);
  } finally {
    clearTimeout(timeout);
    connection.kill();
    await connection.exit;
  }
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
    const config = buildAppServerArgs({}, inventory)[4];
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
    )[4];
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

  it.skipIf(!LIVE)("initializes app-server with the complete explicit-policy argv", async () => {
    const inventory = await readCodexMcpServerInventory(defaultRunCodexMcpList, {
      bin: CODEX_BIN,
      args: ["mcp", "list", "--json"],
      cwd: process.cwd(),
    });
    const args = buildAppServerArgs({}, inventory);

    await expect(
      initializeAppServer([
        "app-server",
        "--disable",
        "rennet-proof-feature-does-not-exist",
        ...args.slice(3),
      ]),
    ).rejects.toThrow(/feature|config|disable|unexpected/i);
    await expect(initializeAppServer(args)).resolves.toBeUndefined();
  });
});
