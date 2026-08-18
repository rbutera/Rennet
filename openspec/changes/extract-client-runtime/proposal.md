# Extract the shared client runtime

## Why

Phase 6 (issue #383, unblocked by the #382 design pass) adds a third UI shell — the native mobile app — and the [mobile plan](../../../docs/src/content/docs/developing/reference/mobile-plan.md) names its first step M0: pull the client-side connection plumbing out of the shells into one shared package, so React components never construct transports, retry loops, or RPC clients. The seam already leaks: `WsRennetBridge` reconnects with backoff but its live `onAskStream`/`onProgress` subscriptions are not rebound to the reconnected socket mid-turn (issue #389, a liveness gap every phone network-change will hit), each shell wires its own bridge factory and token handling, and nothing paints last-known state before the socket opens. Extracting now — at the second/third consumer, not before — is the justified moment.

## What Changes

- New workspace package `packages/client-runtime` (working name; may land as an expansion of `packages/client`) owning:
  - **Connection supervisor**: probe, retry with capped backoff, network-change detection, a subscribable reachability state machine (`idle / connecting / online / offline / error`).
  - **Subscription manager**: an `onProgress` / `onAskStream` registry that re-establishes every live subscription on a reconnected socket — the client half of **#389**.
  - **Auth/token storage abstraction**: device-token persistence behind an injected store (config file on desktop/browser shells; Keychain/Keystore later on mobile).
  - **Replica cache**: last-known projected state persisted per daemon; paint instantly on open, reconcile by cursor.
  - **Presence reporting**: focus/visibility/device-type beacons the daemon's notification planner and bandwidth filter will consume (transport seam now; daemon-side consumption is a later Phase 6 change).
- Daemon bug fix (the server half of #389): ask-stream deltas broadcast to live authorized sockets by reviewId (mirroring the existing progress broadcast) instead of closing over the socket that invoked the turn. No new commands, no wire-shape change. Together the two halves **close #389 for every shell**.
- Browser shell (`apps/desktop/src/browser/entry.tsx`) and desktop renderer adopt the runtime **behavior-neutrally**: same commands, same streams, same UI — proven by the existing e2e suite.
- No protocol wire changes; no new commands. Presence beacons ride an additive, optional envelope only if the design finds a zero-cost slot — otherwise they stay a local no-op seam until the daemon-side change.

## Capabilities

### New Capabilities

- `client-runtime`: the shared client connection runtime — supervisor state machine, reconnect-with-resubscribe (ask-stream and progress rebind), token storage abstraction, replica cache paint-then-reconcile, presence beacon seam.

### Modified Capabilities

<!-- none: shell adoption is behavior-neutral; #389's fix is a requirement of the NEW capability -->

## Impact

- New package `packages/client-runtime` (or growth of `packages/client`) in the pnpm workspace + Nx graph; imports `protocol`/`types` only, per the dependency boundaries.
- `packages/client` (`WsRennetBridge`) — becomes the transport the runtime composes; its reconnect loop moves under the supervisor.
- `apps/desktop/src/browser/entry.tsx`, `apps/desktop/src/renderer/index.tsx`, `packages/ui` `ConnectionHost` seam — consume the runtime instead of hand-wired bridges.
- Existing desktop/browser e2e suites are the behavior-neutrality proof; a new mid-turn socket-drop test is the #389 positive control.
- Issues: opens the #383 arc (M0); closes #389 on completion.
