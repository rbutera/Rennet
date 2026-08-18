// The real per-daemon supervisor factory (issue #383 M1). Builds an M0 ConnectionSupervisor
// over a WsRennetBridge to the daemon's tailnet URL, with the keychain token store and the
// async-storage replica store. This is the one wire between the mobile shell and the shared
// client runtime — the shell constructs no transport or retry loop of its own (the mobile
// plan's whole point). Typecheck-only from tests (it opens a socket); the registry's
// bookkeeping is tested with an injected fake supervisor instead.

import { ConnectionSupervisor, type SupervisedBridge, WsRennetBridge } from "@rennet/client";
import { createReplicaStore, createTokenStore } from "../stores/native";
import type { DaemonSupervisor, PairedDaemon } from "./daemon-registry";

/** Build a live supervisor for a paired daemon (keychain token + async-storage replica). */
export function createNativeSupervisor(daemon: PairedDaemon): DaemonSupervisor {
  const supervisor = new ConnectionSupervisor({
    daemonId: daemon.id,
    tokenStore: createTokenStore(),
    replicaStore: createReplicaStore(),
    // The shell hands the supervisor a bridge factory and consumes reachability — it never
    // builds a transport itself. The supervisor owns retry, so the bridge does not self-reconnect.
    createBridge: (hooks, deviceToken): SupervisedBridge =>
      new WsRennetBridge({
        url: daemon.url,
        deviceToken,
        autoReconnect: false,
        onLifecycle: hooks.onLifecycle,
      }),
  });
  // This locus is a phone (the planner reads deviceClass for delivery decisions).
  supervisor.setPresence({ deviceClass: "phone" });
  return supervisor;
}
