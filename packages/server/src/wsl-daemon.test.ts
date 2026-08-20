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
function fakeFetch(url: string, response: { ok: boolean; body?: unknown }) {
  return vi.fn(async (input: string) => {
    if (input !== url) throw new Error(`unexpected fetch: ${input}`);
    return { ok: response.ok, json: async () => response.body };
  });
}

describe("spawnWslDaemon", () => {
  it("spawns detached with ignored stdio and unrefs, using the launch file + args", () => {
    const unref = vi.fn();
    const spawner = vi.fn(() => ({ unref }));
    const launch: LocusCommand = {
      file: WSL_EXE,
      args: ["-d", "Ubuntu", "-e", "/usr/bin/node", "/home/rai/.rennet/server/0.3.12/rennet.cjs"],
    };

    spawnWslDaemon(launch, { spawn: spawner });

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(spawner).toHaveBeenCalledWith(launch.file, launch.args, {
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe("readWslDaemonPort", () => {
  it("issues one `cat daemon.json` LocusCommand and returns the parsed wsPort", async () => {
    const { calls, run } = recorder([{ stdout: JSON.stringify(CLAIM), code: 0 }]);

    expect(await readWslDaemonPort(LOCATION, run)).toBe(51987);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: WSL_EXE,
      args: ["-d", "Ubuntu", "-e", "cat", DAEMON_JSON],
    });
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
  const URL = "http://localhost:51987/healthz";

  it("hits localhost:<port>/healthz and maps a 200 to the parsed identity", async () => {
    const doFetch = fakeFetch(URL, { ok: true, body: IDENTITY });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toEqual(IDENTITY);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(String(doFetch.mock.calls[0]?.[0])).toBe(URL);
  });

  it("maps a non-200 to null", async () => {
    const doFetch = fakeFetch(URL, { ok: false });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("maps a 200 with an invalid identity body to null", async () => {
    const doFetch = fakeFetch(URL, { ok: true, body: { pid: "nope" } });
    expect(await probeWslDaemonHealth(51987, { fetch: doFetch })).toBe(null);
  });

  it("returns null when fetch throws (connection refused)", async () => {
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
    const doFetch = fakeFetch("http://localhost:51987/healthz", { ok: true, body: IDENTITY });

    const result = await waitForWslDaemon(LOCATION, { run, fetch: doFetch, sleep });

    expect(result).toEqual({ port: 51987, identity: IDENTITY });
    expect(sleep).toHaveBeenCalledTimes(1); // slept once between the two polls.
  });

  it("gives up at the deadline and throws", async () => {
    const { run } = recorder([
      { stdout: "", code: 1 },
      { stdout: "", code: 1 },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    // now(): start=0, first loop check 0 (< deadline 5), second check 10 (>= deadline).
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10);

    await expect(
      waitForWslDaemon(LOCATION, {
        run,
        fetch: vi.fn(),
        sleep,
        now,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/did not become healthy within 5ms/);
  });
});

describe("stopWslDaemon", () => {
  it("issues `wsl.exe … -e kill <pid>` inside the distro", async () => {
    const { calls, run } = recorder([{ stdout: "", code: 0 }]);

    await stopWslDaemon({ distro: "Ubuntu", pid: 4242 }, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: WSL_EXE,
      args: ["-d", "Ubuntu", "-e", "kill", "4242"],
    });
  });
});
