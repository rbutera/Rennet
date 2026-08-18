import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DaemonInfo,
  daemonFilePath,
  readDaemonFile,
  removeDaemonFile,
  writeDaemonFile,
} from "./daemon-file";

describe("daemon.json claim lifecycle (#379)", () => {
  const dirs: string[] = [];
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-daemon-file-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const info = (over: Partial<DaemonInfo> = {}): DaemonInfo => ({
    pid: 4321,
    wsPort: 51_234,
    protocolVersion: 1,
    version: "0.1.0",
    startedAt: "2026-08-18T00:00:00.000Z",
    ...over,
  });

  it("writes, reads back, and removes the claim", () => {
    const dir = make();
    expect(readDaemonFile(dir)).toBeNull();
    writeDaemonFile(dir, info());
    expect(existsSync(daemonFilePath(dir))).toBe(true);
    expect(readDaemonFile(dir)).toEqual(info());
    removeDaemonFile(dir, 4321);
    expect(existsSync(daemonFilePath(dir))).toBe(false);
    expect(readDaemonFile(dir)).toBeNull();
  });

  it("removing an absent claim is a no-op (idempotent shutdown)", () => {
    const dir = make();
    expect(() => removeDaemonFile(dir, 4321)).not.toThrow();
    removeDaemonFile(dir, 4321);
  });

  it("a late old owner cannot remove a newer daemon's claim", () => {
    const dir = make();
    writeDaemonFile(dir, info({ pid: 222, wsPort: 41_000 }));
    expect(removeDaemonFile(dir, 111)).toBe(false);
    expect(readDaemonFile(dir)).toEqual(info({ pid: 222, wsPort: 41_000 }));
  });

  it("a fresh start overwrites a stale claim (dead pid → new process)", () => {
    const dir = make();
    writeDaemonFile(dir, info({ pid: 111, wsPort: 40_000 }));
    // Next launcher wins the data dir and rewrites the claim with its own identity.
    writeDaemonFile(dir, info({ pid: 222, wsPort: 41_000 }));
    expect(readDaemonFile(dir)).toEqual(info({ pid: 222, wsPort: 41_000 }));
  });

  it("a malformed or torn claim reads as absent, never a throw", () => {
    const dir = make();
    writeFileSync(daemonFilePath(dir), "{ not: valid json");
    expect(readDaemonFile(dir)).toBeNull();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: "nope" }));
    expect(readDaemonFile(dir)).toBeNull();
  });
});
