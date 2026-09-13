import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { type CliIo, NO_SIDECAR_WARNING, runCli as runSourceCli } from "./cli";
import { REVIEW_USAGE } from "./cli-review";
import { createRennetServer } from "./create-server";
import { type DaemonInfo, readDaemonFile, removeDaemonFile, writeDaemonFile } from "./daemon-file";
import {
  OWNER_LOOP_SOURCE,
  OWNER_LOOP_SPEC,
  OWNER_LOOP_UNCITED,
  writeOwnerLoopScriptedHarnessPlan,
} from "./owner-loop-proof-fixture";
import { loadScriptedHarnessPlan, loadScriptedT3Seats } from "./scripted-harness-plan";
import { resolveSidecarBundle } from "./t3/sidecar";

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

  it("POST /shutdown: the whole ack arrives, and THEN the daemon exits (#820)", async () => {
    // Executed against a real daemon process, because the sentence being checked is about a
    // process ending: a shutdown that tore the socket down before flushing would be
    // indistinguishable from a crash, and only a real exit can show the difference. The
    // ordering is the assertion — the parsed body first, the child's `exit` after.
    dataDir = mkdtempSync(resolve(tmpdir(), "rennet-shutdown-"));
    const child = spawn("node", [bundle, "serve", "--data-dir", dataDir], { stdio: "ignore" });
    serveChild = child;
    const claim = await poll(() => readDaemonFile(dataDir));

    const order: string[] = [];
    const exited = new Promise<void>((resolvePromise) => {
      child.once("exit", () => {
        order.push("exit");
        resolvePromise();
      });
    });

    const response = await fetch(`http://127.0.0.1:${claim.wsPort}/shutdown`, { method: "POST" });
    expect(response.status).toBe(200);
    // `.json()` reads the body to completion: a truncated ack throws here rather than passing.
    const ack = await response.json();
    order.push("ack");
    expect(ack).toEqual({
      pid: claim.pid,
      wsPort: claim.wsPort,
      version: claim.version,
      protocolVersion: claim.protocolVersion,
      claimPath: resolve(dataDir, "daemon.json"),
      shuttingDown: true,
    });

    await exited;
    expect(order).toEqual(["ack", "exit"]);
    // The same stop SIGTERM runs: the claim goes with the process.
    expect(child.exitCode).toBe(0);
    expect(readDaemonFile(dataDir)).toBeNull();
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// #875 — `rennet serve` and the T3 Code sidecar.
//
// `serve` used to build its `DaemonConfig` without `t3BundlePath` at all, so the daemon it
// started came up with a `degraded` sidecar. Board seats have that sidecar as their only
// backend, so every lens of every review captured through the CLI failed — at the far end
// of a generation rather than at startup, which is why the desktop app looked fine and the
// CLI did not.
//
// The proof is NOT that a config field is populated. It is a REAL daemon, started by the
// real bundled `rennet serve`, spawning a REAL vendored T3 server, reporting `ready` on the
// same `daemon.status` wire a client reads. Nothing here is a spy.
//
// AND IT IS RUN FROM OUTSIDE THE REPO, which is the load-bearing half of the fixture.
// `resolveSidecarBundle`'s last resort walks up six directories from the bundle's own
// location looking for `vendor/t3code/apps/server/dist/bin.mjs`, and `packages/server/dist`
// is four levels under a checkout that has one. Run in place, EVERY row below would find a
// bundle no matter which way in it was meant to be testing — the flag row would pass with
// the flag ignored, and the no-bundle row could not exist at all. Copying the CLI to a temp
// directory first takes the walk away, so each row has exactly one way to succeed.
//
// WHAT THIS CANNOT CATCH: it does not run a lens seat, so it does not prove a board seat
// succeeds end to end — only that the backend those seats require is up and says so.
// `ready` is a claim about the listener answering `/.well-known/t3/environment`, not about
// a turn completing, so a sidecar that comes up and then serves badly still reads green.
// ─────────────────────────────────────────────────────────────────────────────

/** The vendored T3 server bundle `pnpm check`'s own `build` target produces. */
const vendoredSidecar = resolveSidecarBundle({});

/** Poll an async probe until it answers non-null. */
async function pollAsync<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error("async poll timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface StatusWithSidecar {
  readonly t3Sidecar?: { readonly state: string; readonly detail?: string };
}

describe("`rennet serve` brings up the sidecar its board seats need (#875)", () => {
  let dataDir: string;
  let serveChild: ChildProcess | undefined;
  /** The CLI, copied out of the checkout so its last-resort walk finds no vendored tree. */
  let detachedCli: string;
  let detachedRoot: string;

  beforeAll(() => {
    if (!existsSync(bundle))
      throw new Error(`CLI bundle missing at ${bundle} — run rennet-server:build`);
    detachedRoot = mkdtempSync(resolve(tmpdir(), "rennet-875-cli-"));
    // The whole `dist`, not just `rennet.cjs`: the prompts the daemon reads live beside it.
    cpSync(dirname(bundle), resolve(detachedRoot, "dist"), { recursive: true });
    detachedCli = resolve(detachedRoot, "dist", basename(bundle));
    // The fixture's own premise, executed rather than assumed. If a later change makes the
    // walk reach a vendored tree from here anyway, every row below silently stops
    // discriminating — so it is asserted, from the copy's own directory.
    expect(
      resolveSidecarBundle({ RENNET_T3_BUNDLE: "" }),
      "the repo's own walk still reaches a bundle — the detached copy is not detached",
    ).toBe(vendoredSidecar);
  });

  afterAll(() => {
    if (detachedRoot) rmSync(detachedRoot, { recursive: true, force: true });
  });

  /** Run a subcommand on the DETACHED copy; resolve its exit code + captured output. */
  function runDetachedCli(args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolvePromise) => {
      execFile("node", [detachedCli, ...args], (error, stdout) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolvePromise({ code, stdout });
      });
    });
  }

  afterEach(async () => {
    // `stop` reaps the daemon AND its sidecar; the kill is the belt for a test that failed
    // before it got there. A survivor would hold a port and a base dir into the next run.
    if (dataDir) await runDetachedCli(["stop", "--data-dir", dataDir]).catch(() => undefined);
    if (serveChild && serveChild.exitCode === null) serveChild.kill("SIGKILL");
    serveChild = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Two ways in, both of them ways `rennet-daemon` already had and neither of which `serve`
  // had: the `--t3-bundle` flag, and the `RENNET_T3_BUNDLE` the packaged app sets. Run from
  // the detached copy, each row has exactly one of them and no fallback behind it, so a row
  // that passes proves that row's way in carried the bundle.
  it.skipIf(!vendoredSidecar).each([
    ["RENNET_T3_BUNDLE", "env"],
    ["--t3-bundle", "flag"],
  ] as const)(
    "a daemon served with %s reaches a ready sidecar, not a degraded one",
    async (_label, how) => {
      dataDir = mkdtempSync(resolve(tmpdir(), "rennet-875-"));
      const home = resolve(dataDir, "home");
      mkdirSync(home, { recursive: true });
      const args = ["serve", "--data-dir", dataDir];
      if (how === "flag") args.push("--t3-bundle", vendoredSidecar as string);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RENNET_USER_DATA: dataDir };
      if (how === "env") env.RENNET_T3_BUNDLE = vendoredSidecar as string;
      else delete env.RENNET_T3_BUNDLE;

      serveChild = spawn("node", [detachedCli, ...args], { stdio: "ignore", env });
      const claim = await poll(() => readDaemonFile(dataDir));

      // Read the sidecar's state off the SAME command a connected client reads it from.
      // Poll for `ready` but keep the LAST state seen, so a run that never gets there fails
      // on the state it actually reported rather than on a bare timeout: with no bundle the
      // supervisor never leaves `off`, and "expected 'off' to be 'ready'" is the sentence a
      // reader needs. The `.catch` is what lets the assertion below be the failure.
      let seen: { readonly state: string; readonly detail?: string } | undefined;
      await pollAsync(async () => {
        const out = (await invokeOverWire(claim.wsPort, "daemon.status", {})) as StatusWithSidecar;
        seen = out.t3Sidecar;
        return seen?.state === "ready" ? seen : null;
      }, 45_000).catch(() => undefined);
      expect(
        seen?.state,
        `the sidecar never became ready (detail: ${seen?.detail ?? "none"})`,
      ).toBe("ready");
    },
    120_000,
  );

  // The other half of the #875 question, decided and executed: a daemon that cannot find a
  // bundle STARTS, and says so at second zero. Refusing to serve would take `status`,
  // `pair`, `devices`, the browser UI and every already-captured review away to protect the
  // reviewer from one subsystem — a lockdown, not a fix. What was wrong was never that the
  // daemon ran; it was that nobody was told until five lanes had failed.
  it("with no bundle anywhere it warns on stderr and serves on, rather than refusing", async () => {
    dataDir = mkdtempSync(resolve(tmpdir(), "rennet-875-nobundle-"));
    const home = resolve(dataDir, "home");
    mkdirSync(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RENNET_USER_DATA: dataDir };
    // With the flag absent, the env cleared and the walk out of reach, this CLI has
    // genuinely nothing to resolve — the state a user without a built vendor tree is in.
    delete env.RENNET_T3_BUNDLE;

    const child = spawn("node", [detachedCli, "serve", "--data-dir", dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    serveChild = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    // It came up: the claim is published and the wire answers.
    const claim = await poll(() => readDaemonFile(dataDir));
    const bootstrap = await invokeOverWire(claim.wsPort, "app.bootstrap", {});
    expect(bootstrap).toHaveProperty("repositoryPresent");

    // And it said so, in the terminal, before a review could discover it.
    await poll(() => (stderr.includes("no T3 Code server bundle found") ? stderr : null));
    expect(stderr).toContain(NO_SIDECAR_WARNING);
    expect(stderr).toContain("RENNET_T3_BUNDLE");
    expect(child.exitCode).toBeNull();

    // And on the wire the sidecar is `off` — the SAME thing the desktop's own daemon entry
    // reports with no bundle, which is the agreement #875 is about. `off` rather than
    // `degraded` is deliberate upstream (#849: with no bundle the supervisor starts nothing
    // and stays silent, and names the reason to whoever calls `ensure`), so the terminal
    // warning above is what actually tells an operator. Pinned here so a change to either
    // half is a change both entries make together.
    const status = ((await invokeOverWire(claim.wsPort, "daemon.status", {})) as StatusWithSidecar)
      .t3Sidecar;
    expect(status?.state).toBe("off");
  }, 60_000);
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
      // `serve` also advertises --ui-dist (#381) and --t3-bundle (#875, the same flag
      // `rennet-daemon` takes); the others take only --data-dir.
      const usage =
        subcommand === "serve"
          ? "Usage: rennet serve [--data-dir <dir>] [--ui-dist <dir>] [--t3-bundle <file>]"
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

describe("rennet map (daemonless repo-map build)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(prefix: string): string {
    const dir = mkdtempSync(resolve(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  function git(cwd: string, ...args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolvePromise()));
    });
  }

  const noDeps = { probe: vi.fn(), kill: vi.fn() };

  it("builds, stores, and exports the repo map for a real repository", async () => {
    const repo = makeDir("rennet-map-repo-");
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "cli-test@rennet.local");
    await git(repo, "config", "user.name", "CLI Test");
    mkdirSync(resolve(repo, "src"), { recursive: true });
    writeFileSync(
      resolve(repo, "src/thing.ts"),
      'export function makeThing(): string {\n  return "thing";\n}\n',
    );
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");

    const projectsDir = makeDir("rennet-map-store-");
    const jsonPath = resolve(projectsDir, "map-export.json");
    const captured = captureIo();
    const code = await runSourceCli(
      ["map", repo, "--base", "main", "--projects-dir", projectsDir, "--json", jsonPath],
      captured.io,
      {},
      noDeps,
    );
    expect(code).toBe(0);
    expect(captured.err).toEqual([]);

    // The store advanced: exactly one escaped-path project dir with a current manifest.
    const projectDirs = readdirSync(projectsDir).filter((name) => name !== "map-export.json");
    expect(projectDirs).toHaveLength(1);
    const manifestPath = resolve(projectsDir, projectDirs[0] ?? "", "map/manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    // The export carries the queryable map plus per-file declared symbols.
    const exported = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(exported.baseRef).toBe("main");
    expect(exported.map.files.map((f: { path: string }) => f.path)).toContain("src/thing.ts");
    expect(
      exported.symbols["src/thing.ts"].map((symbol: { name: string }) => symbol.name),
    ).toContain("makeThing");
    expect(captured.out.at(-1)).toBe(`  exported: ${jsonPath}`);
  }, 30_000);

  it("rejects more than one repository path with exit 2 and usage", async () => {
    const captured = captureIo();
    const code = await runSourceCli(["map", "one", "two"], captured.io, {}, noDeps);
    expect(code).toBe(2);
    expect(captured.err.at(-1)).toBe(
      "Usage: rennet map [path] [--base <ref>] [--json <file>] [--projects-dir <dir>]",
    );
  });
});

describe("rennet benchmarks export — the byte-identity claim is exactly true (#731 N9)", () => {
  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  /** One archived run, written straight into the archive the export reads. */
  function seedArchive(startedAtMs: number, durationMs: number): string {
    const dataDir = mkdtempSync(resolve(tmpdir(), "rennet-benchmarks-cli-"));
    writeFileSync(
      resolve(dataDir, "benchmarks.jsonl"),
      `${JSON.stringify({
        version: 1,
        id: `r:${startedAtMs}`,
        kind: "repo-map",
        producer: "cli-map",
        subject: { label: "rennet", repoKey: "rennet", revision: "deadbeef" },
        startedAtMs,
        durationMs,
        outcome: "complete",
        stages: [{ stage: "total", startedAtMs, durationMs }],
      })}\n`,
      "utf8",
    );
    return dataDir;
  }

  async function exportTo(dataDir: string, out: string, extra: string[] = []): Promise<number> {
    const captured = captureIo();
    return runSourceCli(
      [
        "benchmarks",
        "export",
        "--out",
        out,
        "--data-dir",
        dataDir,
        "--revision",
        "abc123",
        ...extra,
      ],
      captured.io,
      {},
      { probe: vi.fn(), kill: vi.fn() },
    );
  }

  it("derives exportedAt from the archive, so re-exporting is a genuinely empty diff", async () => {
    // The defect this pins: `new Date()` here meant the ONE field that could not be
    // identical sat at the top of a file whose own documentation promised byte-identity.
    const dataDir = seedArchive(1_700_000_000_000, 15_000);
    const first = resolve(dataDir, "first.json");
    const second = resolve(dataDir, "second.json");
    expect(await exportTo(dataDir, first)).toBe(0);
    expect(await exportTo(dataDir, second)).toBe(0);
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
    // Derived from the END of the newest run, not from now.
    expect(JSON.parse(readFileSync(first, "utf8")).provenance.exportedAt).toBe(
      new Date(1_700_000_015_000).toISOString(),
    );

    // The positive control on "derived": a DIFFERENT archive must move the stamp, or
    // "identical bytes" would only be proving the stamp is a constant.
    const later = seedArchive(1_700_000_100_000, 15_000);
    const third = resolve(later, "third.json");
    expect(await exportTo(later, third)).toBe(0);
    expect(JSON.parse(readFileSync(third, "utf8")).provenance.exportedAt).not.toBe(
      JSON.parse(readFileSync(first, "utf8")).provenance.exportedAt,
    );
  });

  it("takes an explicit --timestamp, and refuses one that is not a date", async () => {
    const dataDir = seedArchive(1_700_000_000_000, 15_000);
    const out = resolve(dataDir, "stated.json");
    expect(await exportTo(dataDir, out, ["--timestamp", "2026-09-01T10:00:00.000Z"])).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).provenance.exportedAt).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    expect(await exportTo(dataDir, out, ["--timestamp", "not a date"])).toBe(2);
  });
});

// ── rennet review (headless-review-cli, issue #379 / #71) ────────────────────

describe("rennet review: argument and daemon-identity handling", () => {
  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  it.each([
    ["no target", ["review"]],
    ["a range with no ..", ["review", "main"]],
    ["a non-numeric --pr", ["review", "--pr", "abc"]],
  ])("refuses %s with exit 2 and the usage line", async (_label, argv) => {
    const captured = captureIo();
    const code = await runSourceCli(argv, captured.io, {}, { probe: vi.fn(), kill: vi.fn() });
    expect(code).toBe(2);
    expect(captured.err.at(-1)).toBe(REVIEW_USAGE);
  });

  it("reports the daemon-absent message and exits 1, before any other output", async () => {
    const captured = captureIo();
    const code = await runSourceCli(
      ["review", "main..feat/x", "--data-dir", "/nonexistent"],
      captured.io,
      {},
      { probe: async () => ({ kind: "absent" }), kill: vi.fn() },
    );
    expect(code).toBe(1);
    expect(captured.out).toEqual([]);
    expect(captured.err.some((line) => line.includes("the daemon is not running"))).toBe(true);
  });

  it("refuses a daemon that does not advertise the review-cli feature, naming the minimum version", async () => {
    // A pre-D11 daemon completes the handshake but never advertises `review-cli`; its
    // `repository.identify` is an unknown command, so a review would resolve against the wrong
    // repo or base silently. A fake WS server sends exactly that handshake (version 0.1.4, no
    // `review-cli` flag), and the CLI must refuse at connect with exit 1, naming both the minimum
    // version and the daemon's own version, BEFORE it resolves a project or touches git.
    const captured = captureIo();
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((ready) => wss.on("listening", () => ready()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(
          JSON.stringify({
            type: "serverInfo",
            version: "0.1.4",
            protocolVersion: PROTOCOL_VERSION,
            minCompatibleProtocolVersion: PROTOCOL_VERSION,
            features: { serverRequests: true },
          }),
        );
      });
    });
    try {
      const code = await runSourceCli(
        ["review", "main..feat/x", "--data-dir", "/nonexistent-review-cli-gate"],
        captured.io,
        {},
        {
          probe: async () => ({
            kind: "healthy",
            identity: {
              pid: process.pid,
              wsPort: port,
              host: "127.0.0.1",
              version: "0.1.4",
              protocolVersion: PROTOCOL_VERSION,
              minCompatibleProtocolVersion: PROTOCOL_VERSION,
            },
            claim: {
              pid: process.pid,
              wsPort: port,
              host: "127.0.0.1",
              version: "0.1.4",
              protocolVersion: PROTOCOL_VERSION,
              startedAt: new Date().toISOString(),
            },
          }),
          kill: vi.fn(),
        },
      );
      expect(code).toBe(1);
      expect(captured.err.some((line) => line.includes("0.1.5"))).toBe(true);
      expect(captured.err.some((line) => line.includes("v0.1.4"))).toBe(true);
      // Refused at CONNECT: no project was resolved, so nothing was added to any store.
      expect(captured.out.some((line) => line.startsWith("added "))).toBe(false);
    } finally {
      await new Promise<void>((closed) => wss.close(() => closed()));
    }
  });
});

describe("rennet review ↔ a real daemon over the wire (#379, headless-review-cli 4.3)", () => {
  const shutdowns: Array<() => void> = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(root: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: root });
  }
  function writeRepoFile(root: string, path: string, contents: string): void {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  // A single-repo copy of the owner-loop fixture repo: `main` plus a two-commit `feature/shared`
  // with one cited source change and one uncited modification (the Noise lane's material), so the
  // scripted seat plan drafts all five boards.
  function seedRepo(root: string): void {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    git(root, "config", "core.excludesFile", "/dev/null");
    writeRepoFile(root, ".gitignore", ".rennet/\n");
    writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'base';\n");
    writeRepoFile(root, OWNER_LOOP_UNCITED, "export const generatedAt = 'base';\n");
    writeRepoFile(
      root,
      OWNER_LOOP_SPEC,
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Keep the owner-loop value source-backed",
        "The system SHALL keep the owner-loop value source-backed.",
        "",
        "#### Scenario: Review the owner loop",
        "WHEN the owner loop is reviewed",
        "THEN the current value remains source-backed.",
        "",
        `Implementation: \`${OWNER_LOOP_SOURCE}\``,
        "",
      ].join("\n"),
    );
    git(root, "add", ".gitignore", OWNER_LOOP_SOURCE, OWNER_LOOP_UNCITED, OWNER_LOOP_SPEC);
    git(root, "commit", "-qm", "base");
    git(root, "remote", "add", "origin", "git@github.com:owner/target.git");
    git(root, "checkout", "-qb", "feature/shared");
    writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'reviewed';\n");
    writeRepoFile(root, OWNER_LOOP_UNCITED, "export const generatedAt = 'reviewed';\n");
    git(root, "add", OWNER_LOOP_SOURCE, OWNER_LOOP_UNCITED);
    git(root, "commit", "-qm", "reviewed owner value");
    git(root, "checkout", "-q", "main");
  }

  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  it("reviews a range, streams progress, writes the document, and exits fast on a rerun", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "rennet-review-cli-"));
    dirs.push(root);
    const home = resolve(root, "home");
    const dataDir = resolve(root, "data");
    const repoDir = resolve(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const repo = realpathSync(repoDir);
    seedRepo(repo);
    const { planPath } = writeOwnerLoopScriptedHarnessPlan(root);
    const scriptedSeats = loadScriptedT3Seats(planPath);

    const server = await createRennetServer({
      dataDir,
      serverVersion: "0.0.0-test",
      env: {
        ...process.env,
        HOME: home,
        RENNET_DISABLE_HARNESS: "1",
        // Hold the capture record at `capturing-change` long enough for the CLI's poll to
        // observe it: that line comes ONLY from the poll, so it is the poll's red-proof.
        RENNET_TEST_CAPTURE_SETTLEMENT_DELAY_MS: "800",
      },
      testHarnessPort: loadScriptedHarnessPlan(planPath),
      testT3Seats: scriptedSeats.resolve,
    });
    shutdowns.push(server.shutdown);

    // Publish the claim so the CLI's real probe (findHealthyDaemon) finds this in-process daemon.
    const claim: DaemonInfo = {
      pid: process.pid,
      wsPort: server.wsPort,
      host: server.wsHost,
      protocolVersion: PROTOCOL_VERSION,
      version: "0.0.0-test",
      startedAt: new Date().toISOString(),
    };
    writeDaemonFile(dataDir, claim);

    const first = captureIo();
    const code = await runSourceCli(
      ["review", "main..feature/shared", repo, "--data-dir", dataDir],
      first.io,
      { ...process.env, HOME: home },
    );
    expect(code).toBe(0);

    const transcript = first.out.join("\n");
    // The capture step from the mint's own returned record, and the NEXT step from a poll.
    expect(transcript).toContain("capturing  resolving repository");
    expect(transcript).toContain("capturing  capturing change");
    // At least one board write, folded from a `lensDraft` frame over the open socket.
    expect(first.out.some((line) => /wrote \d+ element/.test(line))).toBe(true);
    // The project was added by the CLI (D5), and the daemon added it.
    expect(first.out.some((line) => line.startsWith("added "))).toBe(true);

    // The final stdout line is the document's absolute path, and nothing follows it.
    const documentPath = first.out.at(-1) ?? "";
    expect(documentPath.startsWith(resolve(dataDir, "reviews"))).toBe(true);
    expect(existsSync(documentPath)).toBe(true);
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    expect(document.schemaVersion).toBe(1);
    expect(document.range).toMatchObject({ base: "main", head: "feature/shared" });
    // Five lens keys, each carrying its board.read answer.
    expect(Object.keys(document.boards).sort()).toEqual(
      ["decisions", "design", "flagged", "noise", "sequence"].sort(),
    );
    for (const lens of ["design", "sequence", "decisions", "flagged"]) {
      expect(document.boards[lens].board, `${lens} board`).toBeTruthy();
    }

    // A second run over an unchanged head is a fast exit: no mint of a new preparation, no
    // drafting, and the same review.
    const second = captureIo();
    const rerun = await runSourceCli(
      ["review", "main..feature/shared", repo, "--data-dir", dataDir],
      second.io,
      { ...process.env, HOME: home },
    );
    expect(rerun).toBe(0);
    expect(second.out.some((line) => /wrote \d+ element/.test(line))).toBe(false);
    expect(second.out.some((line) => line.includes("already reviewed"))).toBe(true);
    const rerunPath = second.out.at(-1) ?? "";
    expect(rerunPath).toBe(documentPath);
    expect(JSON.parse(readFileSync(rerunPath, "utf8")).reviewId).toBe(document.reviewId);
  }, 90_000);

  // A minimal two-branch repo with a distinct origin, for the workspace routing test. No
  // owner-loop fixture: this test measures WHICH repo was captured, not the board content.
  function seedWorkspaceRepo(root: string, origin: string): string {
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    git(root, "config", "core.excludesFile", "/dev/null");
    writeRepoFile(root, ".gitignore", ".rennet/\n");
    writeRepoFile(root, "base.ts", "export const base = 'base';\n");
    git(root, "add", ".gitignore", "base.ts");
    git(root, "commit", "-qm", "base");
    git(root, "remote", "add", "origin", origin);
    git(root, "checkout", "-qb", "feature/shared");
    writeRepoFile(root, "base.ts", "export const base = 'reviewed';\n");
    git(root, "add", "base.ts");
    git(root, "commit", "-qm", "reviewed");
    git(root, "checkout", "-q", "main");
    return realpathSync(root);
  }

  it("branch arm captures the checkout's OWN repo in a workspace, not the first included repo (D11)", async () => {
    // Two repos in one workspace project, each with `feature/shared`. `openPath` is the first
    // included repo (repo-a), so a branch mint carrying NO repository captures repo-a even when
    // the reviewer ran `rennet review` in repo-b: the literal pre-D11 bug. The CLI must resolve
    // repo-b's identity via `repository.identify` and pass it on the mint, so the captured
    // document names repo-b. Red-proof: drop `repository: standing.repository` from the branch
    // mint and the captured `repositoryRoot` becomes repo-a, reddening this test.
    const root = mkdtempSync(resolve(tmpdir(), "rennet-review-ws-"));
    dirs.push(root);
    const home = resolve(root, "home");
    const dataDir = resolve(root, "data");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const repoA = seedWorkspaceRepo(resolve(root, "repo-a"), "git@github.com:owner/repo-a.git");
    const repoB = seedWorkspaceRepo(resolve(root, "repo-b"), "git@github.com:owner/repo-b.git");

    const server = await createRennetServer({
      dataDir,
      serverVersion: "0.0.0-test",
      env: { ...process.env, HOME: home, RENNET_DISABLE_HARNESS: "1" },
    });
    shutdowns.push(server.shutdown);
    const claim: DaemonInfo = {
      pid: process.pid,
      wsPort: server.wsPort,
      host: server.wsHost,
      protocolVersion: PROTOCOL_VERSION,
      version: "0.0.0-test",
      startedAt: new Date().toISOString(),
    };
    writeDaemonFile(dataDir, claim);

    // Pre-register the WORKSPACE project (both repos) so the CLI's resolveProjectId finds it and
    // does not add repo-b as its own single-repo project. openPath resolves to repo-a (first).
    await invokeOverWire(claim.wsPort, "projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repoA,
        kind: "workspace",
        repos: [
          { name: "repo-a", path: repoA, branches: 2 },
          { name: "repo-b", path: repoB, branches: 2 },
        ],
        primaryBranch: "main",
        source: "local",
      },
      includedRepos: ["repo-a", "repo-b"],
      primaryBranch: "main",
    });

    const captured = captureIo();
    // A short timeout bounds board drafting (no seats wired here); the capture, and so the
    // document's repositoryRoot, is written whatever the drafting outcome.
    await runSourceCli(
      ["review", "main..feature/shared", repoB, "--data-dir", dataDir, "--timeout", "30"],
      captured.io,
      { ...process.env, HOME: home },
    );
    const documentPath = captured.out.at(-1) ?? "";
    expect(existsSync(documentPath)).toBe(true);
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    expect(document.repositoryRoot).toBe(repoB);
    expect(document.repositoryRoot).not.toBe(repoA);
  }, 90_000);
});
