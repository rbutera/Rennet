// Mobile ReplicaStore (issue #383 M1, task 3.3). Implements the M0 `ReplicaStore` seam over
// the app's async storage (@react-native-async-storage/async-storage), stamping `savedAt` on
// every persist so a painted replica can never read as live. The storage backend is INJECTED,
// so this file imports no native module and unit-tests with a stub (real wiring: stores/native.ts).

import type { ReplicaStore, StoredReplica } from "@rennet/client";

/** The slice of async storage the replica store needs. */
export interface AsyncStorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const keyFor = (daemonId: string): string => `rennet.replica.${daemonId}`;

export class AsyncReplicaStore implements ReplicaStore {
  constructor(
    private readonly backend: AsyncStorageBackend,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(daemonId: string): Promise<StoredReplica | undefined> {
    const raw = await this.backend.getItem(keyFor(daemonId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { surface?: unknown; savedAt?: unknown };
      if (typeof parsed.savedAt !== "number") return undefined;
      return { surface: parsed.surface, savedAt: parsed.savedAt };
    } catch {
      return undefined; // a corrupt replica is dropped, not thrown — the app reconciles fresh.
    }
  }

  async save(daemonId: string, surface: unknown): Promise<void> {
    const record: StoredReplica = { surface, savedAt: this.now() };
    await this.backend.setItem(keyFor(daemonId), JSON.stringify(record));
  }
}
