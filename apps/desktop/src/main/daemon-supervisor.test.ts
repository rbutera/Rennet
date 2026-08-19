import { describe, expect, it, vi } from "vitest";

// The Electron `app` import in daemon-supervisor is only touched by ensureDaemon/
// resolveServerBundle; stopOwnedDaemon and ownedDaemon never reach it. Stub it so the
// module loads under vitest without a real Electron.
vi.mock("electron", () => ({ app: { isPackaged: false, getVersion: () => "test" } }));

import { ownedDaemon, stopOwnedDaemon } from "./daemon-supervisor";

const claim = {
  pid: 4242,
  wsPort: 51000,
  protocolVersion: 1,
  version: "0.2.0",
  startedAt: "2026-08-19T00:00:00.000Z",
} as const;

/** A readClaim that returns `claim` for the first `liveReads` calls, then null (claim cleared). */
function clearingReader(liveReads: number) {
  let n = 0;
  return () => (n++ < liveReads ? { ...claim } : null);
}

const immediateSleep = () => Promise.resolve();

describe("stopOwnedDaemon (tray Quit completely)", () => {
  it("is a no-op when no daemon is owned (no claim, remote-only)", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    await stopOwnedDaemon("/data", { readClaim: () => null, kill, warn, sleep: immediateSleep });
    expect(kill).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("SIGTERMs the owned pid and returns cleanly once the claim clears", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    await stopOwnedDaemon("/data", {
      readClaim: clearingReader(1), // present on the pre-kill read, gone on the first poll
      kill,
      warn,
      sleep: immediateSleep,
    });
    expect(kill).toHaveBeenCalledWith(claim.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns truthfully and returns when the claim never clears within the bounded wait", async () => {
    const kill = vi.fn();
    const warn = vi.fn();
    let clock = 0;
    await stopOwnedDaemon("/data", {
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

  it("treats an already-gone pid (ESRCH) as a clean stop, no warning", async () => {
    const warn = vi.fn();
    await stopOwnedDaemon("/data", {
      readClaim: () => ({ ...claim }),
      kill: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
      warn,
      sleep: immediateSleep,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns (but does not throw) when the kill fails for a reason other than ESRCH", async () => {
    const warn = vi.fn();
    await stopOwnedDaemon("/data", {
      readClaim: () => ({ ...claim }),
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

describe("ownedDaemon (truthful quit-label state)", () => {
  it("returns the claim when it is present and the pid is alive", () => {
    expect(
      ownedDaemon(
        "/data",
        () => ({ ...claim }),
        () => true,
      ),
    ).toEqual(claim);
  });

  it("returns null when there is no claim (attached remote only)", () => {
    expect(
      ownedDaemon(
        "/data",
        () => null,
        () => true,
      ),
    ).toBeNull();
  });

  it("returns null when the claimed pid is dead (stale claim)", () => {
    expect(
      ownedDaemon(
        "/data",
        () => ({ ...claim }),
        () => false,
      ),
    ).toBeNull();
  });
});
