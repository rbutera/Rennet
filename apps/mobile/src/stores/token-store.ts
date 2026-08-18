// Mobile TokenStore (issue #383 M1, task 3.3). Implements the M0 `TokenStore` seam over the
// platform keychain (iOS Keychain / Android Keystore via expo-secure-store). The secure-store
// backend is INJECTED (a tiny interface), so this file imports no native module and the store
// unit-tests with a stub — the real wiring lives in `stores/native.ts`. Token values never
// appear in a log line (they only pass through the keychain), per the M0 contract.

import type { TokenStore } from "@rennet/client";

/** The slice of `expo-secure-store` the token store needs. */
export interface SecureStoreBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

// secure-store keys allow only [A-Za-z0-9._-]; a daemon id is a UUID, so this prefix is safe.
const keyFor = (daemonId: string): string => `rennet_token_${daemonId}`;

export class SecureTokenStore implements TokenStore {
  constructor(private readonly backend: SecureStoreBackend) {}

  async get(daemonId: string): Promise<string | undefined> {
    return (await this.backend.getItemAsync(keyFor(daemonId))) ?? undefined;
  }

  set(daemonId: string, token: string): Promise<void> {
    return this.backend.setItemAsync(keyFor(daemonId), token);
  }

  delete(daemonId: string): Promise<void> {
    return this.backend.deleteItemAsync(keyFor(daemonId));
  }
}
