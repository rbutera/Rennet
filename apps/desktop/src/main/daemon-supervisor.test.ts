import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
import { type DaemonInfo, readDaemonFile, removeDaemonFile, writeDaemonFile } from "@rennet/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/Rennet.app/Contents/Resources/app.asar",
    getVersion: () => "1.2.3",
    isPackaged: false,
  },
}));

import { ensureDaemon } from "./daemon-supervisor";

describe("desktop daemon supervision", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-daemon-supervisor-"));
    dirs.push(dir);
    return dir;
  }

  function claim(pid: number, wsPort: number, protocolVersion = PROTOCOL_VERSION): DaemonInfo {
    return {
      pid,
      wsPort,
      protocolVersion,
      version: "1.2.3",
      startedAt: "2026-08-18T00:00:00.000Z",
    };
  }

  function healthy(info: DaemonInfo) {
    return {
      kind: "healthy" as const,
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

  it("takes over a dead-pid claim, publishes the spawned claim, and preserves it from late cleanup", async () => {
    const dataDir = makeDir();
    const stale = claim(111, 40_000);
    const spawned = claim(222, 41_000);
    writeDaemonFile(dataDir, stale);
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));

    const port = await ensureDaemon(dataDir, {
      probe: async () => ({ kind: "stale", claim: stale }),
      spawn,
      waitForHealthy: async () => healthy(spawned),
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

  it("kills an incompatible daemon, spawns the bundled daemon, and preserves the new claim", async () => {
    const dataDir = makeDir();
    const old = claim(333, 42_000, PROTOCOL_VERSION + 500);
    const spawned = claim(444, 43_000);
    writeDaemonFile(dataDir, old);
    const kill = vi.fn(() => removeDaemonFile(dataDir, old.pid));
    const spawn = vi.fn(() => writeDaemonFile(dataDir, spawned));

    const port = await ensureDaemon(dataDir, {
      probe: async () => ({
        kind: "incompatible",
        claim: old,
        identity: {
          pid: old.pid,
          wsPort: old.wsPort,
          version: old.version,
          protocolVersion: old.protocolVersion,
          minCompatibleProtocolVersion: old.protocolVersion,
        },
        reason: "test skew",
      }),
      spawn,
      waitForHealthy: async () => healthy(spawned),
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
});
