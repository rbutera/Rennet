// Persisted notification preferences (issue #383 batch, finding 15). Which attention families the
// user muted in Settings — sent to each daemon as `device.registerPush`'s `disabledFamilies`, so
// the daemon suppresses their pushes to this device (a high-priority family still reaches, per
// spec). Persisted so a relaunch keeps the choice. Storage backend is INJECTED (unit-tested with
// a stub); the family strings are the protocol's closed taxonomy.

import type { AttentionFamily } from "@rennet/protocol";
import type { AsyncStorageBackend } from "./replica-store";

const KEY = "rennet.notification-prefs";

export class NotificationPrefsStore {
  constructor(private readonly backend: AsyncStorageBackend) {}

  /** The muted families, or an empty list if never set / corrupt (never throws). */
  async load(): Promise<AttentionFamily[]> {
    const raw = await this.backend.getItem(KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((f): f is AttentionFamily => typeof f === "string") : [];
    } catch {
      return [];
    }
  }

  /** Persist the full muted-family list. */
  async save(disabledFamilies: readonly AttentionFamily[]): Promise<void> {
    await this.backend.setItem(KEY, JSON.stringify(disabledFamilies));
  }
}
