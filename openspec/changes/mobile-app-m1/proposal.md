# Mobile app M1 — first shippable cut

## Why

Phase 6's design pass (#382, closed) and its [mobile plan](../../../docs/src/content/docs/developing/reference/mobile-plan.md) define M1 as the first shippable cut of the native app: pair a phone, see reviews, read one completely, and get pushed when something needs you. M0 (merged, #399) delivered the shared client runtime the app consumes; the daemon-side notification planner and the Expo shell are what remain to make a phone useful. The survey's clearest lesson (Codex mobile shipped without approval push and it is their #1 complaint) makes the push pipeline first-cut scope, not a follow-up.

## What Changes

- **New Expo app `apps/mobile`** (Expo + expo-router, mobile only — no RN-on-desktop), a full peer within its locus consuming the R19 projection and device tokens exclusively:
  - Pairing and connections (wireframe 19): QR scan (camera) + paste-link + one-time code → `pairing.exchange`; device token in the platform keychain via a mobile `TokenStore`; multi-daemon connections list with truthful reachability from the M0 supervisor; harness disclosure line; token revoke.
  - Review list (wireframe 20): reviews aggregated across paired daemons, running/needs-you pinned, recency groups, freshness as a row fact; replica paint-then-reconcile from the M0 `ReplicaStore` (mobile implementation over the app's storage).
  - Review detail (wireframe 21, all three screens): delta digest, finding detail with one-tap dispositions and proposal adjudication, and the **full sequence canvas** — the whole review readable at phone width, virtualized.
  - Notification handling (wireframe 24): push permission flow, deep-link routing per the ideation taxonomy, notification settings screen, clear-attention-on-view.
- **Daemon-side attention/notification planner** (the ideation doc's six-event taxonomy): per-client presence tracking, per-event in-app-vs-push decision (a client focused on the review gets the live event only), push delivery via the Expo push service (an outbound daemon call, consistent with no-inbound-relay), deep-link payloads, attention flags cleared on view.
- **Protocol growth (additive, COMPAT-tagged; the projection grows — never a side channel):** a push-token registration command for a paired device, and a presence frame the client sends — the M0 presence seam goes live when the daemon advertises support.
- **Toolchain:** `@nx/expo` at the workspace's exact Nx version (23.1.0) with inferred targets inspected before any manual target config; Expo SDK and RN deps admitted per the dependency standard.
- Out of M1 (lands M2, per the plan): live turn streaming UI, ask answering, notification answer-actions, publish flow, kickoff from PR link / share sheet.

## Capabilities

### New Capabilities

- `mobile-shell`: the native app's first cut — pairing/connections, review list, review detail (digest, finding, full canvas), notification handling and deep links, all over the R19 projection with truthful reachability and replica painting.
- `attention-notifications`: the daemon's attention system — the closed six-event taxonomy, presence-aware delivery planning, Expo push posting, push-token registry, attention flags and their clearing.

### Modified Capabilities

- `client-runtime`: the presence seam's "wire-silent" requirement changes — presence transmits when (and only when) the connected daemon advertises the capability; otherwise the seam stays silent, so M0-era daemons are unaffected.

## Impact

- New `apps/mobile` (Expo) in the pnpm workspace + Nx graph; new dev dependency `@nx/expo@23.1.0`; Expo SDK/RN dependency set per the dependency standard; `apps/mobile` may import `client`, `protocol`, `types` only.
- `packages/server`: attention planner, presence consumption, push-token store (SQLite, `~/.rennet`), Expo push egress; `packages/protocol`: additive command(s) + presence frame, COMPAT-tagged, projected schemas regenerated.
- `packages/client`: presence transmission gated on daemon capability advertisement.
- Docs same-change: mobile guide start (`using/`), architecture-overview client row, protocol-compatibility entry for the additions, delivery-order.
- Issues: advances #383 (M1 of its plan). Acceptance: mobile-plan M1 list (pair over Tailscale, replica-instant list, whole review readable, backgrounded push with deep link + presence suppression).
