import type { SidebarSession } from "@rennet/protocol";
import { useCallback } from "react";
import { useBridgeContext } from "./bridge";

// ─────────────────────────────────────────────────────────────────────────────
// A session row read NOW, from the daemon, rather than from the cache.
//
// For code that acts long after it was armed — an install continuation landing minutes
// later, possibly after its component unmounted — and must decide on the session's state at
// the moment it acts. The cached `session.list` can be a poll behind; a cancel from another
// window or a moment ago would not be in it yet.
// ─────────────────────────────────────────────────────────────────────────────

/** Read one session's row from the daemon. Resolves undefined when it no longer exists. */
export function useReadSessionNow(): (sessionId: string) => Promise<SidebarSession | undefined> {
  const { bridge } = useBridgeContext();
  return useCallback(
    async (sessionId) => {
      const { sessions } = await bridge.invoke("session.list", {});
      return sessions.find((candidate) => candidate.id === sessionId);
    },
    [bridge],
  );
}
