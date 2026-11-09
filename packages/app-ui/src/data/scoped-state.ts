import { useMemo, useSyncExternalStore } from "react";
import { useBridgeContext } from "./bridge";
import type { CommandCache } from "./cache";

// ─────────────────────────────────────────────────────────────────────────────
// SCOPED STATE — a little UI state that must outlive the component showing it.
//
// The session route swaps `PreparingWorkspace` for `ReviewWorkspace` the moment a review
// attaches, which can happen while the large-file question is open: everything under the
// header remounts, and `useState` there forgets that the reviewer dismissed the dialog, that
// they were on its Install screen, and that an install was running. State that has to ride
// across that swap lives here instead, under a key the caller names (a session id, an
// install's owner).
//
// It hangs off the bridge's command cache, so it lives exactly as long as that connection's
// cache does: a bridge swap starts clean, and so does every test that mounts its own bridge.
// ─────────────────────────────────────────────────────────────────────────────

interface Slot {
  value: unknown;
  readonly listeners: Set<() => void>;
}

const scopes = new WeakMap<CommandCache, Map<string, Slot>>();

function slotFor(cache: CommandCache, key: string, initial: unknown): Slot {
  let byKey = scopes.get(cache);
  if (byKey === undefined) {
    byKey = new Map();
    scopes.set(cache, byKey);
  }
  let slot = byKey.get(key);
  if (slot === undefined) {
    slot = { value: initial, listeners: new Set() };
    byKey.set(key, slot);
  }
  return slot;
}

/** A handle on one key, usable outside React — by a continuation that runs after its
 *  component has unmounted, for instance. */
export interface ScopedHandle<T> {
  readonly get: () => T;
  readonly set: (next: T | ((previous: T) => T)) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function scopedHandle<T>(cache: CommandCache, key: string, initial: T): ScopedHandle<T> {
  return {
    get: () => slotFor(cache, key, initial).value as T,
    set: (next) => {
      const slot = slotFor(cache, key, initial);
      const value =
        typeof next === "function" ? (next as (previous: T) => T)(slot.value as T) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      for (const listener of [...slot.listeners]) listener();
    },
    subscribe: (listener) => {
      const slot = slotFor(cache, key, initial);
      slot.listeners.add(listener);
      return () => {
        slot.listeners.delete(listener);
      };
    },
  };
}

/** `useState`, but kept under `key` for the life of the bridge rather than the component.
 *  `initial` seeds the key the first time anything reads it, and is ignored after. */
export function useScopedState<T>(
  key: string,
  initial: T,
): readonly [T, ScopedHandle<T>["set"], ScopedHandle<T>] {
  const handle = useScopedHandle(key, initial);
  const value = useSyncExternalStore(handle.subscribe, handle.get, handle.get);
  return [value, handle.set, handle] as const;
}

/** The scoped handle for `key` on the current bridge, for code that reads it imperatively. */
export function useScopedHandle<T>(key: string, initial: T): ScopedHandle<T> {
  const { cache } = useBridgeContext();
  // `initial` only seeds the key; a fresh literal on each render must not mint a new handle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  return useMemo(() => scopedHandle(cache, key, initial), [cache, key]);
}
