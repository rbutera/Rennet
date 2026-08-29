import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { ROUTES } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// Prior-surface tracking (C10 §1.1, claims 575–576). A takeover (Settings, Archived,
// New Chat)
// "leaves to the prior surface" — the review board, front door, or wherever the
// reviewer came from. Rather than a browser pop (which no injected history exposes
// uniformly — memory history has no `back()`), we record the last NON-takeover
// location and navigate back to it, exactly the target-navigation shape the session
// top-bar's back arrow already uses. Cold deep-linking straight into a takeover has
// no prior surface, so it falls back to the front door.
//
// The tracked value is a ref carried through context: readers pull `.current` at
// click time, so recording a new prior surface never re-renders a takeover.
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_SURFACE = ROUTES.newChat;

/** True when a path is itself a full-view takeover (never a "prior surface"). */
function isTakeover(path: string): boolean {
  return (
    path.startsWith("/settings") || path.startsWith("/archived") || path.startsWith(ROUTES.newChat)
  );
}

const PriorSurfaceContext = createContext<{ current: string }>({ current: FALLBACK_SURFACE });

/**
 * Records the last non-takeover location (path + query) as the surface a takeover
 * returns to. Mounts inside `<Router>` and wraps the outlet so any takeover screen
 * can read the target through {@link usePriorSurface}.
 */
export function PriorSurfaceTracker({ children }: { readonly children: ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const ref = useRef<string>(FALLBACK_SURFACE);
  useEffect(() => {
    if (!isTakeover(location)) ref.current = search ? `${location}?${search}` : location;
  }, [location, search]);
  return <PriorSurfaceContext.Provider value={ref}>{children}</PriorSurfaceContext.Provider>;
}

/** Returns a getter for the surface a takeover should leave to (read at click time). */
export function usePriorSurface(): () => string {
  const ref = useContext(PriorSurfaceContext);
  return () => ref.current;
}

/** Test-only: supply a fixed prior surface without mounting the tracker. */
export const PriorSurfaceProvider = PriorSurfaceContext.Provider;
