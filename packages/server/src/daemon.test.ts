import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateProcessPath } from "@rennet/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonStop,
  type DaemonConfig,
  type RunningDaemon,
  resolveDaemonConfig,
  STOP_WAIT_MS,
  startDaemon,
} from "./daemon";
import { readDaemonFile, writeDaemonFile } from "./daemon-file";

describe("daemon argument parsing", () => {
  it("parses the daemon entry's strict options", () => {
    expect(
      resolveDaemonConfig(["--data-dir", "/tmp/rennet", "--server-version=1.2.3"], {}),
    ).toMatchObject({ dataDir: "/tmp/rennet", serverVersion: "1.2.3" });
  });

  it("rejects an unknown option", () => {
    expect(() => resolveDaemonConfig(["--unknown"], {})).toThrow(/unknown option/i);
  });

  it("rejects a missing option value", () => {
    expect(() => resolveDaemonConfig(["--data-dir"], {})).toThrow(/argument missing/i);
  });
});

const CONFIG: DaemonConfig = { dataDir: "/tmp/rennet-acme", serverVersion: "1.2.2", env: {} };
const RUNNING: RunningDaemon = {
  info: { pid: 1, wsPort: 1, protocolVersion: 1, version: "1.2.2", startedAt: "" },
  stop: async () => undefined,
};

describe("startDaemon: skip mode reaches every daemon child (large-file-checkout)", () => {
  it("adds the skip-mode index include after the user's own command-line config, before the server runs", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "input",
    };
    const seenByRun: NodeJS.ProcessEnv[] = [];
    const run = vi.fn(async () => {
      seenByRun.push({ ...env });
      return RUNNING;
    });
    await startDaemon(CONFIG, { env, hydratePath: async () => undefined, run });
    expect(seenByRun[0]).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "input",
      GIT_CONFIG_KEY_1: "include.path",
      GIT_CONFIG_VALUE_1: join(CONFIG.dataDir, "large-files", "skip-checkouts.gitconfig"),
    });
    // No blanket override: a download-mode checkout's git sees the user's own filter.
    expect(Object.values(seenByRun[0] ?? {})).not.toContain("filter.lfs.required");
    expect(seenByRun[0]?.GIT_LFS_SKIP_SMUDGE).toBeUndefined();
  });
});

describe("startDaemon (daemon-process-environment)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("does not run the daemon until PATH is hydrated, so the server starts on the resolved PATH", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    let finishHydration: () => void = () => undefined;
    const hydratePath = vi.fn(
      (target: NodeJS.ProcessEnv) =>
        new Promise<void>((resolve) => {
          finishHydration = () => {
            target.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
            resolve();
          };
        }),
    );
    const pathSeenByRun: Array<string | undefined> = [];
    const run = vi.fn(async () => {
      pathSeenByRun.push(env.PATH);
      return RUNNING;
    });

    const started = startDaemon(CONFIG, { env, hydratePath, run });
    await Promise.resolve();
    // Hydration is still pending, so the server has not started on the bare PATH.
    expect(hydratePath).toHaveBeenCalledWith(env);
    expect(run).not.toHaveBeenCalled();

    finishHydration();
    await expect(started).resolves.toBe(RUNNING);
    expect(run).toHaveBeenCalledWith(CONFIG);
    expect(pathSeenByRun).toEqual(["/opt/homebrew/bin:/usr/bin:/bin"]);
  });

  it.skipIf(process.platform === "win32")(
    "started with PATH=/usr/bin:/bin, the daemon's children find a tool only the login shell knows",
    async () => {
      // A tool in a directory that is on the user's login-shell PATH and nowhere else, and a
      // login shell (a stub standing in for the user's zsh) that prints a banner first.
      dir = mkdtempSync(join(tmpdir(), "rennet-daemon-path-"));
      const toolDir = join(dir, "tools");
      mkdirSync(toolDir);
      writeFileSync(join(toolDir, "acme-lfs"), "#!/bin/sh\necho acme-lfs ok\n");
      chmodSync(join(toolDir, "acme-lfs"), 0o755);
      const shell = join(dir, "login-shell");
      writeFileSync(
        shell,
        `#!/bin/sh\necho "Welcome to acme-box"\nPATH=${toolDir}:/usr/bin:/bin exec /bin/sh -c "$2"\n`,
      );
      chmodSync(shell, 0o755);

      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell };
      // Before hydration the tool is unreachable, as it is for a Dock-launched daemon.
      expect(spawnSync("acme-lfs", { env: { ...env } }).error).toBeDefined();

      let childOutput: string | undefined;
      await startDaemon(CONFIG, {
        env,
        // The real resolver, against the stub login shell.
        hydratePath: (target) => hydrateProcessPath(target, { userShell: () => undefined }),
        run: async () => {
          // Stand-in for any git child the server spawns: it inherits the daemon's env.
          childOutput = spawnSync("acme-lfs", { env: { ...env }, encoding: "utf8" }).stdout.trim();
          return RUNNING;
        },
      });

      expect(childOutput).toBe("acme-lfs ok");
      expect(env.PATH?.split(":")[0]).toBe(toolDir);
      // The curated package-manager directories ride along after the inherited PATH.
      expect(env.PATH?.split(":")).toContain("/usr/local/bin");
    },
  );
});

describe("stopping the daemon removes its claim only once the shutdown has settled", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function claimed(): string {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-daemon-stop-"));
    dirs.push(dataDir);
    writeDaemonFile(dataDir, {
      pid: process.pid,
      wsPort: 4321,
      protocolVersion: 4,
      version: "1.2.2",
      startedAt: "",
    });
    return dataDir;
  }

  it("keeps daemon.json while the installers are still ending, and removes it when they have", async () => {
    const dataDir = claimed();
    let finish: () => void = () => undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const stop = createDaemonStop({ dataDir, pid: process.pid, shutdown });
    const stopping = stop();
    await Promise.resolve();
    // `rennet stop` reads the claim's disappearance as "stopped": not yet.
    expect(readDaemonFile(dataDir)?.pid).toBe(process.pid);
    finish();
    await stopping;
    expect(readDaemonFile(dataDir)).toBeNull();
    // One stop, however often it is asked for.
    expect(stop()).toBe(stopping);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("removes it at the backstop when a shutdown never settles", async () => {
    vi.useFakeTimers();
    const dataDir = claimed();
    const stop = createDaemonStop({
      dataDir,
      pid: process.pid,
      shutdown: () => new Promise<void>(() => undefined),
    });
    let stopped = false;
    void stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS - 1);
    expect(stopped).toBe(false);
    expect(readDaemonFile(dataDir)?.pid).toBe(process.pid);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(readDaemonFile(dataDir)).toBeNull();
  });
});
