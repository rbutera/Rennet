import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PairingStore } from "./pairing-store";

function store(nowRef: { ms: number } = { ms: 1_000_000 }): PairingStore {
  const dir = mkdtempSync(join(tmpdir(), "rennet-pairing-"));
  return new PairingStore(join(dir, "devices.json"), () => nowRef.ms);
}

describe("PairingStore", () => {
  it("mints a code, exchanges it once, and the paired token then verifies", () => {
    const now = { ms: 1_000_000 };
    const s = store(now);
    const { code } = s.mint();
    const { deviceToken, deviceId } = s.exchange(code, "phone");
    expect(deviceToken).toBeTruthy();
    // Second exchange of the same code fails (single-use).
    expect(() => s.exchange(code, "phone-again")).toThrow();
    const verified = s.verifyToken(deviceToken);
    expect(verified?.deviceId).toBe(deviceId);
    expect(verified?.name).toBe("phone");
  });

  it("stores the token hashed, never in the clear", () => {
    const s = store();
    // Reach the path via a fresh store on the same file.
    const dir = mkdtempSync(join(tmpdir(), "rennet-pairing2-"));
    const path = join(dir, "devices.json");
    const s2 = new PairingStore(path, () => 1_000_000);
    const { code } = s2.mint();
    const { deviceToken } = s2.exchange(code, "laptop");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(deviceToken);
    expect(onDisk).toContain("tokenHash");
    void s;
  });

  it("rejects an expired code and an expired token", () => {
    const now = { ms: 1_000_000 };
    const s = store(now);
    const { code } = s.mint();
    now.ms += 6 * 60 * 1000; // past the 5-minute code TTL
    expect(() => s.exchange(code, "late")).toThrow();

    now.ms = 2_000_000;
    const fresh = s.mint();
    const { deviceToken } = s.exchange(fresh.code, "device");
    now.ms += 31 * 24 * 60 * 60 * 1000; // past the 30-day token TTL
    expect(s.verifyToken(deviceToken)).toBeNull();
  });

  it("revokes a device so its token stops verifying, leaving pairing open", () => {
    const now = { ms: 1_000_000 };
    const s = store(now);
    const { deviceToken, deviceId } = s.exchange(s.mint().code, "phone");
    expect(s.verifyToken(deviceToken)).not.toBeNull();
    const remaining = s.revokeDevice(deviceId);
    expect(remaining).toHaveLength(0);
    expect(s.verifyToken(deviceToken)).toBeNull();
    // Pairing still works afterwards.
    const next = s.exchange(s.mint().code, "phone-2");
    expect(s.verifyToken(next.deviceToken)).not.toBeNull();
  });

  it("refreshes sliding expiry on use", () => {
    const now = { ms: 1_000_000 };
    const s = store(now);
    const { deviceToken } = s.exchange(s.mint().code, "phone");
    const first = s.listDevices()[0]?.expiresAt;
    now.ms += 10 * 24 * 60 * 60 * 1000;
    s.verifyToken(deviceToken);
    const second = s.listDevices()[0]?.expiresAt;
    expect(second && first && Date.parse(second) > Date.parse(first)).toBe(true);
  });
});
