import {
  buildWslDaemonLaunch,
  type LocusCommand,
  WslBundleDeliveryError,
  WslNodeNotFoundError,
  wslDaemonDataDir,
} from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike, WslRunner } from "./wsl-daemon";
import { ensureWslDaemon } from "./wsl-supervisor";

// A daemon.json/`/healthz` identity as the fakes model it inside the distro.
interface FakeDaemon {
  pid: number;
  wsPort: number;
  version: string;
}

interface FakeState {
  home: string;
  /** The node binary the interactive probe prints (`""` ⇒ no Node in the distro). */
  node: string;
  /** Exit code the bundle `test -f` returns (1 = absent ⇒ deliver; 2 = probe failed). */
  testExit: number;
  /** What `cat daemon.json` + `/healthz` currently reflect (null ⇒ no daemon). */
  daemon: FakeDaemon | null;
  /** Pids `kill` was asked to signal, in order. */
  killed: number[];
}

/** Pull the program + its argv out of a `wsl.exe -d <distro> -e <program> <argv…>` command. */
function programOf(cmd: LocusCommand): { program: string; progArgs: string[] } {
  const i = cmd.args.indexOf("-e");
  return { program: cmd.args[i + 1] as string, progArgs: [...cmd.args.slice(i + 2)] as string[] };
}

/** A `{stdout, code}` runner that answers each probe the orchestrator issues from `state`. */
function makeRun(state: FakeState): WslRunner {
  return async (cmd) => {
    const { program, progArgs } = programOf(cmd);
    const joined = progArgs.join(" ");
    if (program === "sh" && joined.includes("printf %s")) return { stdout: state.home, code: 0 };
    if (program === "sh" && joined.includes("getent passwd"))
      return { stdout: "/bin/bash\n", code: 0 };
    if (joined.includes("node -e")) return { stdout: state.node, code: 0 };
    if (program === "cat") {
      const d = state.daemon;
      return d
        ? {
            stdout: JSON.stringify({
              pid: d.pid,
              wsPort: d.wsPort,
              version: d.version,
              protocolVersion: 1,
              startedAt: "2026-08-20T00:00:00.000Z",
            }),
            code: 0,
          }
        : { stdout: "", code: 1 };
    }
    if (program === "test") return { stdout: "", code: state.testExit };
    if (program === "mkdir") return { stdout: "", code: 0 };
    if (program === "wslpath") return { stdout: "/mnt/c/rennet/rennet.cjs\n", code: 0 };
    if (program === "cp") return { stdout: "", code: 0 };
    if (program === "kill") {
      state.killed.push(Number(progArgs[0]));
      return { stdout: "", code: 0 };
    }
    throw new Error(`unexpected wsl command: ${program} ${joined}`);
  };
}

/** `/healthz` fetch that returns `state.daemon`'s identity when the probed port matches. */
function makeFetch(state: FakeState): FetchLike {
  return async (url) => {
    const port = Number(url.match(/:(\d+)\//)?.[1] ?? 0);
    const d = state.daemon;
    if (!d || d.wsPort !== port) return { status: 503, json: async () => ({}) };
    return {
      status: 200,
      json: async () => ({
        pid: d.pid,
        wsPort: d.wsPort,
        version: d.version,
        protocolVersion: 1,
        minCompatibleProtocolVersion: 1,
      }),
    };
  };
}

/** A spawn recorder that makes the (now-current) daemon appear, as a real spawn would. */
function makeSpawn(state: FakeState, next: FakeDaemon) {
  return vi.fn(() => {
    state.daemon = next;
    return { on: () => undefined, unref: () => undefined };
  });
}

function baseDeps(state: FakeState, spawn: ReturnType<typeof makeSpawn>) {
  return {
    serverVersion: "1.2.3",
    hostBundlePath: "C:\\Users\\rai\\rennet\\rennet.cjs",
    run: makeRun(state),
    spawn,
    fetch: makeFetch(state),
    now: () => 0,
    sleep: () => Promise.resolve(),
  } as const;
}

describe("ensureWslDaemon (Group 3 orchestrator)", () => {
  it("delivers, spawns, and resolves the distro daemon's port on a cold distro", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: null,
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 5555, wsPort: 51515, version: "1.2.3" });

    const handle = await ensureWslDaemon("Ubuntu", baseDeps(state, spawn));

    expect(handle.port).toBe(51515);
    expect(handle.identity.version).toBe("1.2.3");
    expect(spawn).toHaveBeenCalledOnce();
    expect(state.killed).toEqual([]); // nothing to stop — no prior daemon.
  });

  it("reuses a healthy daemon already on the shell's version without spawning", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: { pid: 4242, wsPort: 52520, version: "1.2.3" },
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 9999, wsPort: 9999, version: "1.2.3" });

    const handle = await ensureWslDaemon("Ubuntu", baseDeps(state, spawn));

    expect(handle.port).toBe(52520);
    expect(spawn).not.toHaveBeenCalled();
    expect(state.killed).toEqual([]);
  });

  it("stops a version-skewed daemon by its pid, then respawns the current bundle", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: { pid: 4242, wsPort: 51515, version: "0.0.9" }, // healthy, but stale version.
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 5555, wsPort: 51515, version: "1.2.3" });

    const handle = await ensureWslDaemon("Ubuntu", baseDeps(state, spawn));

    expect(state.killed).toEqual([4242]); // the old daemon, stopped by the pid its identity carried.
    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.identity.version).toBe("1.2.3");
  });

  it("surfaces WslNodeNotFoundError plainly when the distro has no Node", async () => {
    const state: FakeState = { home: "/home/u", node: "", testExit: 1, daemon: null, killed: [] };
    const spawn = makeSpawn(state, { pid: 1, wsPort: 1, version: "1.2.3" });

    await expect(ensureWslDaemon("Ubuntu", baseDeps(state, spawn))).rejects.toBeInstanceOf(
      WslNodeNotFoundError,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("surfaces WslBundleDeliveryError plainly when delivery cannot place the bundle", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 2,
      daemon: null,
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 1, wsPort: 1, version: "1.2.3" });

    await expect(ensureWslDaemon("Ubuntu", baseDeps(state, spawn))).rejects.toBeInstanceOf(
      WslBundleDeliveryError,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("WSL secret store is distro-native (Group 4)", () => {
  it("points the WSL daemon's --data-dir (hence its token store) inside the distro, not the host dir", () => {
    const home = "/home/u";
    const hostDataDir = "/Users/rai/Library/Application Support/Rennet";
    const distroDataDir = wslDaemonDataDir(home);

    // The data dir the daemon owns is distro-native, distinct from the host dir, and not a 9P view.
    // The daemon's own `createGitHubTokenStore(dataDir)` therefore writes `github-token` INSIDE the
    // distro — GitHub egress and the stored credential both sit natively, nothing host-side touches it.
    expect(distroDataDir).toBe("/home/u/.local/share/rennet");
    expect(distroDataDir.startsWith("/home/")).toBe(true);
    expect(distroDataDir).not.toBe(hostDataDir);
    expect(distroDataDir.includes("wsl.localhost")).toBe(false);
    expect(distroDataDir.includes("wsl$")).toBe(false);

    const launch = buildWslDaemonLaunch({
      distro: "Ubuntu",
      nodePath: "/usr/bin/node",
      bundlePath: "/home/u/.rennet/server/1.2.3/rennet.cjs",
      dataDir: distroDataDir,
      serverVersion: "1.2.3",
    });
    expect(launch.args[launch.args.indexOf("--data-dir") + 1]).toBe(distroDataDir);
  });
});
