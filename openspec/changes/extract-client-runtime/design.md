# Design — extract-client-runtime

## Context

Both live shells already speak WS through `WsRennetBridge` (`packages/client/src/ws-bridge.ts`): the desktop renderer connects to the loopback daemon port handed over by preload (`apps/desktop/src/renderer/index.tsx`), the browser shell to its serving origin (`apps/desktop/src/browser/entry.tsx`). Each shell hand-composes its bridge in a `createBridge(target)` factory passed to `packages/ui`'s `ConnectionHost`, which remounts per target. `WsRennetBridge` owns correlation, fan-out listener routing, and capped-backoff reconnect — but a reconnect does not re-register live `onAskStream`/`onProgress` subscriptions on the new socket (issue #389), and neither token persistence nor last-known-state painting exists anywhere. T3 Code's `packages/client-runtime` is the shape reference (MIT — code copyable with notices): "React components never construct transports, retry loops, or RPC clients."

Constraints: package boundaries (the runtime may import only `protocol` and `types`; no Node-only APIs so the browser and RN shells can consume it); Rule Zero (no gating, no ceremony — reconnect just works); the existing e2e suites define behavior-neutrality.

## Goals / Non-Goals

**Goals:**

- One package the third shell (mobile) consumes unchanged; desktop + browser adopt it first as the proof.
- Reconnect-with-resubscribe as a property of the runtime, not of any shell (#389 fixed once).
- Storage (tokens, replica) behind injected interfaces so platforms differ only in the store.

**Non-Goals:**

- No daemon-side FEATURES: no new commands, no wire-shape changes, no presence consumption, no notification planner (later Phase 6 changes). One daemon-side BUG FIX is in scope: ask-stream deltas currently close over the invoking socket and keep firing at it after a reconnect — mirroring the existing `broadcastProgress` pattern for ask deltas (broadcast by reviewId to live authorized sockets) is the root-cause half of #389 and lands here.
- No UI changes beyond swapping the wiring under `ConnectionHost`.
- No RN/Expo code in this change — the runtime must merely be consumable there (no DOM/Node globals in core paths).

## Decisions

1. **Grow `packages/client` into the runtime rather than adding a new package.** The runtime is the natural evolution of what `client` already is; a second package would split one seam across two workspaces and force `ui`-adjacent import churn. `@rennet/client` keeps its name; `client-runtime` remains the concept name. (Alternative — new `packages/client-runtime` — rejected: boundary identical, churn higher.)
2. **Supervisor wraps the bridge; the bridge stays dumb.** `WsRennetBridge` keeps transport, correlation, and fan-out; a new `ConnectionSupervisor` owns the state machine, backoff policy, network-change probes, and the resubscribe registry, and exposes `bridge`, `state`, and `subscribe(state => …)`. Shells construct a supervisor per target; `ConnectionHost`'s `createBridge` seam widens to `createConnection` returning the supervisor (behavior-neutral adapter kept for tests).
3. **Resubscribe registry lives above the socket.** `onAskStream(reviewId, listener)` and `onProgress(commandId, listener)` register in the supervisor's registry; the registry replays registrations onto every fresh socket. Dedup guarantee comes from the server's event keying (turnId/channel discipline already lets a stray superseded delta be ignored — the spec's at-most-once scenario rides that, not a new sequence protocol).
4. **Stores are two tiny injected interfaces.** `TokenStore { get(daemonId), set, delete }` and `ReplicaStore { load(daemonId), save }` — desktop/browser implement over `localStorage`/config; mobile later over Keychain/Keystore + filesystem. No abstraction beyond the two methods each shell actually needs.
5. **Replica cache stores the projected bootstrap surface only** (what `app.bootstrap` + the review list read paths return), saved on every successful reconcile, marked with its daemon identity and staleness timestamp. Reconciliation = re-running the normal bootstrap reads once `online`; no custom cursor protocol in this change (the tail/head cursor model is a daemon-side later step; the seam is shaped for it).
6. **Presence is a supervisor field, not traffic.** `setPresence({focused, visible, deviceClass})` records state and exposes it; nothing is sent until a daemon-side change defines the envelope. Keeps the M0 diff wire-silent.

## Risks / Trade-offs

- **Resubscribe duplicates.** If the daemon re-emits recent events on subscribe, consumers could double-see. Mitigation: rely on existing turnId/channel ignoring; the new e2e (mid-turn socket drop) asserts at-most-once on a real stream — it is the positive control.
- **Behavior-neutrality drift in the `ConnectionHost` seam widening.** Mitigation: adapter keeps the old `createBridge` signature working; existing e2e suites run unchanged.
- **Replica staleness lying.** Painting a replica must never read as live. Mitigation: the runtime exposes state + staleness timestamp together; the spec's offline scenario pins it, and UI wiring keeps the existing connection banners.
- **RN consumability regressions.** A stray `window`/`process` reference breaks the future shell silently. Mitigation: the package's lint boundary forbids DOM/Node globals outside the injected-store implementations, which live in the shells.
