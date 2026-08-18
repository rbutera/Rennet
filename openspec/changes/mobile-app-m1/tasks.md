# Tasks — mobile-app-m1

## 1. Protocol additions (additive, COMPAT-tagged)

- [ ] 1.1 `device.registerPush` command (token-bearing connections only; set/replace/delete push token per device) + `presence` client frame (focused/visible/deviceClass + focused review); daemon advertises `attention` capability in handshake; projected schema fixtures regenerated; protocol-compatibility doc entry.
- [ ] 1.2 `packages/client`: transmit presence only when the daemon advertises `attention`; re-send current presence on every reconnect; unit tests both ways (delta spec scenarios).

## 2. Daemon attention system (`packages/server`)

- [ ] 2.1 Push-token store (SQLite, keyed by device id); revoke deletes; unit tests.
- [ ] 2.2 Attention planner: six-event taxonomy wired to its real sources (ask pending, review finished, turn failed/interrupted, handoff run completed, publish-ready, processing finished), each with substance + deep-link route; per-client presence tracking; connected-and-focused → live event only, others → push; high-priority families always reach every client one way; unit tests per family and per presence case.
- [ ] 2.3 Expo push egress: outbound post, non-fatal failure, dead-token cleanup; test to the API boundary with a stub.
- [ ] 2.4 Attention clear: acknowledgment invoke on landing; propagates to all clients; unit test (handled once, quiet everywhere).

## 3. Expo app skeleton (`apps/mobile`)

- [ ] 3.1 Scaffold Expo + expo-router app in the workspace; `@nx/expo@23.1.0` added; Metro resolves `@rennet/client`/`protocol`/`types`; inferred targets inspected and recorded; lint/typecheck/test wired into the gate; dependency-standard entries for the Expo/RN set.
- [ ] 3.2 Theme transpose: kit tokens (colors, radii, type scale) as the app's theme module.
- [ ] 3.3 Mobile `TokenStore` (expo-secure-store) + `ReplicaStore` (async storage, `savedAt` stamped); unit tests with stubbed modules.

## 4. Pairing + connections (wireframe 19)

- [ ] 4.1 Welcome + scan (expo-camera) + paste-link + one-time-code entry → `pairing.exchange` → keychain; typed fallback path tested.
- [ ] 4.2 Connections list: reachability from the supervisor, harness disclosure, device token row with revoke, add-another-daemon; unreachable daemon shows replica + staleness, terminal auth error surfaces truthfully.

## 5. Review list + detail (wireframes 20–21)

- [ ] 5.1 Home list: cross-daemon aggregation, running/needs-you pinned, recency groups, freshness chip; replica-instant paint then cursor reconcile; pull-to-refresh.
- [ ] 5.2 Delta digest screen: counts, delta rows, canvas entries (`review.load`, `review.deltaDigest`, `review.canvases`, `flagged.review`).
- [ ] 5.3 Finding detail: claim, hunk, agree/disagree/discuss, proposal adjudication (`canvas.select`, `canvas.disposition`, `canvas.adjudicateProposal`, `flagged.adjudication`); disposition round-trip visible to other clients.
- [ ] 5.4 Full sequence canvas: virtualized cohorts/findings/hunks in reading order, judged-cohort collapse, lazy hunk mounting, no truncation; smooth-to-the-last-line check on a large fixture review.
- [ ] 5.5 Projection contract tests: screens consume the checked-in `public-schema/` fixtures; no host-absolute path ever renders.

## 6. Push handling in the app (wireframe 24)

- [ ] 6.1 Push registration flow (`device.registerPush` after pairing; permission prompt at the right moment), notification settings screen (six switches).
- [ ] 6.2 Deep-link routes (`rennet://…`) for every taxonomy entry; cold-start and warm routing; attention-clear acknowledgment on landing; unit tests on the routing table.

## 7. Close-out

- [ ] 7.1 Docs same-change: `using/` mobile guide (pair, read, notifications), architecture-overview client row, delivery-order M1 entry, mobile-plan M1 marked delivered; device smoke checklist recorded.
- [ ] 7.2 Full `pnpm check` green (exit code captured directly); openspec validate strict; PR `Refs #383`.
