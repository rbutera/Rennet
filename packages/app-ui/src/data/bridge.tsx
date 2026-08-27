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
  // One cache per provider (stable across renders, scoped to this mount) — a remount
  // with a new bridge gets a fresh cache, and a test never inherits another's entries.
  const [cache] = useState(() => new CommandCache());
  const [value, setValue] = useState<BridgeContextValue>(() => ({ bridge, cache }));
  // A bridge swap (target switch / remount) rebinds the context without losing the
  // cache identity — the value object is replaced so consumers re-render.
  if (value.bridge !== bridge) setValue({ bridge, cache });
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
