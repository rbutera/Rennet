import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type CliIo, runCli as runSourceCli } from "./cli";
import { type DaemonInfo, readDaemonFile, removeDaemonFile, writeDaemonFile } from "./daemon-file";

// End-to-end proof of the `rennet` CLI managing a REAL out-of-process daemon (#379, task
// 5.2): spawn `serve`, `status` reports it running, a command travels the same WS wire the
// desktop uses, `stop` shuts it down, and `status` then reports it gone. The daemon is the
// bundled bin (`dist/rennet.cjs`) — the runnable form of the source-only server package.
// The wire invoke uses raw `ws` rather than WsRennetBridge because layer:server may not
// depend on @rennet/client; the WsRennetBridge-as-client journey lives in the app layer.

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../dist/rennet.cjs");

/** Run a CLI subcommand to completion; resolve its exit code + captured stdout/stderr. */
function runBundledCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile("node", [bundle, ...args], (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Invoke one command over the same session-envelope WS wire, as any Node client would. */
function invokeOverWire(port: number, command: string, input: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const clientId = "cli-test-client";
    const requestId = "cli-test-request";
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("wire invoke timed out"));
    }, 5_000);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId,
          clientType: "rennet-client",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "serverInfo") {
        socket.send(JSON.stringify({ type: "request", requestId, command, input }));
      } else if (frame.type === "response" && frame.requestId === requestId) {
        clearTimeout(timer);
        socket.close();
        resolvePromise(frame.output);
      } else if (frame.type === "rpcError" && frame.requestId === requestId) {
        clearTimeout(timer);
        socket.close();
        reject(new Error(frame.message));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function poll<T>(fn: () => T | null, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("rennet CLI ↔ real daemon lifecycle (#379)", () => {
  let dataDir: string;
  let serveChild: ChildProcess | undefined;

  beforeAll(() => {
    // The bundle is produced by rennet-server:build (a declared dependency of this target).
    if (!existsSync(bundle))
      throw new Error(`CLI bundle missing at ${bundle} — run rennet-server:build`);
  });

  afterEach(() => {
    if (serveChild && serveChild.exitCode === null) serveChild.kill("SIGKILL");
    serveChild = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("serve → status(running) → invoke over the wire → stop → status(not running)", async () => {
    dataDir = mkdtempSync(resolve(tmpdir(), "rennet-cli-"));

    serveChild = spawn("node", [bundle, "serve", "--data-dir", dataDir], { stdio: "ignore" });

    // The daemon publishes its claim once the listener is up.
    const claim = await poll(() => readDaemonFile(dataDir));
    expect(claim.pid).toBeGreaterThan(0);

    const running = await runBundledCli(["status", "--data-dir", dataDir]);
    expect(running.code).toBe(0);
    expect(running.stdout).toContain("running");
    expect(running.stdout).toContain(`127.0.0.1:${claim.wsPort}`);

    // A command travels the same WS wire the desktop renderer uses.
    const bootstrap = await invokeOverWire(claim.wsPort, "app.bootstrap", {});
    expect(bootstrap).toHaveProperty("repositoryPresent");

    const stopped = await runBundledCli(["stop", "--data-dir", dataDir]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped");

    const gone = await runBundledCli(["status", "--data-dir", dataDir]);
    expect(gone.code).toBe(1);
    expect(gone.stdout).toContain("not running");
    expect(readDaemonFile(dataDir)).toBeNull();
  }, 30_000);
});

describe("rennet CLI argument and daemon-identity handling", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "rennet-cli-unit-"));
    dirs.push(dir);
    return dir;
  }

  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  function claim(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
    return {
      pid: 4321,
      wsPort: 51_234,
      protocolVersion: PROTOCOL_VERSION,
      version: "1.2.3",
      startedAt: "2026-08-18T00:00:00.000Z",
      ...overrides,
    };
  }

  it.each([["serve"], ["status"], ["stop"]])(
    "%s rejects a missing --data-dir value with exit 2 and usage",
    async (subcommand) => {
      const captured = captureIo();
      const code = await runSourceCli(
        [subcommand, "--data-dir"],
        captured.io,
        {},
        {
          probe: vi.fn(),
          kill: vi.fn(),
        },
      );
      expect(code).toBe(2);
      // `serve` also advertises --ui-dist (#381); the others take only --data-dir.
      const usage =
        subcommand === "serve"
          ? "Usage: rennet serve [--data-dir <dir>] [--ui-dist <dir>]"
          : `Usage: rennet ${subcommand} [--data-dir <dir>]`;
      expect(captured.err.at(-1)).toBe(usage);
    },
  );

  it("rejects unknown subcommand options with exit 2 and usage", async () => {
    const captured = captureIo();
    const code = await runSourceCli(
      ["status", "--bogus"],
      captured.io,
      {},
      {
        probe: vi.fn(),
        kill: vi.fn(),
      },
    );
    expect(code).toBe(2);
    expect(captured.err.at(-1)).toBe("Usage: rennet status [--data-dir <dir>]");
  });

  it("serve reports an existing verified daemon without starting or rewriting it", async () => {
    const dir = makeDir();
    const existing = claim();
    writeDaemonFile(dir, existing);
    const captured = captureIo();
    const code = await runSourceCli(
      ["serve", "--data-dir", dir],
      captured.io,
      {},
      {
        probe: async () => ({
          kind: "healthy",
          claim: existing,
          identity: {
            ...existing,
            minCompatibleProtocolVersion: PROTOCOL_VERSION,
          },
        }),
        kill: vi.fn(),
      },
    );
    expect(code).toBe(1);
    expect(captured.err).toContain(
      `already running (pid ${existing.pid}, port ${existing.wsPort})`,
    );
    expect(readDaemonFile(dir)).toEqual(existing);
  });

  it("stop removes a stale claim without signalling its reused pid", async () => {
    const dir = makeDir();
    const stale = claim();
    writeDaemonFile(dir, stale);
    const kill = vi.fn();
    const captured = captureIo();
    const code = await runSourceCli(
      ["stop", "--data-dir", dir],
      captured.io,
      {},
      {
        probe: async () => ({ kind: "stale", claim: stale }),
        kill,
      },
    );
    expect(code).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(readDaemonFile(dir)).toBeNull();
    expect(captured.out).toContain(
      `removed stale pidfile (pid ${stale.pid} was not a verified daemon)`,
    );
  });

  it("stop signals a health-verified claim and only removes that pid's claim", async () => {
    const dir = makeDir();
    const running = claim();
    writeDaemonFile(dir, running);
    const kill = vi.fn(() => {
      removeDaemonFile(dir, running.pid);
    });
    const code = await runSourceCli(
      ["stop", "--data-dir", dir],
      captureIo().io,
      {},
      {
        probe: async () => ({
          kind: "healthy",
          claim: running,
          identity: {
            ...running,
            minCompatibleProtocolVersion: PROTOCOL_VERSION,
          },
        }),
        kill,
      },
    );
    expect(code).toBe(0);
    expect(kill).toHaveBeenCalledWith(running.pid, "SIGTERM");
  });
});
