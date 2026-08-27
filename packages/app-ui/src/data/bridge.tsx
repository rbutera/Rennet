import type { RennetBridge } from "@rennet/protocol";
import { createContext, type ReactNode, useContext, useState } from "react";
import { CommandCache } from "./cache";

// ─────────────────────────────────────────────────────────────────────────────
// BridgeProvider + useBridge (C01 §2.2). The host supplies the bridge ONCE at the
// app root — `RennetApp` wraps its tree in a `BridgeProvider`, and no component
// receives the bridge as a prop again. `useBridge()` returns the bridge for its
// non-invoke surface (platform/version/applyUpdate); the STANDING LAW is that no
// component calls `bridge.invoke` directly — reads go through `useCommand`, writes
// through `useMutation`, streams through `useCommandStream`. That law is a lint rule
// scoped to `src/`-outside-`src/data/` (armed in the cutover).
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeContextValue {
  readonly bridge: RennetBridge;
  readonly cache: CommandCache;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

/** Internal: the bridge + its command cache. The data hooks read this; surfaces do not. */
export function useBridgeContext(): BridgeContextValue {
  const value = useContext(BridgeContext);
  if (!value) throw new Error("useBridge must be used within a <BridgeProvider>");
  return value;
}

/** The bridge, for its non-invoke surface (platform, version, applyUpdate). Never `.invoke`. */
export function useBridge(): RennetBridge {
  return useBridgeContext().bridge;
}

export function BridgeProvider({
  bridge,
  children,
}: {
  readonly bridge: RennetBridge;
  readonly children: ReactNode;
}): ReactNode {
  // Cache identity is BOUND to bridge identity: one cache per bridge. A bridge swap
  // (target switch / remount) mints a FRESH cache in the same render, so no entry — nor
  // an in-flight request — from the previous bridge can populate or be read against the
  // new one. (Stable across ordinary re-renders where the bridge is unchanged.)
  const [value, setValue] = useState<BridgeContextValue>(() => ({
    bridge,
    cache: new CommandCache(),
  }));
  if (value.bridge !== bridge) setValue({ bridge, cache: new CommandCache() });
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
