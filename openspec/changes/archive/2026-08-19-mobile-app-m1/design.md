# Design — mobile-app-m1

## Context

M0 (merged) gives every shell the `ConnectionSupervisor`, resubscribe registry, `TokenStore`/`ReplicaStore` seams, and a wire-silent presence seam; the daemon broadcasts ask-stream deltas by review. The R19 projection ships checked-in JSON-Schema fixtures under `public-schema/` — the contract a remote client builds against. The wireframes (frames 19–21, 24) fix the screens and each screen's commands; the ideation doc fixes the six-event taxonomy and the connection model. The desktop kit's visual language (ink-vs-blue, the tokens in `wireframes/src/kit.mjs` and `packages/ui` tokens.css) is the look to transpose, but `packages/ui` itself is DOM-bound and is NOT consumable from React Native.

## Goals / Non-Goals

**Goals:**

- A phone that pairs once and is then a truthful, useful triage-and-read client — installable from a dev build, runnable against a daemon over Tailscale.
- The push pipeline end to end: daemon planner → Expo push → deep link → attention cleared.
- Every projection gap the phone hits closed by growing the projection, never a side channel.

**Non-Goals:**

- M2 scope: live turn streaming UI, ask answering (including notification answer-actions), publish flow, PR-link/share-sheet kickoff.
- Store/TestFlight distribution pipelines (M3); voice; tablets/landscape optimization.
- No RN-on-desktop, and no reuse of `packages/ui` components in RN — shared logic comes from `client`/`protocol` only.

## Decisions

1. **`apps/mobile` = Expo + expo-router, TypeScript, workspace app.** Nx integration via `@nx/expo@23.1.0` (exact workspace Nx version, per the dependency standard); inspect inferred targets with `nx show project` before adding manual config. Metro must resolve the pnpm workspace packages (`@rennet/client`, `@rennet/protocol`, `@rennet/types`) — standard Expo monorepo config, no forked tooling.
2. **Screens are RN-native, styled to the kit's language.** A small `apps/mobile/src/theme` transposes the design tokens (colors, radii, type scale) from the desktop system; components are written fresh per the wireframes. No component library dependency in M1 beyond Expo's own modules (camera, secure-store, notifications, linking) — the kit look is plain styles.
3. **Stores:** `TokenStore` over `expo-secure-store` (Keychain/Keystore); `ReplicaStore` over the app's file/async storage with `savedAt` stamped on persist. Both live in `apps/mobile`, implementing the M0 interfaces.
4. **Protocol additions (additive, COMPAT-tagged):** one command `device.registerPush` (input: push token + platform + optional replace/delete semantics; token-bearing connections only) and one client→daemon `presence` frame (focused / visible / deviceClass + the review in focus). The daemon advertises `attention` in handshake capabilities; the M0 presence seam transmits only when advertised (client-runtime delta spec). Projected schema fixtures regenerate as part of the change.
5. **Attention planner lives in `packages/server`,** fed by the existing event sources: ask-pending (the serverRequest/ask path), review pipeline outcomes, handoff run outcomes, publish-ready composition, `project.process` terminal events. Per event it computes recipients: connected-and-focused → live event only; every other registered device → push. Push posting via Expo's push HTTP API (an outbound call; failure logged, never fatal; dead tokens dropped). Push tokens persist in the existing SQLite store keyed by device id; revoke deletes.
6. **Deep links:** app scheme (`rennet://`) routes mirror the wireframe map (`/daemon/[id]/review/[reviewId]/digest`, `/ask`, `/publish`, `/project/[id]`). The push payload carries the route; expo-linking handles cold-start and warm routing. Attention-clear is an explicit acknowledgment invoke on landing (reusing the event's id), so clearing propagates to all clients.
7. **Testing without devices:** planner and registry are plain unit-tested server code; the projection consumption is contract-tested against the checked-in `public-schema/` fixtures; mobile logic (stores, routing table, list derivations) unit-tests under the workspace's runner with RN modules stubbed. A device/simulator smoke checklist documents the by-hand acceptance (pair over Tailscale, replica open, full-canvas read, backgrounded push) — automated device e2e is out of scope for M1.
8. **The full canvas at phone width** renders from the same projected canvas payloads the browser reads, via RN virtualized lists (cohort sections, finding cards, hunk blocks); judged cohorts collapse by default. Hunks mount lazily; no pagination of content — virtualization is the performance answer, truncation is banned by spec.

## Risks / Trade-offs

- **Expo/Nx integration friction** (pnpm + Metro + workspace packages): mitigated by using the official inference plugin at the exact Nx version and keeping `apps/mobile` free of Node-only imports; if `@nx/expo` inference fights the workspace, fall back to explicit targets wrapping the Expo CLI — documented, minimal.
- **Push delivery variance** (Expo service, device sleep): the in-app event path is authoritative; pushes are best-effort with dead-token cleanup. Acceptance tests the pipeline to the Expo API boundary; the device smoke checklist covers the last hop.
- **Presence correctness across reconnects:** presence re-sends on every `online` (client-runtime delta spec) and the planner treats silence as away — the failure mode is a spurious push, never a missed blocking event.
- **Scope pressure:** M1 deliberately ships reading + notification; anything that writes a turn (asks, publish) waits for M2 so the first cut stays shippable.
