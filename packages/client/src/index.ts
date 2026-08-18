// @rennet/client — the browser-safe transport clients (issue #378, app server wave
// phase 2). Imports only @rennet/protocol (the session envelope + RennetBridge
// contract); no Node imports, so the same bundle runs in the Electron renderer, a
// browser tab, or Node ≥22 (all provide a global `WebSocket` and `crypto.randomUUID`).

export {
  type BridgeHooks,
  ConnectionError,
  type ConnectionState,
  type ConnectionStatus,
  ConnectionSupervisor,
  type ConnectionSupervisorOptions,
  type Presence,
  type SupervisedBridge,
  type SupervisedBridgeFactory,
} from "./connection-supervisor";
export type { ReplicaStore, StoredReplica, TokenStore } from "./stores";
export {
  type BridgeLifecycleEvent,
  type CapturedServerInfo,
  WsRennetBridge,
  type WsRennetBridgeOptions,
} from "./ws-bridge";
