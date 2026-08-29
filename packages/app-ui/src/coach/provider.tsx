import { type ReactNode, useEffect, useRef } from "react";
import { useSearch } from "wouter";
import { useCommand, useMutation } from "../data";
import { CoachProvider } from "./context";
import { createLatestWinsPersist } from "./persist";
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
  const search = useSearch();
  const { data } = useCommand("settings.get", {});
  const { mutate } = useMutation("settings.setCoachmarks", { invalidates: ["settings.get"] });

  // `persist` must always call the LATEST mutate, but without recreating the store —
  // so route it through a ref the store's stable `persist` closure reads at call time.
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const persistRef = useRef<ReturnType<typeof createLatestWinsPersist> | null>(null);
  if (!persistRef.current) {
    persistRef.current = createLatestWinsPersist((snapshot) => mutateRef.current(snapshot));
  }

  const resetRequested = new URLSearchParams(search).get("tour") === "reset";
  const resetAppliedRef = useRef(false);

  // Create the store once, seeded from the persisted slice. The ref guard makes this a
  // single creation across renders (and StrictMode's double-invoke); later `settings.get`
  // refetches (a write invalidates it) never recreate the store — after seeding, the
  // store is the source of truth and persistence is a one-way mirror.
  const storeRef = useRef<CoachStore | null>(null);
  if (!storeRef.current && data) {
    storeRef.current = createCoachStore({
      initial: {
        seen: resetRequested ? [] : (data.coachmarks?.seen ?? []),
        skipAll: resetRequested ? false : (data.coachmarks?.skipAll ?? false),
      },
      // Observe the write and sequence it latest-wins (finding 2): a rejecting
      // bridge is retained and retried, out-of-order completions never clobber a
      // newer state, and nothing leaves an unobserved rejection. `persistRef.current`
      // is read at call time so it always uses the latest `mutate`.
      persist: persistRef.current,
    });
  }

  useEffect(() => {
    if (!data || !resetRequested || resetAppliedRef.current) return;
    resetAppliedRef.current = true;
    storeRef.current?.getState().replay();
  }, [data, resetRequested]);

  // Render the provider UNCONDITIONALLY, store or not: before `settings.get` resolves the
  // store is null and the context value is null (anchors read it optionally and no-op, then
  // self-heal when it flips). Rendering a Fragment in the meantime would swap the wrapper's
  // element type on the flip and remount every child — at the shell that unmounts the
  // chat-dock slot mid-session (risk 4). A stable wrapper keeps the frame mounted throughout.
  return <CoachProvider store={storeRef.current}>{children}</CoachProvider>;
}
