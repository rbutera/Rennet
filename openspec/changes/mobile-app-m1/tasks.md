# Tasks — mobile-app-m1

## 1. Protocol additions (additive, COMPAT-tagged)

- [x] 1.1 `device.registerPush` command (token-bearing connections only; set/replace/delete push token per device) + `presence` client frame (focused/visible/deviceClass + focused review); daemon advertises `attention` capability in handshake; protocol-compatibility doc entry. (Also added the additive `attentionEvent` server→client frame and `attention.acknowledge` command — the live-event + clear wire the specs require. No R19 public-schema fixture changes: the additions carry no host paths, so `publicProjectionSchemas` is unchanged.)
- [x] 1.2 `packages/client`: transmit presence only when the daemon advertises `attention`; re-send current presence on every reconnect; unit tests both ways (delta spec scenarios) in `connection-supervisor.test.ts`.

## 2. Daemon attention system (`packages/server`)

- [x] 2.1 Push-token store (SQLite via `node:sqlite`, keyed by device id, `~/.rennet/push-tokens.sqlite`); revoke deletes (wired through the pairing-revoke path); unit tests in `push-token-store.test.ts`.
- [x] 2.2 Attention planner: six-event taxonomy (closed, sourced from the protocol enum), each with substance + deep-link route (`deepLinkFor`); per-client presence tracking in the listener; connected-and-focused → live event only, others → push; high-priority families always reach every client; silent (processing-finished) posts no push; unit tests per family and per presence case in `attention-planner.test.ts`. **Source wiring:** `review-finished` is wired to its real source (capture/openPr/regenerate in `dispatch.ts`). The other five families (ask-pending, turn-failed, handoff-completed, publish-ready, processing-finished) have the planner + registry + `raiseAttention` seam ready and are raised from their own sources as those flows are wired — several of those flows (asks, publish, handoff) are M2 scope. See the delivery note in the change docs.
- [x] 2.3 Expo push egress: outbound post, non-fatal failure, dead-token cleanup; tested to the API boundary with an injected fetch stub in `expo-push.test.ts`.
- [x] 2.4 Attention clear: `attention.acknowledge` invoke on landing; broadcasts the cleared ids to all clients; unit tests (handled once, quiet everywhere) in `ws-listener.test.ts` + `attention-planner.test.ts`.

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
