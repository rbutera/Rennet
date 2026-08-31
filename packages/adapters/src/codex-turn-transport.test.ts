import type { Locus } from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { CodexTurnSpec } from "./codex-adapter";
import type { AppServerConnection, SpawnAppServer } from "./codex-app-server";
import { type CodexTransportEffects, createCodexTurnTransport } from "./codex-turn-transport";

// ── A fake SpawnAppServer that scripts a happy turn and captures wiring ─────────

interface SpawnCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

interface TransportScript {
  readonly mcpList?: unknown;
  readonly mcpListSequence?: readonly unknown[];
  readonly mcpListExitCode?: number | null;
  readonly mcpListExitCodeSequence?: readonly (number | null)[];
}

const MCP_INVENTORY = [
  { name: "computer-history", transport: { type: "stdio", command: "/private/tool" } },
  {
    name: "context7",
    transport: { type: "streamable_http", url: "https://example.invalid/mcp" },
  },
] as const;

function makeQueue(): {
  push: (v: Record<string, unknown>) => void;
  close: () => void;
  iterable: AsyncIterable<Record<string, unknown>>;
} {
  const buffer: Record<string, unknown>[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const ping = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (v) => {
      buffer.push(v);
      ping();
    },
    close: () => {
      done = true;
      ping();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as Record<string, unknown>;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

function fakeEffects(script: TransportScript = {}): {
  effects: CodexTransportEffects;
  spawns: SpawnCall[];
  mcpLists: SpawnCall[];
  turnStarts: Record<string, unknown>[];
} {
  const spawns: SpawnCall[] = [];
  const mcpLists: SpawnCall[] = [];
  const turnStarts: Record<string, unknown>[] = [];
  const spawn: SpawnAppServer = ({ bin, args, cwd }) => {
    spawns.push({ bin, args, cwd });
    const q = makeQueue();
    const conn: AppServerConnection = {
      send: (message) => {
        const method = message.method;
        const id = message.id;
        if (method === "initialize") q.push({ id, result: {} });
        else if (method === "thread/start") q.push({ id, result: { thread: { id: "th" } } });
        else if (method === "turn/start") {
          turnStarts.push(message.params as Record<string, unknown>);
          q.push({
            method: "turn/completed",
            params: { threadId: "th", turn: { id: "tn", status: "completed", items: [] } },
          });
        }
      },
      messages: q.iterable,
      kill: () => q.close(),
      exit: Promise.resolve({ exitCode: 0, stderr: "", aborted: false }),
    };
    return conn;
  };
  const runMcpList = async (spec: SpawnCall) => {
    const callIndex = mcpLists.length;
    mcpLists.push(spec);
    const exitCode =
      script.mcpListExitCodeSequence?.[callIndex] ??
      (script.mcpListExitCode === undefined ? 0 : script.mcpListExitCode);
    return {
      exitCode,
      stdout: JSON.stringify(script.mcpListSequence?.[callIndex] ?? script.mcpList ?? []),
      stderr: exitCode ? "mcp list failed" : "",
    };
  };
  const effects = { spawn, runMcpList };
  return { effects, spawns, mcpLists, turnStarts };
}

async function drive(transport: ReturnType<typeof createCodexTurnTransport>, spec: CodexTurnSpec) {
  for await (const frame of transport(spec)) void frame;
}

describe("Codex transport locus composition", () => {
  const wslSpec: CodexTurnSpec = {
    cwd: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
    prompt: "review this",
    outputSchema: { type: "object" },
  };

  it("host locus spawns codex app-server directly with the host repo cwd", async () => {
    const { effects, spawns, mcpLists, turnStarts } = fakeEffects({ mcpList: MCP_INVENTORY });
    const hostSpec: CodexTurnSpec = {
      cwd: "/home/rai/repo",
      prompt: "go",
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    };
    await drive(createCodexTurnTransport("codex", effects), hostSpec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.args.slice(0, 3)).toEqual(["app-server", "--disable", "plugins"]);
    expect(call.cwd).toBe("/home/rai/repo");
    // The inventory is read once, then ambient servers are disabled in the same table.
    expect(mcpLists).toHaveLength(1);
    expect(call.args).toContain("-c");
    expect(call.args).toContain(
      'mcp_servers={"canvasops"={url="http://127.0.0.1:5000/mcp",enabled=true},"computer-history"={command="false",args=[],enabled=false},"context7"={url="http://127.0.0.1",enabled=false}}',
    );
    // turn/start ran in the host repo cwd.
    expect(turnStarts[0]?.cwd).toBe("/home/rai/repo");
  });

  it("surfaces a synchronous spawn throw inside the event stream (never escapes it)", async () => {
    const effects: CodexTransportEffects = {
      spawn: () => {
        throw new Error("boom: spawn EACCES");
      },
      runMcpList: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
    };
    const frames: unknown[] = [];
    for await (const frame of createCodexTurnTransport(
      "codex",
      effects,
    )({
      cwd: "/repo",
      prompt: "go",
    })) {
      frames.push(frame);
    }
    const terminal = frames.find((f) => (f as { rennet?: string }).rennet === "turn-result") as
      | { status?: string; error?: { source?: string } }
      | undefined;
    expect(terminal?.status).toBe("failed");
    expect(terminal?.error?.source).toBe("spawn");
  });

  it("wsl locus wraps the spawn in wsl.exe -e with a distro-native turn cwd", async () => {
    const { effects, spawns, turnStarts } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    await drive(createCodexTurnTransport("codex", effects, locus), wslSpec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("wsl.exe");
    expect(call.cwd).toBeUndefined();
    expect(call.args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--cd", "/home/rai/repo"]);
    expect(call.args[4]).toBe("-e");
    expect(call.args[5]).toBe("codex");
    expect(call.args[6]).toBe("app-server");
    // The turn runs against the distro-native repo path (never the UNC path).
    expect(turnStarts[0]?.cwd).toBe("/home/rai/repo");
  });

  it("wsl locus with an untranslatable repo path fails before any spawn", async () => {
    const { effects, spawns } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    const untranslatable: CodexTurnSpec = { ...wslSpec, cwd: "C:\\Users\\rai\\repo" };
    await expect(
      drive(createCodexTurnTransport("codex", effects, locus), untranslatable),
    ).rejects.toThrow(/not translatable.*Ubuntu|Ubuntu.*not translatable/s);
    expect(spawns).toHaveLength(0);
  });

  it("wsl locus launches an asdf codex through its paired node inside the -e argv", async () => {
    const { effects, spawns, mcpLists } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    const codex = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/codex";
    const node = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/node";
    await drive(createCodexTurnTransport(codex, effects, locus, node), {
      ...wslSpec,
      mcpServers: {},
    });

    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("wsl.exe");
    const e = call.args.indexOf("-e");
    expect(call.args[e + 1]).toBe(node); // the paired runtime, verbatim
    expect(call.args[e + 2]).toBe(codex); // the codex launcher, verbatim
    expect(call.args.slice(e + 3)).toEqual([
      "app-server",
      "--disable",
      "plugins",
      "-c",
      "mcp_servers={}",
    ]);
    const list = mcpLists[0] as SpawnCall;
    expect(list.bin).toBe("wsl.exe");
    const listE = list.args.indexOf("-e");
    expect(list.args.slice(0, listE)).toEqual(call.args.slice(0, e));
    expect(list.args.slice(listE + 1)).toEqual([node, codex, "mcp", "list", "--json"]);
  });

  it("host locus without a paired runtime spawns codex directly (byte-identical)", async () => {
    const { effects, spawns, mcpLists } = fakeEffects();
    await drive(createCodexTurnTransport("codex", effects), {
      cwd: "/home/rai/repo",
      prompt: "go",
    });
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.args[0]).toBe("app-server");
    expect(mcpLists).toHaveLength(0);
  });

  it("discovers the ambient MCP inventory once across same-cwd concurrent agentic turns", async () => {
    const { effects, spawns, mcpLists } = fakeEffects({ mcpList: MCP_INVENTORY });
    const transport = createCodexTurnTransport("codex", effects);
    const spec: CodexTurnSpec = { cwd: "/repo", prompt: "go", mcpServers: {} };

    await Promise.all([drive(transport, spec), drive(transport, spec)]);

    expect(mcpLists).toHaveLength(1);
    expect(spawns).toHaveLength(2);
  });

  it("keeps separate MCP inventories for different project cwd commands", async () => {
    const { effects, mcpLists } = fakeEffects({ mcpList: MCP_INVENTORY });
    const transport = createCodexTurnTransport("codex", effects);

    await drive(transport, { cwd: "/repo-one", prompt: "one", mcpServers: {} });
    await drive(transport, { cwd: "/repo-two", prompt: "two", mcpServers: {} });

    expect(mcpLists.map((call) => call.cwd)).toEqual(["/repo-one", "/repo-two"]);
  });

  it("refreshes the inventory between sequential turns in the same cwd", async () => {
    const { effects, mcpLists, spawns } = fakeEffects({
      mcpListSequence: [[MCP_INVENTORY[0]], MCP_INVENTORY],
    });
    const transport = createCodexTurnTransport("codex", effects);
    const spec: CodexTurnSpec = { cwd: "/repo", prompt: "go", mcpServers: {} };

    await drive(transport, spec);
    await drive(transport, spec);

    expect(mcpLists).toHaveLength(2);
    expect(spawns[0]?.args[4]).not.toContain("context7");
    expect(spawns[1]?.args[4]).toContain("context7");
  });

  it("fails before spawn, then retries agentic MCP discovery", async () => {
    const { effects, spawns, mcpLists } = fakeEffects({
      mcpListSequence: [[], MCP_INVENTORY],
      mcpListExitCodeSequence: [2, 0],
    });
    const transport = createCodexTurnTransport("codex", effects);

    await expect(drive(transport, { cwd: "/repo", prompt: "go", mcpServers: {} })).rejects.toThrow(
      /mcp list.*exited 2/i,
    );
    await drive(transport, { cwd: "/repo", prompt: "retry", mcpServers: {} });
    expect(mcpLists).toHaveLength(2);
    expect(spawns).toHaveLength(1);
  });
});
