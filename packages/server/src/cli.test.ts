import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { readDaemonFile } from "./daemon-file";

// End-to-end proof of the `rennet` CLI managing a REAL out-of-process daemon (#379, task
// 5.2): spawn `serve`, `status` reports it running, a command travels the same WS wire the
// desktop uses, `stop` shuts it down, and `status` then reports it gone. The daemon is the
// bundled bin (`dist/rennet.cjs`) — the runnable form of the source-only server package.
// The wire invoke uses raw `ws` rather than WsRennetBridge because layer:server may not
// depend on @rennet/client; the WsRennetBridge-as-client journey lives in the app layer.

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../dist/rennet.cjs");

/** Run a CLI subcommand to completion; resolve its exit code + captured stdout/stderr. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

    const running = await runCli(["status", "--data-dir", dataDir]);
    expect(running.code).toBe(0);
    expect(running.stdout).toContain("running");
    expect(running.stdout).toContain(`port ${claim.wsPort}`);

    // A command travels the same WS wire the desktop renderer uses.
    const bootstrap = await invokeOverWire(claim.wsPort, "app.bootstrap", {});
    expect(bootstrap).toHaveProperty("repositoryPresent");

    const stopped = await runCli(["stop", "--data-dir", dataDir]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped");

    const gone = await runCli(["status", "--data-dir", dataDir]);
    expect(gone.code).toBe(1);
    expect(gone.stdout).toContain("not running");
    expect(readDaemonFile(dataDir)).toBeNull();
  }, 30_000);
});
