import {
  type LocusCommand,
  WslBundleDeliveryError,
  WslNodeNotFoundError,
  wslDaemonDataDir,
} from "@rennet/core";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
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
  /** Exit code the bundle's first required-file probe returns before delivery. */
  testExit: number;
  /** Set true once `cp` runs, so post-copy regular-file probes read present. */
  copied?: boolean;
  /** Set true once the copied Linux mover receives its required executable mode. */
  madeExecutable?: boolean;
  /** Set true only after the copied payload has passed every post-copy check. */
  completionMarker?: boolean;
  /** What `cat daemon.json` + `/healthz` currently reflect (null ⇒ no daemon). */
  daemon: FakeDaemon | null;
  /** Pids `kill` was asked to signal, in order. */
  killed: number[];
  /** Ordered lifecycle events ("stop"/"spawn") — only when a test wants to assert their order. */
  events?: string[];
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
              protocolVersion: PROTOCOL_VERSION,
              startedAt: "2026-08-20T00:00:00.000Z",
            }),
            code: 0,
          }
        : { stdout: "", code: 1 };
    }
    if (program === "test") {
      const isCompletionMarker = progArgs[1]?.endsWith("/.rennet-bundle-complete") === true;
      const code = isCompletionMarker
        ? state.completionMarker
          ? 0
          : 1
        : state.copied
          ? progArgs[0] === "-x" && !state.madeExecutable
            ? 1
            : 0
          : state.testExit;
      return { stdout: "", code };
    }
    if (program === "rm") {
      if (progArgs[0] !== "-f" || !progArgs[1]?.endsWith("/.rennet-bundle-complete")) {
        throw new Error(`unexpected rm arguments: ${joined}`);
      }
      state.completionMarker = false;
      return { stdout: "", code: 0 };
    }
    if (program === "mkdir") return { stdout: "", code: 0 };
    if (program === "wslpath") return { stdout: "/mnt/c/rennet/dist/server/index.cjs\n", code: 0 };
    if (program === "cp") {
      state.copied = true;
      return { stdout: "", code: 0 };
    }
    if (program === "chmod") {
      if (
        progArgs[0] !== "0755" ||
        !progArgs[1]?.endsWith("/native/linux-x64/rennet-exclusive-move")
      ) {
        throw new Error(`unexpected chmod arguments: ${joined}`);
      }
      state.madeExecutable = true;
      return { stdout: "", code: 0 };
    }
    if (program === "touch") {
      if (!progArgs[0]?.endsWith("/.rennet-bundle-complete")) {
        throw new Error(`unexpected touch arguments: ${joined}`);
      }
      state.completionMarker = true;
      return { stdout: "", code: 0 };
    }
    if (program === "kill") {
      const pid = Number(progArgs[0]);
      state.killed.push(pid);
      state.events?.push("stop");
      // A real kill removes the daemon; the wait-for-gone loop then sees it absent before spawn.
      if (state.daemon?.pid === pid) state.daemon = null;
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
        protocolVersion: PROTOCOL_VERSION,
        minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
      }),
    };
  };
}

/** A spawn recorder that makes the (now-current) daemon appear, as a real spawn would. */
function makeSpawn(state: FakeState, next: FakeDaemon) {
  return vi.fn(() => {
    state.events?.push("spawn");
    state.daemon = next;
    return { on: () => undefined, unref: () => undefined };
  });
}

function baseDeps(state: FakeState, spawn: ReturnType<typeof makeSpawn>) {
  return {
    serverVersion: "1.2.3",
    hostBundlePath: "C:\\Users\\rai\\rennet\\dist\\server\\index.cjs",
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

  it("reuses a healthy daemon on the shell's version — skips Node resolution AND delivery", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: { pid: 4242, wsPort: 52520, version: "1.2.3" },
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 9999, wsPort: 9999, version: "1.2.3" });
    // Record every wsl.exe command so we can prove the short-circuit ran NEITHER the Node
    // probe nor bundle delivery (both cost interactive wsl.exe execs) — not merely "no spawn".
    const seen: string[] = [];
    const baseRun = makeRun(state);
    const run: WslRunner = (cmd) => {
      seen.push(cmd.args.join(" "));
      return baseRun(cmd);
    };

    const handle = await ensureWslDaemon("Ubuntu", { ...baseDeps(state, spawn), run });

    expect(handle.port).toBe(52520);
    expect(spawn).not.toHaveBeenCalled();
    expect(state.killed).toEqual([]);
    const all = seen.join("\n");
    expect(all).not.toContain("getent passwd"); // no login-shell probe (Node resolution)
    expect(all).not.toContain("node -e"); // no Node binary probe
    expect(all).not.toContain("wslpath"); // no bundle delivery path translation
    expect(all).not.toContain("cp "); // no bundle copy
  });

  it("stops the old daemon, waits for it gone, then respawns — stop STRICTLY before spawn", async () => {
    const events: string[] = [];
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: { pid: 4242, wsPort: 51515, version: "0.0.9" }, // healthy, but stale version.
      killed: [],
      events,
    };
    const spawn = makeSpawn(state, { pid: 5555, wsPort: 51515, version: "1.2.3" });

    const handle = await ensureWslDaemon("Ubuntu", baseDeps(state, spawn));

    expect(state.killed).toEqual([4242]); // the old daemon, stopped by the pid its identity carried.
    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.identity.version).toBe("1.2.3"); // the returned identity is the NEW version.
    // Ordered log: the old daemon is stopped BEFORE the new one is spawned. A mutant that
    // spawned-then-stopped (or skipped the wait) reverses this and fails.
    expect(events).toEqual(["stop", "spawn"]);
  });

  it("yields the $HOME error and never spawns when the home probe exits nonzero", async () => {
    const state: FakeState = {
      home: "/home/u",
      node: "/usr/bin/node",
      testExit: 1,
      daemon: null,
      killed: [],
    };
    const spawn = makeSpawn(state, { pid: 1, wsPort: 1, version: "1.2.3" });
    // The home probe exits nonzero but flushed PARTIAL stdout — a real $HOME-looking path.
    // runString must DISCARD it (code !== 0 → ""), so parseWslHome → null → the home error,
    // never a half-read path fed onward to Node resolution or a spawn.
    const baseRun = makeRun(state);
    const run: WslRunner = (cmd) => {
      if (cmd.args.join(" ").includes("printf %s"))
        return Promise.resolve({ stdout: "/home/u", code: 1 });
      return baseRun(cmd);
    };

    await expect(ensureWslDaemon("Ubuntu", { ...baseDeps(state, spawn), run })).rejects.toThrow(
      /Could not resolve \$HOME/,
    );
    expect(spawn).not.toHaveBeenCalled();
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
  it("spawns the WSL daemon with a distro-native --data-dir (its token store), never the host dir", async () => {
    const home = "/home/u";
    const hostDataDir = "/Users/rai/.rennet";
    const state: FakeState = {
      home,
      node: "/usr/bin/node",
      testExit: 1,
      daemon: null,
      killed: [],
    };
    // Capture the ACTUAL launch descriptor the orchestrator hands the spawner, rather than
    // hand-building one — the `--data-dir` it really passes is what lands the token store, so
    // `createGitHubTokenStore(dataDir)` writes `github-token` INSIDE the distro. GitHub egress
    // and the stored credential both sit natively; nothing host-side touches it.
    let dataDirArg: string | undefined;
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      dataDirArg = args[args.indexOf("--data-dir") + 1];
      state.daemon = { pid: 5555, wsPort: 51515, version: "1.2.3" };
      return { on: () => undefined, unref: () => undefined };
    });

    await ensureWslDaemon("Ubuntu", {
      serverVersion: "1.2.3",
      hostBundlePath: "C:\\Users\\rai\\rennet\\dist\\server\\index.cjs",
      run: makeRun(state),
      spawn,
      fetch: makeFetch(state),
      now: () => 0,
      sleep: () => Promise.resolve(),
    });

    expect(dataDirArg).toBe(wslDaemonDataDir(home));
    expect(dataDirArg).toBe("/home/u/.local/share/rennet");
    expect(dataDirArg).not.toBe(hostDataDir);
    expect(dataDirArg?.includes("wsl.localhost")).toBe(false);
    expect(dataDirArg?.includes("wsl$")).toBe(false);
  });
});
