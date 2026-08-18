// Persisted paired-daemon list (issue #383 batch, finding 10). The set of daemons the phone has
// paired with — id, name, url, and the daemon-minted device id — so a cold start hydrates the
// registry and lands on the review list without re-pairing. NO SECRETS here: the device TOKEN
// lives in the keychain (SecureTokenStore), keyed by the same daemon id; this list only names
// which daemons exist. The storage backend is INJECTED, so this logic unit-tests with a stub.

import type { AsyncStorageBackend } from "./replica-store";
import type { PairedDaemon } from "../runtime/daemon-registry";

const KEY = "rennet.daemons";

export class DaemonListStore {
  constructor(private readonly backend: AsyncStorageBackend) {}

  /** The persisted paired daemons, or an empty list if none / corrupt (never throws). */
  async load(): Promise<PairedDaemon[]> {
    const raw = await this.backend.getItem(KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Keep only well-formed rows — a partial/garbled entry is dropped, not trusted.
      return parsed.filter(
        (d): d is PairedDaemon =>
          !!d &&
          typeof d.id === "string" &&
          typeof d.name === "string" &&
          typeof d.url === "string" &&
          typeof d.deviceId === "string",
      );
    } catch {
      return [];
    }
  }

  /** Persist the full paired-daemon list (id/name/url/deviceId only — never a token). */
  async save(daemons: readonly PairedDaemon[]): Promise<void> {
    const rows = daemons.map((d) => ({ id: d.id, name: d.name, url: d.url, deviceId: d.deviceId }));
    await this.backend.setItem(KEY, JSON.stringify(rows));
  }
}
