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

function fakeEffects(): {
  effects: CodexTransportEffects;
  spawns: SpawnCall[];
  turnStarts: Record<string, unknown>[];
} {
  const spawns: SpawnCall[] = [];
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
  return { effects: { spawn }, spawns, turnStarts };
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
    const { effects, spawns, turnStarts } = fakeEffects();
    const hostSpec: CodexTurnSpec = {
      cwd: "/home/rai/repo",
      prompt: "go",
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    };
    await drive(createCodexTurnTransport("codex", effects), hostSpec);

    expect(spawns).toHaveLength(1);
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.args[0]).toBe("app-server");
    expect(call.cwd).toBe("/home/rai/repo");
    // canvasOps MCP URL rides a spawn-time -c override.
    expect(call.args).toContain("mcp_servers.canvasops.url=http://127.0.0.1:5000/mcp");
    // turn/start ran in the host repo cwd.
    expect(turnStarts[0]?.cwd).toBe("/home/rai/repo");
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
    const { effects, spawns } = fakeEffects();
    const locus: Locus = { kind: "wsl", distro: "Ubuntu" };
    const codex = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/codex";
    const node = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/node";
    await drive(createCodexTurnTransport(codex, effects, locus, node), wslSpec);

    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("wsl.exe");
    const e = call.args.indexOf("-e");
    expect(call.args[e + 1]).toBe(node); // the paired runtime, verbatim
    expect(call.args[e + 2]).toBe(codex); // the codex launcher, verbatim
    expect(call.args[e + 3]).toBe("app-server");
  });

  it("host locus without a paired runtime spawns codex directly (byte-identical)", async () => {
    const { effects, spawns } = fakeEffects();
    await drive(createCodexTurnTransport("codex", effects), {
      cwd: "/home/rai/repo",
      prompt: "go",
    });
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("codex");
    expect(call.args[0]).toBe("app-server");
  });
});
