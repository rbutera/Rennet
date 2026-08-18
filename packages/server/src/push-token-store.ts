// Push-token store (issue #383 M1, attention-notifications). One row per paired
// device: the platform push token the daemon posts attention pushes to. Backed by
// `node:sqlite` (the same built-in the review store uses), at `~/.rennet/push-tokens.sqlite`.
//
// Keyed by device id — the SAME id the pairing store mints, so revoking a device's
// pairing deletes its push token (revoke ⇒ no further push, attention-notifications
// spec). A token is a SET/REPLACE (one per device); `remove` clears it. There is no
// hashing here: unlike a bearer token, a push token is a delivery ADDRESS the daemon
// must send in cleartext to the push service, so storing it plainly is correct.

import { mkdirSync } from "node:fs";
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
}

interface Row {
  device_id: string;
  token: string;
  platform: string;
  updated_at: number;
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
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS push_tokens (
         device_id TEXT PRIMARY KEY,
         token     TEXT NOT NULL,
         platform  TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  close(): void {
    this.database.close();
  }

  /** Set (or replace) a device's push token. One row per device — a re-register overwrites. */
  set(deviceId: string, token: string, platform: "ios" | "android"): void {
    this.database
      .prepare(
        `INSERT INTO push_tokens (device_id, token, platform, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET token = excluded.token,
                                              platform = excluded.platform,
                                              updated_at = excluded.updated_at`,
      )
      .run(deviceId, token, platform, this.now());
  }

  /** Forget a device's push token (permission revoked on the phone, or the device unpaired). */
  delete(deviceId: string): void {
    this.database.prepare("DELETE FROM push_tokens WHERE device_id = ?").run(deviceId);
  }

  /** The device's registration, or null if it never registered (or was cleared). */
  get(deviceId: string): PushRegistration | null {
    const row = this.database
      .prepare("SELECT device_id, token, platform, updated_at FROM push_tokens WHERE device_id = ?")
      .get(deviceId) as Row | undefined;
    return row ? toRegistration(row) : null;
  }

  /** Every registered device (the planner's push-eligible set), newest-registered first. */
  list(): PushRegistration[] {
    const rows = this.database
      .prepare(
        "SELECT device_id, token, platform, updated_at FROM push_tokens ORDER BY updated_at DESC",
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
  };
}
