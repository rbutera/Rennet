// The app runtime context (issue #383 M1). Holds the single DaemonRegistry (wired to the
// native supervisor factory), reports focus/visibility presence off React Native's AppState,
// and subscribes to each daemon's attention broadcasts so a needs-you badge appears and clears
// live. Screens read `useRuntime()` for the registry and the aggregated attention set.
//
// Pairing bootstraps here too: `pairDaemon` opens a token-less bridge to the daemon URL, trades
// the one-time code for a device token (pairing.exchange), stores the token in the keychain, and
// adds the daemon to the registry — after which it just works (bootstrap, not a consent gate).

import { WsRennetBridge } from "@rennet/client";
import type { AttentionFamily } from "@rennet/protocol";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { createDaemonListStore, createTokenStore } from "../stores/native";
import { DaemonRegistry, type PairedDaemon } from "./daemon-registry";
import { createNativeSupervisor } from "./native-supervisor";
import { registerPushWithAllDaemons } from "./push";

export interface Runtime {
  readonly registry: DaemonRegistry;
  /** Review ids with an active attention item across all daemons (needs-you set). */
  readonly attentionReviewIds: ReadonlySet<string>;
  /** Pair a daemon by URL + one-time code; resolves the paired daemon or throws on a bad code. */
  pairDaemon(input: { url: string; code: string; name: string }): Promise<PairedDaemon>;
  /** Forget a paired daemon: drop it from the registry, persisted list, and keychain. */
  forgetDaemon(daemonId: string): Promise<void>;
  /**
   * Set (or update) the desired push registration — this install's token plus muted families.
   * Registers with every attention-capable daemon now, and REPLAYS on every reconnect / new
   * pairing so a daemon that was offline still ends up registered (#383 batch).
   */
  configurePush(token: string, disabledFamilies: readonly AttentionFamily[]): void;
  /** True once the persisted daemon list has been loaded and its supervisors created. */
  readonly hydrated: boolean;
  /** A monotonically-changing token so screens re-render on any registry/attention change. */
  readonly revision: number;
}

const RuntimeContext = createContext<Runtime | null>(null);

/** The app runtime — the registry, presence wiring, and attention aggregation. */
export function RuntimeProvider({ children }: { children: ReactNode }): ReactNode {
  const registry = useMemo(() => new DaemonRegistry(createNativeSupervisor), []);
  const daemonListStore = useMemo(() => createDaemonListStore(), []);
  const [attentionReviewIds, setAttention] = useState<ReadonlySet<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  // The desired push registration (token + muted families), replayed on every reconnect so an
  // offline daemon still registers when it comes back (#383 batch, finding 14).
  const pushConfig = useRef<{ token: string; disabledFamilies: readonly AttentionFamily[] } | null>(
    null,
  );
  // Signature of the online, attention-capable daemons — a change means a (re)connect to replay to.
  const lastReplaySignature = useRef("");

  // Re-render screens on any registry change (daemon added/removed, reachability, attention) and
  // refresh the live needs-you set from the registry's attention broadcasts.
  useEffect(
    () =>
      registry.subscribe(() => {
        setAttention(registry.needsYouReviewIds());
        setRevision((r) => r + 1);
      }),
    [registry],
  );

  // Cold-start hydration (#383 batch): load the persisted paired daemons and create their
  // supervisors BEFORE the app settles, so a relaunch lands on the review list, not empty state.
  useEffect(() => {
    let cancelled = false;
    void daemonListStore.load().then((daemons) => {
      if (cancelled) return;
      for (const daemon of daemons) registry.add(daemon);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [registry, daemonListStore]);

  const persistList = (): Promise<void> =>
    daemonListStore.save(registry.list().map((c) => c.daemon));

  // Replay the desired push registration whenever the set of online, attention-capable daemons
  // changes (a reconnect or a new pairing) — so a daemon that was down when push was enabled still
  // ends up registered (#383 batch, finding 14). Idempotent (the daemon upserts) and non-fatal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the intended trigger — it bumps on every reachability change.
  useEffect(() => {
    const config = pushConfig.current;
    if (!config) return;
    const signature = registry
      .list()
      .filter((c) => c.status.state === "online" && c.supervisor.attentionAdvertised())
      .map((c) => c.daemon.id)
      .sort()
      .join(",");
    if (signature === lastReplaySignature.current) return;
    lastReplaySignature.current = signature;
    void registerPushWithAllDaemons(registry, config.token, config.disabledFamilies);
  }, [registry, revision]);

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
    hydrated,
    revision,
    async pairDaemon({ url, code, name }) {
      const paired = await exchangePairing(url, code, name);
      await createTokenStore().set(paired.id, paired.deviceToken);
      const daemon = { id: paired.id, name, url, deviceId: paired.deviceId };
      registry.add(daemon);
      await persistList();
      return daemon;
    },
    async forgetDaemon(daemonId) {
      registry.remove(daemonId);
      await persistList();
      await createTokenStore().delete(daemonId);
    },
    configurePush(token, disabledFamilies) {
      pushConfig.current = { token, disabledFamilies };
      // Force the next replay to fire even if the daemon set has not changed (prefs may have).
      lastReplaySignature.current = "";
      void registerPushWithAllDaemons(registry, token, disabledFamilies);
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
