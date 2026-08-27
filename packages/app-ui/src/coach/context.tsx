import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { type CoachRegistry, createCoachRegistry } from "./registry";
import type { CoachStore } from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// The coach context (C13 Cluster 2). Two things ride here, kept SEPARATE by
// design (autopsy S8 — do not conflate):
//
//   • store    — the elected-mark state machine (Cluster 1). A factory instance,
//                created by the provider with real persistence (Cluster 3 feeds
//                it `settings.get`/`settings.setCoachmarks`). It owns "which mark
//                is active" via its own availability flags.
//   • registry — a MarkId → live DOM element map (Cluster 2). It owns "where does
//                the active mark point". A duplicate registration for one MarkId
//                throws (the S8 regression guard), never silently first-wins.
//
// Both live in the provider, one instance per mount — never at module scope, so
// two providers (or two test cases) never share a chain timer or an anchor map.
// ─────────────────────────────────────────────────────────────────────────────

interface CoachContextValue {
  store: CoachStore;
  registry: CoachRegistry;
}

const CoachContext = createContext<CoachContextValue | null>(null);

/**
 * Provide the coach store + anchor registry to a subtree. Cluster 3 wires this
 * at the shell: it creates the store from `settings.get` with a `persist` that
 * calls `settings.setCoachmarks`, then renders `<CoachProvider store={…}>`. The
 * registry is created here — the provider owns it, so it is never module state.
 */
export function CoachProvider({ store, children }: { store: CoachStore; children: ReactNode }) {
  const [registry] = useState(createCoachRegistry);
  const value = useMemo<CoachContextValue>(() => ({ store, registry }), [store, registry]);
  return <CoachContext value={value}>{children}</CoachContext>;
}

function useCoach(): CoachContextValue {
  const value = useContext(CoachContext);
  if (!value) throw new Error("useCoach* must be used within a <CoachProvider>");
  return value;
}

/**
 * The coach context or `null` when no provider is mounted yet. The anchor hooks
 * (`useCoachAnchor`/`useCoachElement`) use this rather than the throwing `useCoach`:
 * an anchored surface may render in the brief window before the provider mounts (the
 * store is created only once `settings.get` resolves, C13 Cluster 3), so its anchor
 * ref must no-op until the provider appears, then register — never crash the surface.
 */
export function useCoachOptional(): CoachContextValue | null {
  return useContext(CoachContext);
}

/** The elected-mark store — read reactively with a selector: `useCoachStore()(s => s.active)`. */
export function useCoachStore(): CoachStore {
  return useCoach().store;
}

/** The anchor registry — the MarkId → element map. */
export function useCoachRegistry(): CoachRegistry {
  return useCoach().registry;
}
