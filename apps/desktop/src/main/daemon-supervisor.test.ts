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
  ensureDaemon,
  ensureDaemonForProject,
  isOwnedDaemonRunning,
  stopOwnedDaemon,
} from "./daemon-supervisor";

const claim: DaemonInfo = {
  pid: 4242,
  wsPort: 51000,
  protocolVersion: 1,
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
    await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "absent" }),
      removeClaim,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeClaim).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("NEVER signals a stale claim whose pid was reused — it removes the claim instead", async () => {
    // The claim names pid 4242, but /healthz did not confirm it: the process there may be an
    // unrelated program that reused the pid. Signalling it could kill someone else's process,
    // so tray Quit must remove the stale claim and signal nothing (review finding 2).
    const kill = vi.fn();
    const warn = vi.fn();
    const removeClaim = vi.fn();
    await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "stale", claim: { ...claim } }),
      removeClaim,
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeClaim).toHaveBeenCalledWith("/data", claim.pid);
    expect(warn).not.toHaveBeenCalled();
  });

  it("SIGTERMs the verified owned pid and returns cleanly once the claim clears", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: clearingReader(1), // present on the pre-kill read, gone on the first poll
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("also stops a verified-but-protocol-incompatible owned daemon", async () => {
    const kill = vi.fn();
    await stopOwnedDaemon("/data", {
      probe: async () => incompatibleVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: clearingReader(1),
      kill,
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
  });

  it("warns truthfully and returns when the claim never clears within the bounded wait", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    let clock = 0;
    await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => ({ ...claim }), // claim persists forever
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
  });

  it("treats a pid that raced to gone (ESRCH) as a clean stop and clears the claim", async () => {
    const warn = vi.fn();
    const removeClaim = vi.fn();
    await stopOwnedDaemon("/data", {
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
  });

  it("warns (but does not throw) when the kill fails for a reason other than ESRCH", async () => {
    const warn = vi.fn();
    await stopOwnedDaemon("/data", {
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
});

describe("ensureDaemonForProject (locus-selected routing)", () => {
  it("routes a host-locus project through today's ensureDaemon path, untouched", async () => {
    const ensureHostDaemon = vi.fn(async () => 40_100);
    const ensureWslDaemonSpy = vi.fn(async () => ({ port: 0 }));

    const port = await ensureDaemonForProject("/Users/rai/code/repo", "/host/data", {
      ensureHostDaemon,
      ensureWslDaemon: ensureWslDaemonSpy,
      ports: new Map(),
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
      ports: new Map(),
    });

    expect(port).toBe(40_200);
    expect(ensureWslDaemonSpy).not.toHaveBeenCalled();
  });

  it("spawns a WSL-locus project's distro daemon once and reuses its port on the next project", async () => {
    const ensureHostDaemon = vi.fn(async () => 1);
    const ensureWslDaemonSpy = vi.fn(async () => ({ port: 51_515 }));
    const ports = new Map<string, number>();
    const wslDeps = vi.fn(() => ({
      serverVersion: "1.2.3",
      hostBundlePath: "C:\\b",
      run: () => Promise.resolve({ stdout: "", code: 0 }),
    }));

    const first = await ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-a",
      "/host/data",
      {
        ensureHostDaemon,
        ensureWslDaemon: ensureWslDaemonSpy,
        wslDeps,
        ports,
      },
    );
    const second = await ensureDaemonForProject(
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-b",
      "/host/data",
      {
        ensureHostDaemon,
        ensureWslDaemon: ensureWslDaemonSpy,
        wslDeps,
        ports,
      },
    );

    expect(first).toBe(51_515);
    expect(second).toBe(51_515);
    expect(ensureWslDaemonSpy).toHaveBeenCalledTimes(1); // lazily spawned once, then reused.
    expect(ensureWslDaemonSpy).toHaveBeenCalledWith("Ubuntu", expect.anything());
    expect(ensureHostDaemon).not.toHaveBeenCalled();
    expect(ports.get("Ubuntu")).toBe(51_515);
  });
});
