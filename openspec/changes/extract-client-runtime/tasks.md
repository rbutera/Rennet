# Tasks — extract-client-runtime

## 1. Supervisor core (in `packages/client`)

- [x] 1.1 Add `ConnectionSupervisor`: wraps a `WsRennetBridge` factory; owns the `idle/connecting/online/offline/error` state machine with capped-backoff retry and terminal `error` on auth rejection; exposes `state`, `subscribe`, `bridge`.
- [x] 1.2 Move reconnect scheduling out of `WsRennetBridge` (bridge emits socket lifecycle; supervisor decides retry) keeping the bridge's correlation/fan-out untouched; unit tests for every transition incl. auth-terminal.
- [x] 1.3 In-flight invoke rejection on socket drop with a distinguishable connection error; queued-vs-reject invoke mode per design; unit tests.

## 2. Resubscribe registry (#389)

- [x] 2.1 Add the subscription registry: `onAskStream`/`onProgress` registrations survive the socket and replay onto every fresh socket; unregister on unsubscribe.
- [x] 2.2 Unit test: mid-turn reconnect re-delivers subsequent events to the same listener, at most once, without consumer re-subscribe.
- [ ] 2.3 Extend e2e with the positive control: kill the daemon socket mid-turn, assert the live ask stream resumes on reconnect (this is the #389 fix proof; must fail on today's main).

## 3. Stores

- [x] 3.1 Define `TokenStore` and `ReplicaStore` interfaces in `packages/client`; token values never logged (lint/test guard).
- [x] 3.2 Desktop/browser `TokenStore` impls in their shells (existing saved-target storage migrates in place, no user-visible change).
- [x] 3.3 Replica cache: save projected bootstrap surface per daemon on reconcile; expose `load` + staleness timestamp before connect; reconcile = normal bootstrap reads on `online`; unit tests incl. offline-open scenario.

## 4. Presence seam

- [x] 4.1 `setPresence({focused, visible, deviceClass})` on the supervisor: recorded, exposed, wire-silent; unit test asserting no traffic change.

## 5. Shell adoption (behavior-neutral)

- [x] 5.1 Widen `ConnectionHost`'s seam to accept the supervisor (`createConnection`), keeping a `createBridge` adapter so existing call sites/tests compile unchanged.
- [x] 5.2 Desktop renderer (`apps/desktop/src/renderer/index.tsx`) constructs its loopback + saved-remote connections through the supervisor.
- [x] 5.3 Browser shell (`apps/desktop/src/browser/entry.tsx`) likewise, including the serving-origin default target.
- [ ] 5.4 Run existing desktop + browser e2e suites unchanged — green is the behavior-neutrality proof.

## 6. Boundaries, docs, close-out

- [x] 6.1 Lint boundary: no DOM/Node globals in `packages/client` core paths (stores implemented in shells); Nx inputs/outputs declared for any new targets.
- [x] 6.2 Docs same-change: `architecture-overview.md` client wiring paragraph, `reactive-streams.md` reconnect note, `mobile-plan.md` M0 marked delivered; delivery-order wave entry.
- [ ] 6.3 Full `pnpm check`; PR references #383 (M0) and `Closes #389`.
