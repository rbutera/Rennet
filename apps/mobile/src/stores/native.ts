// Native store wiring (issue #383 M1). The one file that imports the real Expo modules and
// hands them to the DI'd stores. Kept separate from the store logic so the logic unit-tests
// without loading a native module (stores.test.ts injects stubs). Imported only by the app
// runtime, never by a test.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { AsyncReplicaStore } from "./replica-store";
import { SecureTokenStore } from "./token-store";

/** The device-token store over the platform keychain. */
export function createTokenStore(): SecureTokenStore {
  return new SecureTokenStore({
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  });
}

/** The last-known-replica store over async storage. */
export function createReplicaStore(): AsyncReplicaStore {
  return new AsyncReplicaStore({
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
  });
}
