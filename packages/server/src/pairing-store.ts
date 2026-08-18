// Device pairing store (issue #380, design D5). Connection bootstrap, not ceremony:
// a short-lived single-use code is exchanged ONCE for a long-lived device token,
// then a paired device just works — no per-action prompt ever (Rule Zero).
//
// Tokens are secrets, so only their SHA-256 hash is stored at rest, in
// `~/.rennet/devices.json` (atomic temp+rename, the daemon-file pattern). The raw
// token is returned exactly once, at exchange time. Expiry is sliding (30 days from
// last use), refreshed on every successful handshake. Revocation is deleting the row.
//
// Codes live only in memory (5-minute TTL, single-use): a mint that is never
// exchanged simply expires, and a restart drops all outstanding codes — correct for
// a bootstrap secret.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PairedDevice } from "@rennet/protocol";
import { z } from "zod";

const DEVICES_VERSION = 1;
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32 (Crockford-ish, no ambiguous chars)
const CODE_LENGTH = 8;

const deviceRecordSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  tokenHash: z.string().min(1),
  createdAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  expiresAt: z.string().min(1),
});
const devicesFileSchema = z.object({
  version: z.number().int().nonnegative(),
  devices: z.array(deviceRecordSchema),
});
type DeviceRecord = z.infer<typeof deviceRecordSchema>;

/** The default device store path: `~/.rennet/devices.json`, sibling to `config.json`. */
export function defaultDevicesPath(): string {
  return join(homedir(), ".rennet", "devices.json");
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return code;
}

/** A publicly-listable device row (no token hash) — the shape settings + CLI show. */
function toPublic(record: DeviceRecord): PairedDevice {
  return {
    deviceId: record.deviceId,
    name: record.name,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
  };
}

export class PairingStore {
  private tmpSeq = 0;
  /** Outstanding pairing codes → their expiry (ms epoch). In memory, single-use. */
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly path: string = defaultDevicesPath(),
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private read(): DeviceRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = devicesFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.devices : [];
    } catch {
      return [];
    }
  }

  private write(devices: DeviceRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${this.tmpSeq++}`;
    const body = JSON.stringify({ version: DEVICES_VERSION, devices }, null, 2);
    writeFileSync(tmp, `${body}\n`);
    renameSync(tmp, this.path);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** Mint a single-use pairing code (5-minute TTL). Shown by the desktop / `rennet pair`. */
  mint(): { code: string; expiresAt: string } {
    this.pruneCodes();
    const code = mintCode();
    const expiresAtMs = this.now() + CODE_TTL_MS;
    this.codes.set(code, expiresAtMs);
    return { code, expiresAt: this.iso(expiresAtMs) };
  }

  private pruneCodes(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }

  /** Exchange a valid code for a long-lived device token. Throws on an invalid/expired/used code. */
  exchange(code: string, deviceName: string): { deviceToken: string; deviceId: string } {
    this.pruneCodes();
    const expiresAt = this.codes.get(code);
    if (expiresAt === undefined || expiresAt <= this.now()) {
      throw new Error("Pairing code is invalid or expired");
    }
    this.codes.delete(code); // single-use
    const nowMs = this.now();
    const rawToken = randomBytes(32).toString("base64url");
    const record: DeviceRecord = {
      deviceId: randomUUID(),
      name: deviceName,
      tokenHash: hashToken(rawToken),
      createdAt: this.iso(nowMs),
      lastSeenAt: this.iso(nowMs),
      expiresAt: this.iso(nowMs + TOKEN_TTL_MS),
    };
    this.write([...this.read(), record]);
    return { deviceToken: rawToken, deviceId: record.deviceId };
  }

  /**
   * Verify a presented token: it must hash to a stored, unexpired device. On success
   * the device's sliding expiry is refreshed (last-seen + 30 days) and persisted.
   * A revoked or expired token simply returns false — the handshake fails, pairing stays open.
   */
  verifyToken(rawToken: string): PairedDevice | null {
    const hash = hashToken(rawToken);
    const devices = this.read();
    const nowMs = this.now();
    const match = devices.find((device) => device.tokenHash === hash);
    if (!match || Date.parse(match.expiresAt) <= nowMs) return null;
    match.lastSeenAt = this.iso(nowMs);
    match.expiresAt = this.iso(nowMs + TOKEN_TTL_MS);
    this.write(devices);
    return toPublic(match);
  }

  /** Every paired device, newest first (no token hashes). */
  listDevices(): PairedDevice[] {
    return this.read()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublic);
  }

  /** Revoke a device by id; returns the remaining devices. A no-op for an unknown id. */
  revokeDevice(deviceId: string): PairedDevice[] {
    const remaining = this.read().filter((device) => device.deviceId !== deviceId);
    this.write(remaining);
    return remaining.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toPublic);
  }
}
