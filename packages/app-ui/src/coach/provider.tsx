import { type ReactNode, useRef } from "react";
import { useCommand, useMutation } from "../data";
import { CoachProvider } from "./context";
import { type CoachStore, createCoachStore } from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// The coach data wiring (C13 Cluster 3). This is the ONE seam between the coach
// store and persistence — exactly two calls, no `bridge.invoke` in a component:
//
//   • READ  — `useCommand("settings.get")` carries the persisted `coachmarks` slice
//             ({ seen, skipAll }); the store is seeded from it, so skip-all and seen
//             survive a reload (the store re-elects from the confirmed state, never a
//             flash of an already-skipped mark).
//   • WRITE — `useMutation("settings.setCoachmarks")` (invalidating `settings.get`)
//             persists on every dismiss / skip-all / replay. The store owns the merge;
//             this just mirrors the whole slice to `client-settings.json`.
//
// The store is created ONCE, the first render `settings.get` has resolved, and kept by
// ref with a STABLE identity — never recreated per render (CoachProvider memoizes on
// [store, registry], so a fresh store each render would thrash the whole coach subtree).
// Cluster 4 mounts the active Coachmark and the nine anchors INSIDE this provider.
// ─────────────────────────────────────────────────────────────────────────────

export function CoachDataProvider({ children }: { children: ReactNode }) {
  const { data } = useCommand("settings.get", {});
  const { mutate } = useMutation("settings.setCoachmarks", { invalidates: ["settings.get"] });

  // `persist` must always call the LATEST mutate, but without recreating the store —
  // so route it through a ref the store's stable `persist` closure reads at call time.
  const persistRef = useRef(mutate);
  persistRef.current = mutate;

  // Create the store once, seeded from the persisted slice. The ref guard makes this a
  // single creation across renders (and StrictMode's double-invoke); later `settings.get`
  // refetches (a write invalidates it) never recreate the store — after seeding, the
  // store is the source of truth and persistence is a one-way mirror.
  const storeRef = useRef<CoachStore | null>(null);
  if (!storeRef.current && data) {
    storeRef.current = createCoachStore({
      initial: {
        seen: data.coachmarks?.seen ?? [],
        skipAll: data.coachmarks?.skipAll ?? false,
      },
      persist: (snapshot) => {
        void persistRef.current(snapshot);
      },
    });
  }

  const store = storeRef.current;
  // Until `settings.get` resolves, render children plain — the anchor hooks read an
  // optional context, so their refs no-op and self-heal the moment this provider mounts.
  if (!store) return <>{children}</>;
  return <CoachProvider store={store}>{children}</CoachProvider>;
}
