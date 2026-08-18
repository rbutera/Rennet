import { describe, expect, it } from "vitest";
import { AsyncReplicaStore, type AsyncStorageBackend } from "./replica-store";
import { type SecureStoreBackend, SecureTokenStore } from "./token-store";

function fakeSecureStore(): SecureStoreBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItemAsync: (k) => Promise.resolve(map.get(k) ?? null),
    setItemAsync: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    deleteItemAsync: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

function fakeAsyncStorage(): AsyncStorageBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => Promise.resolve(map.get(k) ?? null),
    setItem: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
  };
}

describe("SecureTokenStore (task 3.3 — keychain, stubbed)", () => {
  it("round-trips a device token and forgets it on delete", async () => {
    const store = new SecureTokenStore(fakeSecureStore());
    expect(await store.get("d1")).toBeUndefined();
    await store.set("d1", "tok-abc");
    expect(await store.get("d1")).toBe("tok-abc");
    await store.delete("d1");
    expect(await store.get("d1")).toBeUndefined();
  });

  it("keys tokens per daemon", async () => {
    const backend = fakeSecureStore();
    const store = new SecureTokenStore(backend);
    await store.set("d1", "one");
    await store.set("d2", "two");
    expect(await store.get("d1")).toBe("one");
    expect(await store.get("d2")).toBe("two");
    expect([...backend.map.keys()]).toEqual(["rennet_token_d1", "rennet_token_d2"]);
  });
});

describe("AsyncReplicaStore (task 3.3 — async storage, savedAt stamped)", () => {
  it("stamps savedAt on save and returns it on load", async () => {
    const store = new AsyncReplicaStore(fakeAsyncStorage(), () => 1234);
    await store.save("d1", { reviews: [] });
    const loaded = await store.load("d1");
    expect(loaded).toEqual({ surface: { reviews: [] }, savedAt: 1234 });
  });

  it("returns undefined for a never-synced daemon and for a corrupt record", async () => {
    const backend = fakeAsyncStorage();
    const store = new AsyncReplicaStore(backend);
    expect(await store.load("d1")).toBeUndefined();
    backend.map.set("rennet.replica.d1", "{not json");
    expect(await store.load("d1")).toBeUndefined();
    backend.map.set("rennet.replica.d1", JSON.stringify({ surface: {} })); // no savedAt
    expect(await store.load("d1")).toBeUndefined();
  });
});
