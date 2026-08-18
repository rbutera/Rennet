import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PushTokenStore } from "./push-token-store";

const store = (): PushTokenStore => new PushTokenStore(":memory:", () => 1000);

describe("PushTokenStore (attention-notifications: push tokens register per device)", () => {
  it("sets, reads back, and replaces a device's token (one row per device)", () => {
    const s = store();
    s.set("dev-1", "tok-a", "ios");
    expect(s.get("dev-1")).toMatchObject({ deviceId: "dev-1", token: "tok-a", platform: "ios" });

    // Re-register replaces, never stacks.
    s.set("dev-1", "tok-b", "android");
    expect(s.get("dev-1")).toMatchObject({ token: "tok-b", platform: "android" });
    expect(s.list()).toHaveLength(1);
  });

  it("deletes a device's token (revoke / permission lost) so it is unregistered", () => {
    const s = store();
    s.set("dev-1", "tok-a", "ios");
    s.delete("dev-1");
    expect(s.get("dev-1")).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it("lists every registered device for the planner", () => {
    const s = store();
    s.set("dev-1", "tok-1", "ios");
    s.set("dev-2", "tok-2", "android");
    expect(
      s
        .list()
        .map((r) => r.deviceId)
        .sort(),
    ).toEqual(["dev-1", "dev-2"]);
  });

  it("returns null for a device that never registered", () => {
    expect(store().get("nope")).toBeNull();
  });

  it("creates its directory user-only and the db file user-only (#383 batch)", () => {
    const base = mkdtempSync(join(tmpdir(), "rennet-push-"));
    const dbDir = join(base, ".rennet");
    const dbPath = join(dbDir, "push-tokens.sqlite");
    try {
      const s = new PushTokenStore(dbPath, () => 1000);
      s.set("dev-1", "tok-a", "ios"); // force a write so WAL/SHM exist
      // POSIX-only assertion: the directory is 0700 and the db file 0600 (mode bits are ignored
      // on platforms without POSIX perms, where the directory ACL is the gate).
      if (process.platform !== "win32") {
        expect(statSync(dbDir).mode & 0o777).toBe(0o700);
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      }
      s.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
