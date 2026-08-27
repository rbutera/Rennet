import { type RefCallback, useCallback, useSyncExternalStore } from "react";
import { useCoachRegistry, useCoachStore } from "./context";
import type { MarkId } from "./marks";

// ─────────────────────────────────────────────────────────────────────────────
// The typed anchor registry (C13 Cluster 2). A MarkId → live DOM element map,
// SEPARATE from the store's availability flags. This is the structural rewrite
// the autopsy (S8, fence rule 7) demands: anchors resolve through a ref-callback
// registry keyed by the closed `MarkId` union, never a `data-tour` selector.
//
// The union is the key, so an unknown id is a compile error. A DUPLICATE
// registration for one id — two live anchors claiming the same mark — throws.
// The broken spike declared `data-tour="new-chat"` twice and let the first win
// silently; here that is a loud dev-time error and the positive control the
// Cluster 5 regression test asserts against.
// ─────────────────────────────────────────────────────────────────────────────

export interface CoachRegistry {
  /** Claim an id for an element. Throws if a different element already holds it. */
  register(id: MarkId, el: Element): void;
  /** Release an id — but only if `el` still holds it (guards remount ordering). */
  unregister(id: MarkId, el: Element): void;
  get(id: MarkId): Element | null;
  subscribe(listener: () => void): () => void;
}

export function createCoachRegistry(): CoachRegistry {
  const elements = new Map<MarkId, Element>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    register(id, el) {
      const existing = elements.get(id);
      if (existing && existing !== el) {
        throw new Error(
          `Coach anchor "${id}" is already registered to a different element. Each MarkId ` +
            "anchors exactly one live element — a duplicate is the autopsy S8 regression.",
        );
      }
      elements.set(id, el);
      emit();
    },
    unregister(id, el) {
      // Only clear if we still own this element. On a legitimate remount React
      // may register the new element before the old one's cleanup runs; guarding
      // on identity stops the stale cleanup from wiping the fresh registration.
      if (elements.get(id) === el) {
        elements.delete(id);
        emit();
      }
    },
    get(id) {
      return elements.get(id) ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Register an anchor for a mark. Returns a ref callback: attach it to the chrome
 * element the mark points at (`<button ref={useCoachAnchor("new-chat")}>`). It
 * registers the element with the registry and reports the mark's availability to
 * the store; both are released when the element unmounts. `enabled={false}` (a
 * surface that has not landed yet) keeps the mark out entirely — it never elects.
 */
export function useCoachAnchor(id: MarkId, enabled = true): RefCallback<Element> {
  const store = useCoachStore();
  const registry = useCoachRegistry();
  return useCallback(
    (el: Element | null) => {
      if (!enabled || el === null) return;
      registry.register(id, el); // throws on duplicate before the store mutates
      store.getState().register(id);
      return () => {
        registry.unregister(id, el);
        store.getState().unregister(id);
      };
    },
    [id, enabled, registry, store],
  );
}

/** The live element a mark points at, or null while its surface is unmounted. */
export function useCoachElement(id: MarkId): Element | null {
  const registry = useCoachRegistry();
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.get(id),
    () => null,
  );
}
