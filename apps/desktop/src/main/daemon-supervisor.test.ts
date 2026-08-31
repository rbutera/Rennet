import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
import {
  type DaemonInfo,
  type DaemonVerdict,
  readDaemonFile,
  removeDaemonFile,
  writeDaemonFile,
} from "@rennet/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/Rennet.app/Contents/Resources/app.asar",
    getVersion: () => "1.2.3",
    isPackaged: false,
  },
}));

import {
  createWslRunner,
  ensureDaemon,
  ensureDaemonForProject,
  isOwnedDaemonRunning,
  prepareOwnedDaemonForUpdate,
  SKEW_RESTART_LIMIT,
  stopOwnedDaemon,
} from "./daemon-supervisor";

const claim: DaemonInfo = {
  pid: 4242,
  wsPort: 51000,
  protocolVersion: PROTOCOL_VERSION,
  version: "0.2.0",
  startedAt: "2026-08-19T00:00:00.000Z",
};

function healthyVerdict(info: DaemonInfo): Extract<DaemonVerdict, { kind: "healthy" }> {
  return {
    kind: "healthy",
    claim: info,
    identity: {
      pid: info.pid,
      wsPort: info.wsPort,
      version: info.version,
      protocolVersion: info.protocolVersion,
      minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
    },
  };
}

function incompatibleVerdict(info: DaemonInfo): DaemonVerdict {
  return {
    kind: "incompatible",
    claim: info,
    identity: {
      pid: info.pid,
      wsPort: info.wsPort,
      version: info.version,
      protocolVersion: info.protocolVersion,
      minCompatibleProtocolVersion: info.protocolVersion,
    },
    reason: "test skew",
  };
}

const immediateSleep = () => Promise.resolve();

// A readClaim that returns `claim` for the first `liveReads` calls, then null (claim cleared).
function clearingReader(liveReads: number) {
  let n = 0;
  return () => (n++ < liveReads ? { ...claim } : null);
}

describe("stopOwnedDaemon (tray Quit completely — health-verified)", () => {
  it("is a no-op when nothing is owned (probe: absent)", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    const removeClaim = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "absent" }),
      removeClaim,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeClaim).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("removes a stale claim only when its pid is dead", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    const removeClaim = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "stale", claim: { ...claim } }),
      isAlive: () => false,
      removeClaim,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeClaim).toHaveBeenCalledWith("/data", claim.pid);
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("does not signal or remove a stale claim while its pid is still alive", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    const removeClaim = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "stale", claim: { ...claim } }),
      isAlive: () => true,
      removeClaim,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeClaim).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be health-verified"));
    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("refusing to signal it or start the installer"),
    });
  });

  it("SIGTERMs the verified owned pid and returns cleanly once the claim clears", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: clearingReader(1), // present on the pre-kill read, gone on the first poll
      isAlive: () => false,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("also stops a verified-but-protocol-incompatible owned daemon", async () => {
    const kill = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => incompatibleVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: clearingReader(1),
      isAlive: () => false,
      kill,
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("warns truthfully and returns when the claim never clears within the bounded wait", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    let clock = 0;
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => ({ ...claim }), // claim persists forever
      isAlive: () => true,
      kill,
      warn,
      sleep: immediateSleep,
      now: () => (clock += 1000), // advance 1s per read; deadline is 5s
      timeoutMs: 5_000,
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("still present");
    expect(warn.mock.calls[0]?.[0]).toContain(String(claim.pid));
    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("still present"),
    });
  });

  it("waits for the verified daemon pid to exit after its claim clears", async () => {
    let alive = true;
    const sleep = vi.fn(async () => {
      alive = false;
    });
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => null,
      isAlive: () => alive,
      kill: vi.fn(),
      warn: vi.fn(),
      sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("treats a pid that raced to gone (ESRCH) as a clean stop and clears the claim", async () => {
    const warn = vi.fn();
    const removeClaim = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim,
      kill: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
      warn,
      sleep: immediateSleep,
    });
    expect(removeClaim).toHaveBeenCalledWith("/data", claim.pid);
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("warns (but does not throw) when the kill fails for a reason other than ESRCH", async () => {
    const warn = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      kill: () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
      warn,
      sleep: immediateSleep,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("failed to signal");
    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("failed to signal"),
    });
  });

  it("returns a typed failure when ownership cannot be verified", async () => {
    const warn = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => {
        throw new Error("health endpoint unavailable");
      },
      warn,
    });
    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining("health endpoint unavailable"),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to verify"));
  });
});

describe("prepareOwnedDaemonForUpdate", () => {
  it("releases the installer handoff only after a verified stop", async () => {
    const stop = vi.fn(async () => ({ kind: "stopped" }) as const);
    await expect(prepareOwnedDaemonForUpdate("/data", stop)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledWith("/data");
  });

  it("refuses the installer handoff when the bundled daemon still owns the app", async () => {
    const stop = vi.fn(
      async () =>
        ({
          kind: "failed",
          message: "daemon.json is still present",
        }) as const,
    );
    await expect(prepareOwnedDaemonForUpdate("/data", stop)).rejects.toThrow(
      "daemon.json is still present",
    );
  });
});

describe("isOwnedDaemonRunning (truthful, health-verified quit-label state)", () => {
  it("true when the probe verifies a healthy owned daemon", async () => {
    expect(await isOwnedDaemonRunning("/data", async () => healthyVerdict(claim))).toBe(true);
  });

  it("true for a verified-but-incompatible daemon (identity matched, still owned)", async () => {
    expect(await isOwnedDaemonRunning("/data", async () => incompatibleVerdict(claim))).toBe(true);
  });

  it("false for a stale claim (pid did not answer /healthz — never trust the claim alone)", async () => {
    expect(await isOwnedDaemonRunning("/data", async () => ({ kind: "stale", claim }))).toBe(false);
  });

  it("false when there is no claim (attached remote only)", async () => {
    expect(await isOwnedDaemonRunning("/data", async () => ({ kind: "absent" }))).toBe(false);
  });
});

describe("desktop daemon supervision (ensureDaemon)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-daemon-supervisor-"));
    dirs.push(dir);
    return dir;
  }

  function info(pid: number, wsPort: number, protocolVersion = PROTOCOL_VERSION): DaemonInfo {
    return {
      pid,
      wsPort,
      protocolVersion,
      version: "1.2.3",
      startedAt: "2026-08-18T00:00:00.000Z",
    };
  }

  it("takes over a dead-pid claim, publishes the spawned claim, and preserves it from late cleanup", async () => {
    const dataDir = makeDir();
    const stale = info(111, 40_000);
    const spawned = info(222, 41_000);
    writeDaemonFile(dataDir, stale);
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));

    const port = await ensureDaemon(dataDir, {
      probe: async () => ({ kind: "stale", claim: stale }),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      kill: vi.fn(),
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    expect(port).toBe(spawned.wsPort);
    expect(spawn).toHaveBeenCalledOnce();
    expect(readDaemonFile(dataDir)).toEqual(spawned);
    expect(removeDaemonFile(dataDir, stale.pid)).toBe(false);
    expect(readDaemonFile(dataDir)).toEqual(spawned);
  });

  it("gives the spawned daemon thread-pool headroom and drops the shell data-dir override", async () => {
    const dataDir = makeDir();
    const stale = info(112, 40_500);
    const spawned = info(223, 41_500);
    writeDaemonFile(dataDir, stale);
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));

    await ensureDaemon(dataDir, {
      probe: async () => ({ kind: "stale", claim: stale }),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      kill: vi.fn(),
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: { RENNET_USER_DATA: "/shell/override", PATH: "/usr/bin" },
      warn: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledOnce();
    const calls = spawn.mock.calls as unknown as Array<[{ env: NodeJS.ProcessEnv }]>;
    const options = calls[0]?.[0];
    expect(options).toBeDefined();
    const passedEnv: NodeJS.ProcessEnv = options?.env ?? {};
    expect(passedEnv.UV_THREADPOOL_SIZE).toBe("16");
    expect(passedEnv.RENNET_USER_DATA).toBeUndefined();
    expect(passedEnv.PATH).toBe("/usr/bin");
  });

  it("kills an incompatible daemon, spawns the bundled daemon, and preserves the new claim", async () => {
    const dataDir = makeDir();
    const old = info(333, 42_000, PROTOCOL_VERSION + 500);
    const spawned = info(444, 43_000);
    writeDaemonFile(dataDir, old);
    const kill = vi.fn(() => removeDaemonFile(dataDir, old.pid));
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));

    const port = await ensureDaemon(dataDir, {
      probe: async () => incompatibleVerdict(old),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      kill,
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    expect(port).toBe(spawned.wsPort);
    expect(kill).toHaveBeenCalledWith(old.pid, "SIGTERM");
    expect(spawn).toHaveBeenCalledOnce();
    expect(removeDaemonFile(dataDir, old.pid)).toBe(false);
    expect(readDaemonFile(dataDir)).toEqual(spawned);
  });

  it("attaches to a healthy daemon whose server version matches the app", async () => {
    const dataDir = makeDir();
    const current = info(555, 44_000);
    writeDaemonFile(dataDir, current);
    const spawn = vi.fn();
    const kill = vi.fn();

    const port = await ensureDaemon(dataDir, {
      probe: async () => healthyVerdict(current),
      spawn,
      waitForHealthy: async () => healthyVerdict(current),
      kill,
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    expect(port).toBe(current.wsPort);
    expect(spawn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("restarts a HEALTHY daemon running an older server version — the daemon updates with the app", async () => {
    // Field bug (lancelot, 2026-08-19): a healthy 0.2.14 daemon kept serving a 0.2.18 app
    // forever because only protocol skew triggered a restart, so shipped fixes never reached it.
    const dataDir = makeDir();
    const old = info(666, 45_000);
    const spawned = info(777, 46_000);
    writeDaemonFile(dataDir, old);
    const kill = vi.fn(() => removeDaemonFile(dataDir, old.pid));
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));
    const warn = vi.fn();

    const port = await ensureDaemon(dataDir, {
      probe: async () => healthyVerdict(old),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      kill,
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.4",
      env: {},
      warn,
    });

    expect(kill).toHaveBeenCalledWith(old.pid, "SIGTERM");
    expect(spawn).toHaveBeenCalledOnce();
    expect(port).toBe(spawned.wsPort);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restarting the bundled daemon"));
    expect(readDaemonFile(dataDir)).toEqual(spawned);
  });

  it("folds two concurrent ensures for one dataDir into ONE probe and ONE spawn", async () => {
    // Without this, two renderer `resolveDaemonForPath` calls both read `absent` and both spawn,
    // and the two daemons race over daemon.json (perf audit §2 H3).
    const dataDir = makeDir();
    const spawned = info(888, 47_000);
    const inFlight = new Map<string, Promise<number>>();
    let releaseProbe: () => void = () => undefined;
    const probeGate = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const probe = vi.fn(async (): Promise<DaemonVerdict> => {
      await probeGate;
      return { kind: "absent" };
    });
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));
    const deps = {
      probe,
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      kill: vi.fn(),
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
      inFlight,
    };

    // Both ensures start before the probe settles; the second must join the in-flight one.
    const first = ensureDaemon(dataDir, deps);
    const second = ensureDaemon(dataDir, deps);
    releaseProbe();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(spawned.wsPort);
    expect(b).toBe(spawned.wsPort);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(inFlight.has(dataDir)).toBe(false); // cleared once settled

    // …and the fold is IN-FLIGHT only: a later ensure re-probes rather than reusing a port.
    await ensureDaemon(dataDir, deps);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stops restarting a daemon that keeps coming back skewed once the cap is spent", async () => {
    // A daemon that keeps reappearing on the wrong version would otherwise be SIGTERMed and
    // respawned on every project open, forever (perf audit §2 H3).
    const dataDir = makeDir();
    const old = info(999, 48_000); // version 1.2.3 while the app below ships 1.2.4 → skew, always
    const kill = vi.fn();
    const spawn = vi.fn();
    const skewRestarts = new Map<string, number>();
    const deps = {
      probe: async () => healthyVerdict(old),
      spawn,
      waitForHealthy: async () => healthyVerdict(old),
      kill,
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.4",
      env: {},
      warn: vi.fn(),
      skewRestarts,
    };

    for (let attempt = 0; attempt < SKEW_RESTART_LIMIT; attempt += 1) {
      expect(await ensureDaemon(dataDir, deps)).toBe(old.wsPort);
    }
    expect(kill).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(spawn).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);

    await expect(ensureDaemon(dataDir, deps)).rejects.toThrow(join(dataDir, "daemon.log"));
    // The capped attempt signalled and spawned NOTHING — the counts stand where they were.
    expect(kill).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(spawn).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(skewRestarts.get(dataDir)).toBe(SKEW_RESTART_LIMIT);
  });
});

describe("ensureDaemonForProject (locus-selected routing)", () => {
  it("routes a host-locus project through today's ensureDaemon path, untouched", async () => {
    const ensureHostDaemon = vi.fn(async () => 40_100);
    const ensureWslDaemonSpy = vi.fn(async () => ({ port: 0 }));

    const port = await ensureDaemonForProject("/Users/rai/code/repo", "/host/data", {
      ensureHostDaemon,
      ensureWslDaemon: ensureWslDaemonSpy,
      inFlight: new Map(),
    });

    expect(port).toBe(40_100);
    expect(ensureHostDaemon).toHaveBeenCalledWith("/host/data");
    expect(ensureWslDaemonSpy).not.toHaveBeenCalled(); // no WSL code runs for a host project.
  });

  it("treats a Windows drive path as host-locus (no distro daemon)", async () => {
    const ensureHostDaemon = vi.fn(async () => 40_200);
    const ensureWslDaemonSpy = vi.fn(async () => ({ port: 0 }));

    const port = await ensureDaemonForProject("C:\\Users\\rai\\repo", "/host/data", {
      ensureHostDaemon,
      ensureWslDaemon: ensureWslDaemonSpy,
      inFlight: new Map(),
    });

    expect(port).toBe(40_200);
    expect(ensureWslDaemonSpy).not.toHaveBeenCalled();
  });

  const wslDeps = () => ({
    serverVersion: "1.2.3",
    hostBundlePath: "C:\\b",
    run: () => Promise.resolve({ stdout: "", code: 0 }),
  });

  it("RE-ENSURES a WSL-locus distro daemon on each sequential open — no stale port cache", async () => {
    const ensureHostDaemon = vi.fn(async () => 1);
    const ensureWslDaemonSpy = vi.fn(async () => ({ port: 51_515 }));
    const inFlight = new Map<string, Promise<number>>();

    const first = await ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-a",
      "/host/data",
      { ensureHostDaemon, ensureWslDaemon: ensureWslDaemonSpy, wslDeps, inFlight },
    );
    const second = await ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-b",
      "/host/data",
      { ensureHostDaemon, ensureWslDaemon: ensureWslDaemonSpy, wslDeps, inFlight },
    );

    expect(first).toBe(51_515);
    expect(second).toBe(51_515); // both get a healthy port
    // No stale cache: each sequential open re-ensures. `ensureWslDaemon` self-short-circuits
    // when a healthy same-version daemon already runs, so this is cheap and self-healing.
    expect(ensureWslDaemonSpy).toHaveBeenCalledTimes(2);
    expect(ensureWslDaemonSpy).toHaveBeenCalledWith("Ubuntu", expect.anything());
    expect(ensureHostDaemon).not.toHaveBeenCalled();
    expect(inFlight.has("Ubuntu")).toBe(false); // entry cleared once each open settled
  });

  it("folds two CONCURRENT opens on the same distro into ONE ensureWslDaemon (single-flight)", async () => {
    let resolveEnsure: (value: { port: number }) => void = () => undefined;
    const ensureWslDaemonSpy = vi.fn(
      () =>
        new Promise<{ port: number }>((r) => {
          resolveEnsure = r;
        }),
    );
    const inFlight = new Map<string, Promise<number>>();
    const deps = {
      ensureHostDaemon: vi.fn(async () => 1),
      ensureWslDaemon: ensureWslDaemonSpy,
      wslDeps,
      inFlight,
    };

    // Both opens start before the first ensure settles; the second must join the in-flight one.
    const p1 = ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-a",
      "/host/data",
      deps,
    );
    const p2 = ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-b",
      "/host/data",
      deps,
    );
    resolveEnsure({ port: 51_515 });
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(51_515);
    expect(b).toBe(51_515);
    expect(ensureWslDaemonSpy).toHaveBeenCalledTimes(1); // the second concurrent open joined the first
    expect(inFlight.has("Ubuntu")).toBe(false); // cleared once settled
  });
});

describe("createWslRunner (real short-lived process → {stdout, code}, never throws)", () => {
  const run = createWslRunner();

  it("resolves stdout with code 0 for a successful command", async () => {
    const { stdout, code } = await run({
      file: process.execPath,
      args: ["-e", "process.stdout.write('hi')"],
    });
    expect(code).toBe(0);
    expect(stdout).toBe("hi");
  });

  it("maps a nonzero process exit to that exact code", async () => {
    const { code } = await run({ file: process.execPath, args: ["-e", "process.exit(3)"] });
    expect(code).toBe(3);
  });

  it("maps a spawn failure (nonexistent file) to a nonzero code without throwing", async () => {
    const { stdout, code } = await run({ file: "/nonexistent/definitely-not-here", args: [] });
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
  });
});
