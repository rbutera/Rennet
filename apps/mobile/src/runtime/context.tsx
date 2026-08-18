// The app runtime context (issue #383 M1). Holds the single DaemonRegistry (wired to the
// native supervisor factory), reports focus/visibility presence off React Native's AppState,
// and subscribes to each daemon's attention broadcasts so a needs-you badge appears and clears
// live. Screens read `useRuntime()` for the registry and the aggregated attention set.
//
// Pairing bootstraps here too: `pairDaemon` opens a token-less bridge to the daemon URL, trades
// the one-time code for a device token (pairing.exchange), stores the token in the keychain, and
// adds the daemon to the registry — after which it just works (bootstrap, not a consent gate).

import { WsRennetBridge } from "@rennet/client";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { createTokenStore } from "../stores/native";
import { DaemonRegistry, type PairedDaemon } from "./daemon-registry";
import { createNativeSupervisor } from "./native-supervisor";

export interface Runtime {
  readonly registry: DaemonRegistry;
  /** Review ids with an active attention item across all daemons (needs-you set). */
  readonly attentionReviewIds: ReadonlySet<string>;
  /** Pair a daemon by URL + one-time code; resolves the paired daemon or throws on a bad code. */
  pairDaemon(input: { url: string; code: string; name: string }): Promise<PairedDaemon>;
  /** A monotonically-changing token so screens re-render on any registry/attention change. */
  readonly revision: number;
}

const RuntimeContext = createContext<Runtime | null>(null);

/** The app runtime — the registry, presence wiring, and attention aggregation. */
export function RuntimeProvider({ children }: { children: ReactNode }): ReactNode {
  const registry = useMemo(() => new DaemonRegistry(createNativeSupervisor), []);
  const [attentionReviewIds, setAttention] = useState<ReadonlySet<string>>(new Set());
  const [revision, setRevision] = useState(0);

  // Re-render screens on any registry change (a daemon added/removed, reachability moved).
  useEffect(() => registry.subscribe(() => setRevision((r) => r + 1)), [registry]);

  // Report focus/visibility off AppState (the planner uses it to decide push-vs-live).
  useEffect(() => {
    const report = (active: boolean): void =>
      registry.reportPresence({ focused: active, visible: active });
    report(AppState.currentState === "active");
    const sub = AppState.addEventListener("change", (state) => report(state === "active"));
    return () => sub.remove();
  }, [registry]);

  const runtime: Runtime = {
    registry,
    attentionReviewIds,
    revision,
    async pairDaemon({ url, code, name }) {
      const paired = await exchangePairing(url, code, name);
      await createTokenStore().set(paired.id, paired.deviceToken);
      registry.add({ id: paired.id, name, url, deviceId: paired.deviceId });
      setAttention((prev) => new Set(prev));
      return { id: paired.id, name, url, deviceId: paired.deviceId };
    },
  };

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** Read the app runtime. Throws if used outside `RuntimeProvider`. */
export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useRuntime must be used within a RuntimeProvider");
  return runtime;
}

/** Trade a one-time pairing code for a device token over a token-less bridge, then close it. */
async function exchangePairing(
  url: string,
  code: string,
  deviceName: string,
): Promise<{ id: string; deviceToken: string; deviceId: string }> {
  const bridge = new WsRennetBridge({ url, autoReconnect: false });
  try {
    const result = await bridge.invoke("pairing.exchange", { code, deviceName });
    // The local daemon id is the daemon-minted device id — stable and unique per pairing.
    return { id: result.deviceId, deviceToken: result.deviceToken, deviceId: result.deviceId };
  } finally {
    bridge.close();
  }
}
