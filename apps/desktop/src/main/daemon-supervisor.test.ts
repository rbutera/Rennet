import { EventEmitter } from "node:events";
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
  type DaemonChild,
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

/** A daemon that does not answer `POST /shutdown` — the ladder falls through to the signals. */
const noAck = async () => null;

/** A daemon that acks the shutdown as the pid the claim names (#820). */
function acksAs(info: DaemonInfo) {
  return async () => ({
    pid: info.pid,
    wsPort: info.wsPort,
    version: info.version,
    protocolVersion: info.protocolVersion,
    claimPath: "/data/daemon.json",
    shuttingDown: true as const,
  });
}

/** A fake `ChildProcess` handle: the two fields and two methods the supervisor uses. */
function fakeChild(pid: number) {
  const emitter = new EventEmitter();
  const child = {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    once: (event: "exit", listener: () => void) => emitter.once(event, listener),
    off: (event: "exit", listener: () => void) => emitter.off(event, listener),
    /** What the OS does when the process really goes: set the code, then emit. */
    exit(code = 0) {
      child.exitCode = code;
      emitter.emit("exit");
    },
  };
  return child;
}

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
      processState: () => "gone",
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
      processState: () => "running",
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

  it("asks the daemon to shut down, waits on the child it spawned, and never signals it", async () => {
    // The healthy path (#820): the ack says THIS pid heard the command, and the child's own
    // `exit` — not a pid probe — is what says it is gone. Sequence, not membership: the wait
    // must start after the ack, and the outcome must land after the exit.
    const order: string[] = [];
    const child = fakeChild(claim.pid);
    const kill = vi.fn();
    const stopping = stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => ({ ...claim }), // still there: only the child's exit ends this stop
      processState: () => "running", // and the pid still probes alive, as a zombie would
      requestShutdown: async () => {
        order.push("shutdown-request");
        return acksAs(claim)();
      },
      childFor: () => child,
      kill,
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    await vi.waitFor(() => expect(order).toEqual(["shutdown-request"]));
    order.push("child-exit");
    child.exit(0);
    expect(await stopping).toEqual({ kind: "stopped" });
    expect(order).toEqual(["shutdown-request", "child-exit"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops when the claim is gone and the pid is only a ZOMBIE (the #820 fixture)", async () => {
    // The shape that stranded the 0.6.5 → 0.7.0 update, with no child handle to wait on (the
    // daemon was inherited from an earlier app instance): the daemon exited cleanly and removed
    // its claim, but `kill(pid, 0)` still answers because nobody reaped it. A zombie holds no
    // port and no bundle, so this is a STOP, not a timeout.
    const warn = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => null,
      processState: () => "zombie",
      requestShutdown: acksAs(claim),
      childFor: () => undefined,
      kill: vi.fn(),
      warn,
      sleep: immediateSleep,
    });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("SIGTERMs the verified owned pid when it does not acknowledge, and returns once the claim clears", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: clearingReader(1), // present on the pre-kill read, gone on the first poll
      processState: () => "gone",
      requestShutdown: noAck,
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
      processState: () => "gone",
      requestShutdown: noAck,
      kill,
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("escalates request → SIGTERM → SIGKILL, in that order, and only then fails", async () => {
    const order: string[] = [];
    const warn = vi.fn();
    let clock = 0;
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => ({ ...claim }), // claim persists forever
      processState: () => "running", // and so does the process
      requestShutdown: async () => {
        order.push("request");
        return null;
      },
      kill: (_pid, signal) => {
        order.push(signal);
      },
      warn,
      sleep: immediateSleep,
      now: () => (clock += 1000), // advance 1s per read; each stage's deadline is 5s
      timeoutMs: 5_000,
    });
    expect(order).toEqual(["request", "SIGTERM", "SIGKILL"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(String(claim.pid));
    expect(outcome).toEqual({ kind: "failed", message: expect.stringContaining("SIGKILL") });
  });

  it("names the state it actually found instead of a process-or-daemon.json disjunction", async () => {
    // The 0.6.5 → 0.7.0 message said "its process or daemon.json is still present" while
    // daemon.json was absent and the process was a zombie, and sent the first look at the
    // wrong half. Each half now gets said, or not said, on its own.
    let clock = 0;
    const failure = await stopOwnedDaemon("/data", {
      probe: async () => healthyVerdict(claim),
      removeClaim: vi.fn(),
      readClaim: () => null, // daemon.json is GONE
      processState: () => "running", // …but a live process holds the port and the bundle
      requestShutdown: noAck,
      childFor: () => undefined,
      kill: vi.fn(),
      warn: vi.fn(),
      sleep: immediateSleep,
      now: () => (clock += 1000),
      timeoutMs: 5_000,
    });
    if (failure.kind !== "failed") throw new Error("expected the stop to fail");
    expect(failure.message).toContain("it is still running");
    expect(failure.message).not.toContain("daemon.json still names it");
    expect(failure.message).not.toContain(" or ");
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
      processState: () => (alive ? "running" : "gone"),
      requestShutdown: noAck,
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
      requestShutdown: noAck,
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
      requestShutdown: noAck,
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

  function info(
    pid: number,
    wsPort: number,
    protocolVersion = PROTOCOL_VERSION,
    version = "1.2.3",
  ): DaemonInfo {
    return {
      pid,
      wsPort,
      protocolVersion,
      version,
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
      requestShutdown: noAck,
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

  it("restarts a skewed daemon by ASKING it first, and signals nothing when it acknowledges", async () => {
    // Same command everywhere (#820, D): the skew restart is a shutdown too, and the daemon
    // that answers gets to drain its turns instead of taking a signal.
    const dataDir = makeDir();
    const old = info(334, 42_100, PROTOCOL_VERSION + 500);
    const spawned = info(445, 43_100);
    writeDaemonFile(dataDir, old);
    const order: string[] = [];
    const kill = vi.fn(() => order.push("kill"));
    const spawn = vi.fn(() => {
      order.push("spawn");
      writeDaemonFile(dataDir, spawned);
    });

    const port = await ensureDaemon(dataDir, {
      probe: async () => incompatibleVerdict(old),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      requestShutdown: async (wsPort) => {
        order.push(`shutdown:${wsPort}`);
        removeDaemonFile(dataDir, old.pid); // the daemon drops its claim on the way out
        return acksAs(old)();
      },
      kill,
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    expect(port).toBe(spawned.wsPort);
    expect(order).toEqual([`shutdown:${old.wsPort}`, "spawn"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("KEEPS the spawned child handle, and a later stop waits on it (#820)", async () => {
    // The discarded return value of `spawn` is the whole defect: Node reaps a child through
    // its process handle, so dropping it left the exited daemon a zombie that answered
    // `kill(pid, 0)` forever. This pins the pair — the ensure stores the handle, and the stop
    // for that data dir finds it and ends on its `exit` rather than on any probe.
    const dataDir = makeDir();
    const spawned = info(1234, 49_500);
    const children = new Map<string, DaemonChild>();
    const child = fakeChild(spawned.pid);

    await ensureDaemon(dataDir, {
      children,
      probe: async () => ({ kind: "absent" }),
      spawn: () => {
        writeDaemonFile(dataDir, spawned);
        return child;
      },
      waitForHealthy: async () => healthyVerdict(spawned),
      requestShutdown: noAck,
      kill: vi.fn(),
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    expect(children.get(dataDir)).toBe(child);

    const kill = vi.fn();
    const asked: string[] = [];
    const stopping = stopOwnedDaemon(dataDir, {
      probe: async () => healthyVerdict(spawned),
      removeClaim: vi.fn(),
      readClaim: readDaemonFile, // the claim is STILL on disk: only the exit ends this stop
      processState: () => "running",
      requestShutdown: async () => {
        asked.push("request");
        return acksAs(spawned)();
      },
      childFor: (dir) => children.get(dir),
      kill,
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    // Exit only once the stop has taken the handle out of the map and asked the daemon to go.
    await vi.waitFor(() => expect(asked).toEqual(["request"]));
    child.exit(0);

    expect(await stopping).toEqual({ kind: "stopped" });
    expect(kill).not.toHaveBeenCalled();
    // The handle is released with the process, so a later stop does not wait on a dead one.
    expect(children.has(dataDir)).toBe(false);
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

  it("restarts a HEALTHY older-version daemon, resolves on the NEW one, and ends the skew streak", async () => {
    // Field bug (lancelot, 2026-08-19): a healthy 0.2.14 daemon kept serving a 0.2.18 app
    // forever because only protocol skew triggered a restart, so shipped fixes never reached it.
    const dataDir = makeDir();
    const old = info(666, 45_000); // ships 1.2.3 while the app below ships 1.2.4
    const spawned = info(777, 46_000, PROTOCOL_VERSION, "1.2.4"); // the bundled daemon, ours
    writeDaemonFile(dataDir, old);
    const kill = vi.fn(() => removeDaemonFile(dataDir, old.pid));
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));
    const warn = vi.fn();
    // Two skew restarts already spent (one short of the cap), so the clean resolve below has a
    // streak to end. Without the clear, one skew today plus two next week bricks the data dir.
    const skewRestarts = new Map<string, number>([[dataDir, SKEW_RESTART_LIMIT - 1]]);

    const port = await ensureDaemon(dataDir, {
      probe: async () => healthyVerdict(old),
      spawn,
      waitForHealthy: async () => healthyVerdict(spawned),
      requestShutdown: noAck,
      kill,
      readClaim: readDaemonFile,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.4",
      env: {},
      warn,
      skewRestarts,
    });

    expect(kill).toHaveBeenCalledWith(old.pid, "SIGTERM");
    expect(spawn).toHaveBeenCalledOnce();
    // The port is the RESPAWNED daemon's, and the re-check let it through because its version
    // matched — not because the ensure stopped asking after the kill.
    expect(port).toBe(spawned.wsPort);
    expect(port).not.toBe(old.wsPort);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restarting the bundled daemon"));
    expect(readDaemonFile(dataDir)).toEqual(spawned);
    expect(skewRestarts.has(dataDir)).toBe(false);
  });

  it("re-checks the RESPAWNED daemon and retries in the SAME ensure when it comes back skewed", async () => {
    // The gap this closes: after the SIGTERM the ensure accepted whatever answered, on protocol
    // compatibility alone. A foreign 1.2.3 daemon that won the respawn race — the very daemon
    // whose skew triggered the restart — was handed to the renderer for the rest of the session.
    const dataDir = makeDir();
    const foreign = info(1001, 49_000); // 1.2.3; the app below ships 1.2.4
    const ours = info(1002, 49_100, PROTOCOL_VERSION, "1.2.4");
    const kill = vi.fn();
    const spawn = vi.fn();
    let healthyCalls = 0;
    const waitForHealthy = vi.fn(async () => {
      healthyCalls += 1;
      // The first respawn loses the race to the foreign daemon; the second wins.
      return healthyCalls === 1 ? healthyVerdict(foreign) : healthyVerdict(ours);
    });
    const skewRestarts = new Map<string, number>();

    const port = await ensureDaemon(dataDir, {
      probe: async () => healthyVerdict(foreign),
      spawn,
      waitForHealthy,
      requestShutdown: noAck,
      kill,
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.4",
      env: {},
      warn: vi.fn(),
      skewRestarts,
    });

    expect(port).toBe(ours.wsPort);
    expect(port).not.toBe(foreign.wsPort); // the skewed identity is never the answer
    // Two restarts inside ONE ensure — the retry is the loop, not a second caller.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(waitForHealthy).toHaveBeenCalledTimes(2);
    expect(skewRestarts.has(dataDir)).toBe(false); // resolved clean, so the streak is over
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

  it("caps a daemon that keeps coming back skewed, and never hands out its port", async () => {
    // The daemon at this dataDir is not ours and never becomes ours: the probe AND every
    // respawn answer on 1.2.3 while the app ships 1.2.4 (a second installation writing the same
    // claim). Left unbounded that is a SIGTERM-and-respawn storm (perf audit §2 H3); left
    // unchecked after the respawn it is worse — the renderer talks to the foreign daemon.
    const dataDir = makeDir();
    const foreign = info(999, 48_000);
    const kill = vi.fn();
    const spawn = vi.fn();
    const skewRestarts = new Map<string, number>();
    const deps = {
      probe: async () => healthyVerdict(foreign),
      spawn,
      waitForHealthy: async () => healthyVerdict(foreign),
      requestShutdown: noAck,
      kill,
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.4",
      env: {},
      warn: vi.fn(),
      skewRestarts,
    };

    // It REJECTS rather than resolving: there is no port here a caller may be given, and
    // `foreign.wsPort` is the one a version-blind ensure would have returned.
    await expect(ensureDaemon(dataDir, deps)).rejects.toThrow(join(dataDir, "daemon.log"));
    // The whole cap is spent inside that one ensure — one kill and one spawn per restart.
    expect(kill).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(spawn).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(skewRestarts.get(dataDir)).toBe(SKEW_RESTART_LIMIT);

    // A later open still refuses, and signals nothing more: the counts stand where they were.
    await expect(ensureDaemon(dataDir, deps)).rejects.toThrow(join(dataDir, "daemon.log"));
    expect(kill).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
    expect(spawn).toHaveBeenCalledTimes(SKEW_RESTART_LIMIT);
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

describe("start/stop serialization per dataDir (installer handoff safety)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-daemon-ops-"));
    dirs.push(dir);
    return dir;
  }

  function info(pid: number, wsPort: number): DaemonInfo {
    return {
      pid,
      wsPort,
      protocolVersion: PROTOCOL_VERSION,
      version: "1.2.3",
      startedAt: "2026-08-18T00:00:00.000Z",
    };
  }

  /** A gate a test opens by hand, so an op can be held mid-flight. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const wait = new Promise<void>((r) => {
      open = r;
    });
    return { wait, open };
  }

  it("holds a stop until an in-flight ensure has spawned AND health-verified the daemon", async () => {
    // The reviewer finding this exists for: `prepareOwnedDaemonForUpdate` probed `absent` while
    // an ensure was mid-spawn, reported "stopped", and the installer got a LIVE bundle-backed
    // daemon it had been told was gone.
    // BOTH phases are gated by hand. A lock released after the spawn but before the health poll
    // would still hand the installer a live daemon (the spawned process is up; only the ensure's
    // proof of it is missing), so this test fails unless the stop waits for `waitForHealthy`.
    const dataDir = makeDir();
    const spawned: DaemonInfo = info(777, 46_000);
    const ops = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const probeGate = gate();
    const healthGate = gate();

    const ensuring = ensureDaemon(dataDir, {
      ops,
      inFlight: new Map<string, Promise<number>>(),
      probe: async () => {
        await probeGate.wait;
        return { kind: "absent" };
      },
      spawn: () => {
        order.push("spawn");
      },
      waitForHealthy: async () => {
        await healthGate.wait;
        order.push("healthy");
        return healthyVerdict(spawned);
      },
      kill: vi.fn(),
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    // The stop arrives WHILE the ensure is parked in its probe.
    const stopping = stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => {
        order.push("stop-probe");
        return { kind: "absent" };
      },
      sleep: immediateSleep,
      warn: vi.fn(),
    });
    // Give the stop every chance to run early — it must not have probed yet.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);

    probeGate.open();
    // The daemon is SPAWNED and the ensure is parked in its health poll: still held.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["spawn"]);

    healthGate.open();
    expect(await ensuring).toBe(spawned.wsPort);
    expect(await stopping).toEqual({ kind: "stopped" });
    // Sequence, not membership: the whole ensure finished before the stop looked at the daemon.
    expect(order).toEqual(["spawn", "healthy", "stop-probe"]);
  });

  it("holds an ensure until an in-flight stop has SIGTERMed and watched the claim clear", async () => {
    // The reverse race: the installer handoff is underway and a project open (or the tray's
    // ensure) arrives. It must not spawn a daemon into the middle of the stop — and "the middle"
    // is mostly the window AFTER the SIGTERM, while the stop is still polling for the dying
    // daemon to drop its claim. A spawn there writes a fresh daemon.json over the one being
    // waited on, so the stop times out reporting failure while a live daemon runs.
    // This stop therefore has real work to finish (a healthy claim, a kill, a poll held open by
    // the test); an `absent` stop would return before the ensure could possibly interleave and
    // would pass no matter when the lock was released.
    const dataDir = makeDir();
    const dying: DaemonInfo = info(779, 46_200);
    const spawned: DaemonInfo = info(778, 46_100);
    const ops = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const claimGate = gate();
    let claimCleared = false;

    const stopping = stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => {
        order.push("stop-probe");
        return healthyVerdict(dying);
      },
      requestShutdown: noAck,
      kill: () => {
        order.push("stop-kill");
      },
      readClaim: () => (claimCleared ? null : dying),
      processState: () => (claimCleared ? "gone" : "running"),
      // The claim only clears when the TEST releases it, so the stop parks inside its poll.
      sleep: async () => {
        order.push("stop-poll");
        await claimGate.wait;
      },
      warn: vi.fn(),
    });

    const ensuring = ensureDaemon(dataDir, {
      ops,
      inFlight: new Map<string, Promise<number>>(),
      probe: async () => ({ kind: "absent" }),
      spawn: () => {
        order.push("spawn");
      },
      waitForHealthy: async () => healthyVerdict(spawned),
      kill: vi.fn(),
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    // Signalled and parked mid-poll: the ensure must not have spawned into that window.
    expect(order).toEqual(["stop-probe", "stop-kill", "stop-poll"]);

    claimCleared = true;
    claimGate.open();
    expect(await stopping).toEqual({ kind: "stopped" });
    expect(await ensuring).toBe(spawned.wsPort);
    expect(order).toEqual(["stop-probe", "stop-kill", "stop-poll", "spawn"]);
  });

  it("a REJECTED ensure does not wedge the chain for every later stop", async () => {
    // The chain's tail must settle either way. `ensureDaemon` is the op that genuinely rejects
    // (the skew cap, a probe that throws) — if its rejection stayed on the tail, the tray's
    // "Quit completely" and the installer handoff would both hang forever afterwards.
    const dataDir = makeDir();
    const ops = new Map<string, Promise<unknown>>();

    await expect(
      ensureDaemon(dataDir, {
        ops,
        inFlight: new Map<string, Promise<number>>(),
        probe: async () => {
          throw new Error("probe exploded");
        },
        spawn: vi.fn(),
        waitForHealthy: async () => healthyVerdict(info(781, 46_400)),
        kill: vi.fn(),
        readClaim: () => null,
        entryPath: "/bundle/server.cjs",
        execPath: "/electron",
        serverVersion: "1.2.3",
        env: {},
        warn: vi.fn(),
      }),
    ).rejects.toThrow("probe exploded");

    const stopped = await stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => ({ kind: "absent" }),
      sleep: immediateSleep,
      warn: vi.fn(),
    });
    expect(stopped).toEqual({ kind: "stopped" });
  });

  it("serializes per dataDir, not globally: an unrelated data dir is never held", async () => {
    const held = makeDir();
    const other = makeDir();
    const spawned: DaemonInfo = info(780, 46_300);
    const ops = new Map<string, Promise<unknown>>();
    const stopGate = gate();

    const stopping = stopOwnedDaemon(held, {
      ops,
      probe: async () => {
        await stopGate.wait;
        return { kind: "absent" };
      },
      sleep: immediateSleep,
      warn: vi.fn(),
    });

    // `other` resolves while `held` is still parked — a global lock would deadlock this await.
    const port = await ensureDaemon(other, {
      ops,
      inFlight: new Map<string, Promise<number>>(),
      probe: async () => ({ kind: "absent" }),
      spawn: vi.fn(),
      waitForHealthy: async () => healthyVerdict(spawned),
      kill: vi.fn(),
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });
    expect(port).toBe(spawned.wsPort);

    stopGate.open();
    expect(await stopping).toEqual({ kind: "stopped" });
  });
  it("does NOT fold a later ensure onto an in-flight one once a stop has been queued between them", async () => {
    // Ensure A is in flight, a stop lands behind it, then ensure B arrives. Single-flighting on
    // its own folds B onto A — A is still the in-flight entry — and B resolves with the port the
    // stop is about to kill. B must instead queue behind the stop and probe afresh.
    const dataDir = makeDir();
    const first: DaemonInfo = info(790, 46_500);
    const second: DaemonInfo = info(791, 46_600);
    const ops = new Map<string, Promise<unknown>>();
    const inFlight = new Map<string, Promise<number>>();
    const order: string[] = [];
    const probeGate = gate();
    let probes = 0;
    let spawns = 0;
    const ensureDeps = {
      ops,
      inFlight,
      probe: async (): Promise<DaemonVerdict> => {
        probes += 1;
        // A parks here so the stop and B both arrive while it is in flight.
        if (probes === 1) await probeGate.wait;
        order.push(`ensure-probe-${probes}`);
        return { kind: "absent" };
      },
      spawn: () => {
        spawns += 1;
        order.push(`spawn-${spawns}`);
      },
      waitForHealthy: async () => healthyVerdict(spawns === 1 ? first : second),
      kill: vi.fn(),
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    };

    const ensuringA = ensureDaemon(dataDir, ensureDeps);
    const stopping = stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => {
        order.push("stop-probe");
        return { kind: "absent" };
      },
      sleep: immediateSleep,
      warn: vi.fn(),
    });
    const ensuringB = ensureDaemon(dataDir, ensureDeps);

    probeGate.open();
    expect(await ensuringA).toBe(first.wsPort);
    expect(await stopping).toEqual({ kind: "stopped" });
    // The load-bearing assertion: B answers with ITS daemon's port, not the one the stop killed.
    expect(await ensuringB).toBe(second.wsPort);
    expect(order).toEqual(["ensure-probe-1", "spawn-1", "stop-probe", "ensure-probe-2", "spawn-2"]);
  });

  it("leaves the in-flight entry to the ensure that refused to fold, so a third caller still folds", async () => {
    // The other half of the no-fold-across-a-stop rule: once B refuses to fold, B OWNS the
    // in-flight entry. A's `finally` must clear the map only while the entry is still A's.
    // Clearing it unconditionally strands B — a third caller arriving while B is mid-probe
    // reads an empty map and queues a THIRD probe-and-spawn behind it, which is the very
    // double-spawn single-flighting exists to stop.
    const dataDir = makeDir();
    const first: DaemonInfo = info(794, 46_900);
    const second: DaemonInfo = info(795, 47_100);
    const ops = new Map<string, Promise<unknown>>();
    const inFlight = new Map<string, Promise<number>>();
    const probeGateA = gate();
    const probeGateB = gate();
    let probes = 0;
    let spawns = 0;
    const ensureDeps = {
      ops,
      inFlight,
      probe: async (): Promise<DaemonVerdict> => {
        probes += 1;
        // A parks so the stop and B both arrive behind it; B parks so it is still IN FLIGHT
        // when the third caller asks — the only window in which folding is even possible.
        if (probes === 1) await probeGateA.wait;
        if (probes === 2) await probeGateB.wait;
        return { kind: "absent" };
      },
      spawn: () => {
        spawns += 1;
      },
      waitForHealthy: async () => healthyVerdict(spawns === 1 ? first : second),
      kill: vi.fn(),
      readClaim: () => null,
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    };

    const ensuringA = ensureDaemon(dataDir, ensureDeps);
    const stopping = stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => ({ kind: "absent" }),
      sleep: immediateSleep,
      warn: vi.fn(),
    });
    const ensuringB = ensureDaemon(dataDir, ensureDeps);

    probeGateA.open();
    // Awaiting A's returned promise runs its `finally` — the statement under test — before the
    // third caller below ever asks.
    expect(await ensuringA).toBe(first.wsPort);
    expect(await stopping).toEqual({ kind: "stopped" });

    const ensuringC = ensureDaemon(dataDir, ensureDeps);
    probeGateB.open();
    expect(await ensuringB).toBe(second.wsPort);
    expect(await ensuringC).toBe(second.wsPort);
    // The load-bearing pair: C joined B rather than starting a generation of its own.
    expect(probes).toBe(2);
    expect(spawns).toBe(2);
    expect(inFlight.has(dataDir)).toBe(false); // …and B cleared its own entry on the way out.
  });

  it("keeps a queued stop out of a skew restart's kill→respawn window", async () => {
    // A skew restart is a kill, a bounded wait for the dead daemon's claim to clear, then a
    // spawn — the one ensure path that signals a process itself. A stop probing inside that
    // window reads `absent` (old daemon gone, new one not spawned yet) and reports "stopped"
    // while a respawn is already coming: the installer-handoff lie the chain exists to prevent.
    // It spends the LAST restart the cap allows, so the capped path is the one interleaved.
    const dataDir = makeDir();
    const skewed: DaemonInfo = { ...info(792, 46_700), version: "0.0.1" };
    const fresh: DaemonInfo = info(793, 46_800);
    const ops = new Map<string, Promise<unknown>>();
    const skewRestarts = new Map<string, number>([[dataDir, SKEW_RESTART_LIMIT - 1]]);
    const order: string[] = [];
    let claimCleared = false;

    const ensuring = ensureDaemon(dataDir, {
      ops,
      inFlight: new Map<string, Promise<number>>(),
      skewRestarts,
      probe: async () => {
        order.push("ensure-probe");
        return healthyVerdict(skewed);
      },
      spawn: () => {
        order.push("spawn");
      },
      waitForHealthy: async () => healthyVerdict(fresh),
      requestShutdown: noAck,
      kill: () => {
        order.push("kill");
      },
      // Held by the test: the ensure sits in `waitForClaimGone` until the claim goes.
      readClaim: () => (claimCleared ? null : skewed),
      entryPath: "/bundle/server.cjs",
      execPath: "/electron",
      serverVersion: "1.2.3",
      env: {},
      warn: vi.fn(),
    });

    const stopping = stopOwnedDaemon(dataDir, {
      ops,
      probe: async () => {
        order.push("stop-probe");
        return { kind: "absent" };
      },
      sleep: immediateSleep,
      warn: vi.fn(),
    });

    // Signalled, and parked waiting for the claim: nothing respawned, nothing stopped.
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["ensure-probe", "kill"]);

    claimCleared = true;
    expect(await ensuring).toBe(fresh.wsPort);
    expect(await stopping).toEqual({ kind: "stopped" });
    expect(order).toEqual(["ensure-probe", "kill", "spawn", "stop-probe"]);
    // Spent, then forgiven: the cap counts CONSECUTIVE restarts and this ensure ended healthy.
    expect(skewRestarts.get(dataDir)).toBeUndefined();
  });
});

describe("stopOwnedDaemon stops the owned T3 sidecar AFTER the daemon (t3code-sidecar-chat)", () => {
  it("signals the daemon first, then runs the sidecar step, and still reports the daemon outcome", async () => {
    const order: string[] = [];
    let claimPresent = true;
    let alive = true;
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "healthy", claim: { ...claim }, identity: {} as never }),
      readClaim: () => (claimPresent ? { ...claim } : null),
      processState: () => (alive ? "running" : "gone"),
      requestShutdown: noAck,
      kill: () => {
        order.push("daemon:SIGTERM");
        claimPresent = false;
        alive = false;
      },
      stopSidecar: async () => {
        order.push("sidecar:stop");
        return { kind: "stopped" };
      },
      warn: vi.fn(),
      sleep: immediateSleep,
    });
    expect(order).toEqual(["daemon:SIGTERM", "sidecar:stop"]);
    expect(outcome).toEqual({ kind: "stopped" });
  });

  it("reaps a sidecar even when no daemon is owned, and logs a sidecar that will not exit", async () => {
    const warn = vi.fn();
    const stopSidecar = vi.fn(async () => ({ kind: "timeout" as const, pid: 4242 }));
    const outcome = await stopOwnedDaemon("/data", {
      probe: async () => ({ kind: "absent" }),
      stopSidecar,
      warn,
      sleep: immediateSleep,
    });
    expect(stopSidecar).toHaveBeenCalledWith("/data");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("T3 sidecar pid 4242"));
    // Positive control: the daemon outcome is unchanged by the sidecar step.
    expect(outcome).toEqual({ kind: "stopped" });
  });
});
