import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WsRennetBridge } from "@rennet/client";
import { findHealthyDaemon, readDaemonFile, spawnDaemon, waitForHealthy } from "@rennet/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The acceptance journey (#379, task 6.2): a review daemon survives "app quit" and the
// relaunched client reattaches to the SAME process. Proven at the contract layer (design
// 6.2 allows this over a flaky Playwright double-launch) with the REAL supervision helpers
// and a REAL WsRennetBridge — the same helper the shell uses to spawn/probe and the same
// bridge the renderer uses. This is the only layer permitted to import both @rennet/server
// and @rennet/client, so the two reals meet here.

const here = dirname(fileURLToPath(import.meta.url));
// The bundle the packaged/dev app spawns (built by rennet-desktop:build, this target's dep).
const daemonBundle = resolve(here, "../dist/server/index.cjs");

/** Drive one command over the WsRennetBridge, then close it (the "client" of one launch). */
async function bootstrapVia(port: number): Promise<{ bridge: WsRennetBridge; result: unknown }> {
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, initialBackoffMs: 10 });
  const result = await bridge.invoke("app.bootstrap", {});
  return { bridge, result };
}

async function waitForClaimGone(dataDir: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readDaemonFile(dataDir) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The user's REAL daemon-settings file. A spawned daemon resolves its settings stores from
 *  `$HOME`, not from `--data-dir`, so a test that lets it inherit this process's HOME writes
 *  the developer's own config (it recorded a bogus `lastSeenVersion` there once). Every spawn
 *  below gets a throwaway HOME, and the test asserts this file was left exactly as it was. */
const realDaemonSettings = join(homedir(), ".rennet", "daemon-settings.json");
const readRealSettings = (): string | null => {
  try {
    return readFileSync(realDaemonSettings, "utf8");
  } catch {
    return null;
  }
};

describe("daemon survives app quit; client reattaches (#379)", () => {
  let dataDir: string;
  let home: string;
  let pid: number | undefined;

  beforeAll(() => {
    if (!existsSync(daemonBundle)) {
      throw new Error(`daemon bundle missing at ${daemonBundle} — run rennet-desktop:build`);
    }
  });

  afterEach(async () => {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      await waitForClaimGone(dataDir);
      pid = undefined;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("a running daemon outlives its client and the relaunch reattaches to the same pid", async () => {
    dataDir = mkdtempSync(resolve(tmpdir(), "rennet-daemon-life-"));
    home = mkdtempSync(resolve(tmpdir(), "rennet-daemon-home-"));
    const before = readRealSettings();

    // First launch: the shell spawns the daemon exactly as ensureDaemon does — but pointed at
    // a throwaway HOME, because the daemon's settings stores live under `$HOME/.rennet`.
    spawnDaemon({
      dataDir,
      execPath: process.execPath,
      entryPath: daemonBundle,
      serverVersion: "test",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const first = await waitForHealthy(dataDir);
    pid = first.identity.pid;
    expect(pid).toBeGreaterThan(0);

    // Client #1 invokes a command over the wire, then the app "quits" (client closes).
    const launch1 = await bootstrapVia(first.identity.wsPort);
    expect(launch1.result).toHaveProperty("repositoryPresent");
    launch1.bridge.close();

    // App quit stops NOTHING: the daemon is still healthy at the same pid.
    const afterQuit = await findHealthyDaemon(dataDir);
    expect(afterQuit.kind).toBe("healthy");
    if (afterQuit.kind === "healthy") {
      expect(afterQuit.identity.pid).toBe(pid);

      // Relaunch: a fresh client reattaches to the SAME daemon and serves again.
      const launch2 = await bootstrapVia(afterQuit.identity.wsPort);
      expect(launch2.result).toHaveProperty("repositoryPresent");
      launch2.bridge.close();
    }

    // The developer's own config is untouched — the daemon wrote under the throwaway HOME.
    expect(readRealSettings()).toBe(before);
  }, 30_000);
});
