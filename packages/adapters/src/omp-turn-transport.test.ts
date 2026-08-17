import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { OmpAdapter } from "./omp-adapter";
import {
  createOmpTurnTransport,
  defaultOmpTransportEffects,
  type OmpTransportEffects,
  renderOmpMcpConfig,
} from "./omp-turn-transport";

// ── Pure invocation assembly via recording effects (no process) ──────────────

function recordingEffects(): {
  effects: OmpTransportEffects;
  accessed: string[];
  captured: {
    bin?: string;
    args?: readonly string[];
    cwd?: string;
    prompt?: string;
  };
  writes: Map<string, string>;
} {
  const accessed: string[] = [];
  const writes = new Map<string, string>();
  const captured: {
    bin?: string;
    args?: readonly string[];
    cwd?: string;
    prompt?: string;
  } = {};
  const effects: OmpTransportEffects = {
    mkdtemp: (prefix) => {
      accessed.push(prefix);
      return Promise.resolve(`${prefix}scratch`);
    },
    writeFile: (path, data) => {
      accessed.push(path);
      writes.set(path, data);
      return Promise.resolve();
    },
    rm: (path) => {
      accessed.push(path);
      return Promise.resolve();
    },
    spawn: (bin, args, cwd, prompt) => {
      captured.bin = bin;
      captured.args = args;
      captured.cwd = cwd;
      captured.prompt = prompt;
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
          accessed.push(`spawn:${bin}`);
          yield { type: "ready", protocolVersion: 1 };
          yield {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          };
          yield { rennet: "turn-result", exitCode: 0, finalText: "ok" };
        },
      };
    },
  };
  return { effects, accessed, captured, writes };
}

function isCredentialPath(path: string): boolean {
  return (
    path.endsWith("/auth.json") ||
    path.endsWith("/.credentials.json") ||
    path.includes("/.omp/auth") ||
    path.includes("/.codex/auth")
  );
}

async function runTurn(
  transport: ReturnType<typeof createOmpTurnTransport>,
  spec: Parameters<ReturnType<typeof createOmpTurnTransport>>[0],
): Promise<void> {
  const adapter = new OmpAdapter({ binaryPath: "/x/omp", transport });
  const session = await adapter.createSession({ cwd: spec.cwd });
  await session.send({ prompt: spec.prompt });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
}

describe("createOmpTurnTransport — invocation assembly", () => {
  it("places an exact mcp.json in the scratch extension omp is told to load", async () => {
    const { effects, captured, writes } = recordingEffects();
    // Drive the transport directly with a spec carrying MCP servers.
    const transport = createOmpTurnTransport("/x/omp", "/x/bun", effects);
    const iterable = transport({
      cwd: "/repo",
      prompt: "review this",
      model: "opus",
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    });
    for await (const _frame of iterable) void _frame;

    const args = captured.args ?? [];
    expect(captured.bin).toBe("/x/bun");
    expect(args[0]).toBe("/x/omp");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
    expect(args).toContain("--auto-approve");
    expect(args).toContain("--no-session");
    expect(args).toContain("--cwd");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/repo");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("--extension");
    const extensionPath = args[args.indexOf("--extension") + 1] ?? "";
    const mcpPath = join(extensionPath, "mcp.json");
    expect(writes.has(mcpPath)).toBe(true);
    expect(JSON.parse(writes.get(mcpPath) ?? "null")).toEqual({
      mcpServers: {
        canvasops: { type: "http", url: "http://127.0.0.1:5000/mcp" },
      },
    });
    expect(args).not.toContain("--config");
    // Denylist: no approval-requesting / write-gating / read-only / resume / acp flag.
    for (const banned of ["--approval-mode", "always-ask", "--plan-yolo", "--no-tools", "acp"]) {
      expect(args).not.toContain(banned);
    }
    // The prompt is a stdin command, never a positional arg.
    expect(captured.prompt).toBe("review this");
    expect(args).not.toContain("review this");
  });

  it("renders no --extension flag when the spec carries no MCP servers", async () => {
    const { effects, captured } = recordingEffects();
    const transport = createOmpTurnTransport("/x/omp", "/x/bun", effects);
    for await (const _frame of transport({ cwd: "/repo", prompt: "go" })) void _frame;
    expect(captured.args).not.toContain("--extension");
  });

  it("renders omp's supported mcp.json schema", () => {
    const json = renderOmpMcpConfig({
      canvasops: { url: "http://127.0.0.1:7000/mcp" },
    });
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        canvasops: { type: "http", url: "http://127.0.0.1:7000/mcp" },
      },
    });
  });

  it("reads no credential path across construction and a full turn (tripwire)", async () => {
    const { effects, accessed } = recordingEffects();
    await runTurn(createOmpTurnTransport("/x/omp", "/x/bun", effects), {
      cwd: "/repo",
      prompt: "review",
    });
    // Positive control: the transport actually touched the filesystem.
    expect(accessed.length).toBeGreaterThan(0);
    // The finding: none of those touches was a credential path.
    expect(accessed.filter(isCredentialPath)).toEqual([]);
    // Control that the predicate CAN fire on a real credential path.
    expect(isCredentialPath("/home/rai/.omp/auth.json")).toBe(true);
    expect(isCredentialPath("/home/rai/.omp/config.yml")).toBe(false);
  });
});

// ── The real spawn: process-tree termination on abort (mirror of codex) ──────

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("descendant pid was not written");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`descendant ${pid} survived transport cancellation`);
}

describe("omp process transport", () => {
  it("surfaces corrupt NDJSON as protocol evidence before a failed terminal", async () => {
    const frames: unknown[] = [];
    for await (const frame of defaultOmpTransportEffects.spawn(
      process.execPath,
      ["-e", 'process.stdout.write("not-json\\n")'],
      process.cwd(),
      "prompt",
    )) {
      frames.push(frame);
    }
    expect(frames).toContainEqual(
      expect.objectContaining({
        rennet: "protocol-failure",
        reason: "malformed-frame",
      }),
    );
    expect(frames.at(-1)).toEqual(expect.objectContaining({ rennet: "turn-result" }));

    const transport = () =>
      defaultOmpTransportEffects.spawn(
        process.execPath,
        ["-e", 'process.stdout.write("not-json\\n")'],
        process.cwd(),
        "prompt",
      );
    const session = await new OmpAdapter({
      binaryPath: process.execPath,
      transport,
    }).createSession({
      cwd: process.cwd(),
    });
    await session.send({ prompt: "go" });
    let outcome: SessionOutcome | null = null;
    for await (const event of session.events) {
      if (event.kind === "session.ended") outcome = event.outcome;
    }
    expect(outcome?.status).toBe("failed");
  });

  it("caps stderr bytes and discloses truncation", async () => {
    const frames: unknown[] = [];
    for await (const frame of defaultOmpTransportEffects.spawn(
      process.execPath,
      ["-e", 'process.stderr.write("e".repeat(100_000))'],
      process.cwd(),
      "prompt",
    )) {
      frames.push(frame);
    }
    const terminal = frames.at(-1) as { stderr?: string } | undefined;
    expect(terminal?.stderr).toContain("[stderr truncated at 65536 bytes]");
    expect(Buffer.byteLength(terminal?.stderr ?? "")).toBeLessThan(65_600);
  });

  it("bounds a giant unterminated frame and fails it as oversized", async () => {
    const frames: unknown[] = [];
    for await (const frame of defaultOmpTransportEffects.spawn(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(1_100_000))'],
      process.cwd(),
      "prompt",
    )) {
      frames.push(frame);
    }
    expect(frames).toContainEqual(
      expect.objectContaining({
        rennet: "protocol-failure",
        reason: "oversized-frame",
      }),
    );
  });

  it("turns an asynchronous spawn failure into exactly one failed terminal frame", async () => {
    const { effects } = recordingEffects();
    const failing: OmpTransportEffects = {
      ...effects,
      spawn: () => ({
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: () => Promise.reject(new Error("spawn rejected")),
          };
        },
      }),
    };
    const frames: unknown[] = [];
    for await (const frame of createOmpTurnTransport(
      "/x/omp",
      "/x/bun",
      failing,
    )({
      cwd: "/repo",
      prompt: "go",
    })) {
      frames.push(frame);
    }
    expect(frames).toEqual([expect.objectContaining({ rennet: "turn-result", exitCode: 1 })]);
  });

  it.skipIf(process.platform === "win32")(
    "kills a Node launcher and its long-lived descendant on abort",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rennet-omp-tree-"));
      const pidPath = join(dir, "descendant.pid");
      const launcher = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[1], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const abort = new AbortController();
      try {
        const draining = (async () => {
          for await (const frame of defaultOmpTransportEffects.spawn(
            process.execPath,
            ["-e", launcher, pidPath],
            dir,
            "prompt",
            abort.signal,
          )) {
            void frame;
          }
        })();
        const descendantPid = await waitForPid(pidPath);
        abort.abort();
        await draining;
        await waitForExit(descendantPid);
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
