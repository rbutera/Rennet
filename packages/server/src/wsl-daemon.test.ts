import { type LocusCommand, WSL_EXE, type WslRunResult } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import type { DaemonInfo } from "./daemon-file";
import type { DaemonIdentity } from "./ws-listener";
import {
  probeWslDaemonHealth,
  readWslDaemonPort,
  spawnWslDaemon,
  stopWslDaemon,
  waitForWslDaemon,
} from "./wsl-daemon";

const LOCATION = { distro: "Ubuntu", distroDataDir: "/home/rai/.local/share/rennet" } as const;
const DAEMON_JSON = `${LOCATION.distroDataDir}/daemon.json`;
const HEALTHZ = "http://localhost:51987/healthz";

/** A runner that returns scripted results by index and THROWS on any unscripted call. */
function recorder(results: readonly WslRunResult[]) {
  const calls: LocusCommand[] = [];
  const run = async (command: LocusCommand): Promise<WslRunResult> => {
    const result = results[calls.length];
    if (result === undefined) {
      throw new Error(
        `unscripted run() call #${calls.length + 1}: ${JSON.stringify(command.args)}`,
      );
    }
    calls.push(command);
    return result;
  };
  return { calls, run };
}

const CLAIM: DaemonInfo = {
  pid: 4242,
  wsPort: 51987,
  protocolVersion: 3,
  version: "0.3.12",
  startedAt: "2026-08-20T00:00:00.000Z",
};

const IDENTITY: DaemonIdentity = {
  pid: 4242,
  wsPort: 51987,
  version: "0.3.12",
  protocolVersion: 3,
  minCompatibleProtocolVersion: 1,
};

/** A fetch fake that answers one scripted URL and throws on any other. */
function fakeFetch(url: string, response: { status: number; body?: unknown }) {
  return vi.fn(async (input: string) => {
    if (input !== url) throw new Error(`unexpected fetch: ${input}`);
    return { status: response.status, json: async () => response.body };
  });
}

describe("spawnWslDaemon", () => {
  const launch: LocusCommand = {
    file: WSL_EXE,
    args: [
      "-d",
      "Ubuntu",
      "-e",
      "/usr/bin/node",
      "/home/rai/.rennet/server/0.3.12/rennet.cjs",
      "serve",
      "--data-dir",
      "/home/rai/.local/share/rennet",
    ],
  };

  it("spawns detached with ignored stdio and unrefs, passing the full launch descriptor", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawner = vi.fn(() => child);

    spawnWslDaemon(launch, { spawn: spawner });

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(spawner).toHaveBeenCalledWith(launch.file, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("owns an async spawn error (logs, never throws or crashes the host)", () => {
    let onError: ((error: Error) => void) | undefined;
    const child = {
      on: vi.fn((event: string, cb: (error: Error) => void) => {
        if (event === "error") onError = cb;
      }),
      unref: vi.fn(),
    };
    const spawner = vi.fn(() => child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    spawnWslDaemon(launch, { spawn: spawner });

    expect(onError).toBeDefined();
    // Emitting the async spawn failure must not throw (it would otherwise crash the host).
    expect(() => onError?.(new Error("spawn wsl.exe ENOENT"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe("readWslDaemonPort", () => {
  it("issues one `cat daemon.json` LocusCommand and returns the parsed wsPort", async () => {
    const { calls, run } = recorder([{ stdout: JSON.stringify(CLAIM), code: 0 }]);

    expect(await readWslDaemonPort(LOCATION, run)).toBe(51987);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: WSL_EXE, args: ["-d", "Ubuntu", "-e", "cat", DAEMON_JSON] });
  });

  it("returns null when the file is absent (non-zero exit)", async () => {
    const { run } = recorder([{ stdout: "", code: 1 }]);
    expect(await readWslDaemonPort(LOCATION, run)).toBe(null);
  });

  it("returns null on garbage JSON", async () => {
    const { run } = recorder([{ stdout: "not json {", code: 0 }]);
    expect(await readWslDaemonPort(LOCATION, run)).toBe(null);
  });

  it("returns null on well-formed JSON that fails the schema", async () => {
    const { run } = recorder([{ stdout: JSON.stringify({ pid: 1 }), code: 0 }]);
    expect(await readWslDaemonPort(LOCATION, run)).toBe(null);
  });
});

describe("probeWslDaemonHealth", () => {
  it("maps an identity-matching 200 to the parsed identity", async () => {
    const doFetch = fakeFetch(HEALTHZ, { status: 200, body: IDENTITY });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toEqual(IDENTITY);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(String(doFetch.mock.calls[0]?.[0])).toBe(HEALTHZ);
  });

  it("maps a non-200 to null", async () => {
    const doFetch = fakeFetch(HEALTHZ, { status: 503 });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("rejects a 2xx that is not exactly 200 (e.g. 201 with a valid body)", async () => {
    const doFetch = fakeFetch(HEALTHZ, { status: 201, body: IDENTITY });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("rejects a 200 whose identity wsPort does not match the probed port", async () => {
    const doFetch = fakeFetch(HEALTHZ, { status: 200, body: { ...IDENTITY, wsPort: 99999 } });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("maps a 200 with an invalid identity body to null", async () => {
    const doFetch = fakeFetch(HEALTHZ, { status: 200, body: { pid: "nope" } });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("returns null when fetch rejects (connection refused / timeout)", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });
});

describe("waitForWslDaemon", () => {
  it("polls until the port appears and the port answers healthy", async () => {
    const { run } = recorder([
      { stdout: "", code: 1 }, // no daemon.json yet
      { stdout: JSON.stringify(CLAIM), code: 0 }, // port learned
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const doFetch = fakeFetch(HEALTHZ, { status: 200, body: IDENTITY });

    const result = await waitForWslDaemon(LOCATION, { run, fetch: doFetch, sleep });

    expect(result).toEqual({ port: 51987, identity: IDENTITY });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("RE-READS the port each pass until healthy, tolerating a port that changed across a restart", async () => {
    // ACQUISITION must not cache the first port: a version-skew restart brings the daemon
    // back on a NEW ephemeral port, so a cached port from the dying daemon would poll
    // fruitlessly to the deadline. First read → portA (unhealthy), second read → portB
    // (healthy) → returns portB.
    const CLAIM_B: DaemonInfo = { ...CLAIM, wsPort: 52000 };
    const IDENTITY_B: DaemonIdentity = { ...IDENTITY, wsPort: 52000 };
    const { calls, run } = recorder([
      { stdout: JSON.stringify(CLAIM), code: 0 }, // portA (51987) — the dying daemon
      { stdout: JSON.stringify(CLAIM_B), code: 0 }, // portB (52000) — the restarted daemon
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const doFetch = vi.fn(async (url: string) => {
      if (url === "http://localhost:51987/healthz") return { status: 503, json: async () => ({}) };
      if (url === "http://localhost:52000/healthz")
        return { status: 200, json: async () => IDENTITY_B };
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await waitForWslDaemon(LOCATION, { run, fetch: doFetch, sleep });

    expect(result).toEqual({ port: 52000, identity: IDENTITY_B });
    expect(calls).toHaveLength(2); // the claim was re-read, not cached after the first port.
    expect(doFetch).toHaveBeenCalledTimes(2); // probed portA (unhealthy), then portB (healthy).
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up at the EXACT deadline and throws, having issued no health probe", async () => {
    const { run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 1 },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const doFetch = vi.fn(() => {
      throw new Error("health must not be probed when the port never appears");
    });
    // deadline = 0 + 5 = 5; first check 0 (<5, continue), second check exactly 5 (>=5, throw).
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(5);

    await expect(
      waitForWslDaemon(LOCATION, { run, fetch: doFetch, sleep, now, timeoutMs: 5 }),
    ).rejects.toThrow(/did not become healthy within 5ms/);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("stopWslDaemon", () => {
  it("issues `wsl.exe … -e kill <pid>` inside the distro", async () => {
    const { calls, run } = recorder([{ stdout: "", code: 0 }]);

    await stopWslDaemon({ distro: "Ubuntu", pid: 4242 }, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: WSL_EXE, args: ["-d", "Ubuntu", "-e", "kill", "4242"] });
  });

  it("throws when kill exits nonzero (a failed stop must not resolve success)", async () => {
    const { run } = recorder([{ stdout: "", code: 1 }]);
    await expect(stopWslDaemon({ distro: "Ubuntu", pid: 4242 }, run)).rejects.toThrow(
      /could not stop WSL daemon pid 4242/,
    );
  });
});
