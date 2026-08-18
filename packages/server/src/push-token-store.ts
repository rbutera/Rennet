// Push-token store (issue #383 M1, attention-notifications). One row per paired
// device: the platform push token the daemon posts attention pushes to. Backed by
// `node:sqlite` (the same built-in the review store uses), at `~/.rennet/push-tokens.sqlite`.
//
// Keyed by device id — the SAME id the pairing store mints, so revoking a device's
// pairing deletes its push token (revoke ⇒ no further push, attention-notifications
// spec). A token is a SET/REPLACE (one per device); `remove` clears it. There is no
// hashing here: unlike a bearer token, a push token is a delivery ADDRESS the daemon
// must send in cleartext to the push service, so storing it plainly is correct.

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One device's registered push address, as the planner reads it. */
export interface PushRegistration {
  readonly deviceId: string;
  readonly token: string;
  readonly platform: "ios" | "android";
  /** Epoch ms of the last set/replace — for staleness triage, never a delivery decision. */
  readonly updatedAt: number;
  /** Attention families this device muted (#383 batch); the planner suppresses their pushes. */
  readonly disabledFamilies: readonly string[];
}

interface Row {
  device_id: string;
  token: string;
  platform: string;
  updated_at: number;
  disabled_families: string | null;
}

/** The default push-token store path: `~/.rennet/push-tokens.sqlite`, sibling to `devices.json`. */
export function defaultPushTokensPath(): string {
  return join(homedir(), ".rennet", "push-tokens.sqlite");
}

export class PushTokenStore {
  private readonly database: DatabaseSync;

  constructor(
    path: string = defaultPushTokensPath(),
    private readonly now: () => number = () => Date.now(),
  ) {
    // The store holds delivery addresses; keep it user-only. `~/.rennet` is created 0700 and the
    // db + its WAL/SHM sidecars are chmod'd 0600 — the directory mode is the real gate (other
    // users cannot traverse it), the file modes are defence in depth. Best-effort: a platform
    // that ignores POSIX modes (Windows) simply relies on the directory ACL.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS push_tokens (
         device_id TEXT PRIMARY KEY,
         token     TEXT NOT NULL,
         platform  TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         disabled_families TEXT
       )`,
    );
    // Additive column for a store created before #383 batch — ignore the error if it already exists.
    try {
      this.database.exec("ALTER TABLE push_tokens ADD COLUMN disabled_families TEXT");
    } catch {
      // Column already present (fresh CREATE above, or a prior migration) — nothing to do.
    }
    if (path !== ":memory:")
      for (const p of [path, `${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // The sidecar may not exist yet (no write) or the platform ignores modes — fine.
        }
      }
  }

  close(): void {
    this.database.close();
  }

  /** Set (or replace) a device's push token. One row per device — a re-register overwrites. */
  set(
    deviceId: string,
    token: string,
    platform: "ios" | "android",
    disabledFamilies: readonly string[] = [],
  ): void {
    const disabled = JSON.stringify(disabledFamilies);
    this.database
      .prepare(
        `INSERT INTO push_tokens (device_id, token, platform, updated_at, disabled_families)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET token = excluded.token,
                                              platform = excluded.platform,
                                              updated_at = excluded.updated_at,
                                              disabled_families = excluded.disabled_families`,
      )
      .run(deviceId, token, platform, this.now(), disabled);
  }

  /** Forget a device's push token (permission revoked on the phone, or the device unpaired). */
  delete(deviceId: string): void {
    this.database.prepare("DELETE FROM push_tokens WHERE device_id = ?").run(deviceId);
  }

  /** The device's registration, or null if it never registered (or was cleared). */
  get(deviceId: string): PushRegistration | null {
    const row = this.database
      .prepare("SELECT device_id, token, platform, updated_at, disabled_families FROM push_tokens WHERE device_id = ?")
      .get(deviceId) as Row | undefined;
    return row ? toRegistration(row) : null;
  }

  /** Every registered device (the planner's push-eligible set), newest-registered first. */
  list(): PushRegistration[] {
    const rows = this.database
      .prepare(
        "SELECT device_id, token, platform, updated_at, disabled_families FROM push_tokens ORDER BY updated_at DESC",
      )
      .all() as unknown as Row[];
    return rows.map(toRegistration);
  }
}

function toRegistration(row: Row): PushRegistration {
  return {
    deviceId: row.device_id,
    token: row.token,
    platform: row.platform === "ios" ? "ios" : "android",
    updatedAt: row.updated_at,
    disabledFamilies: parseDisabled(row.disabled_families),
  };
}

/** Parse the stored `disabled_families` JSON array, tolerating null/garbage as "none disabled". */
function parseDisabled(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}
