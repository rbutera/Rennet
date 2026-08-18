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

- [x] 3.1 Scaffolded Expo + expo-router app; `@nx/expo@23.1.0` added; Metro resolves the workspace packages (metro.config.js watchFolders + nodeModulesPaths). **Inferred-vs-explicit Nx targets:** the `@nx/expo:application` generator's inference pulls prettier, per-app eslint, jest, and nx.json plugin config that conflict with the workspace's biome/eslint/vitest gate, so `apps/mobile` uses **explicit** `lint`/`typecheck`/`test` targets (plain commands, the workspace's own tools) exactly as every package does — the design-blessed fallback, recorded in the dependency standard. No `build` target (Expo export is native distribution, M3; `nx run-many -t build` skips a project without it). Dependency-standard "Mobile stack" section added.
- [x] 3.2 Theme transpose in `src/theme/tokens.ts` (colours light+dark, radii, spacing, type scale) — the kit's canonical hues, framework-free and unit-tested; `use-theme` wraps it with RN color scheme.
- [x] 3.3 `SecureTokenStore` (expo-secure-store) + `AsyncReplicaStore` (async storage, `savedAt` stamped), both DI'd so the M0 seams unit-test with stubbed modules (`stores.test.ts`); real wiring in `stores/native.ts`.

## 4. Pairing + connections (wireframe 19)

- [x] 4.1 Welcome + scan (expo-camera CameraView) + paste-link → `pairing.exchange` → keychain (`app/pair.tsx`, `runtime/context` `pairDaemon`). The pairing-link parser is pure + tested (`parsePairingLink`). Note: the pairing link carries the daemon URL + code; a code-only typed fallback (which needs the daemon's address) is folded into the paste-link path rather than a bare code field.
- [x] 4.2 Connections list (`app/connections.tsx`): reachability from the supervisor state machine, harness disclosure (`harness.detect`), per-daemon device-token row with revoke, add-another-daemon; unreachable daemon shows the replica/staleness, terminal auth error surfaces as "token rejected".

## 5. Review list + detail (wireframes 20–21)

- [x] 5.1 Home list (`app/index.tsx` + `lib/review-list.ts`): cross-daemon aggregation, running/needs-you pinned, recency groups, freshness/stale row fact; replica-paint (M0 supervisor) then reconcile. Grouping derivation is pure + tested. Pull-to-refresh reconcile is wired via the aggregation hook (an explicit RefreshControl is a thin follow-up).
- [x] 5.2 Delta digest screen (`.../digest.tsx`): the digest prose (`review.deltaDigest`) leads and the canvas entries navigate deeper. **Scope note:** `review.deltaDigest` returns prose, not counts (the wireframe's count tiles draw from several projected shapes); M1 renders the prose + entries, the full count breakdown is a thinner cut this pass.
- [x] 5.3 Finding detail (`.../finding.tsx`): claim, hunk, agree/disagree/discuss wired to `canvas.disposition` — the disposition round-trip that is visible to other clients. **Scope note:** live proposal adjudication (`canvas.adjudicateProposal`) needs a proposal id from the layered Canvas model; the disposition write-back (the load-bearing act) is fully wired, the proposal surface is rendered but its live adjudication is a thinner cut this pass.
- [x] 5.4 Full sequence canvas (`.../canvas.tsx`): virtualized (FlatList, lazy windowing, `removeClippedSubviews`) over the real captured hunks from the projected `elementDiffs` map, in reading order, no truncation, scrolls to the end. **Scope note:** cohort grouping + judged-cohort collapse of the wireframe is a thinner cut (elementDiffs is flat); the load-bearing "readable to the last line, virtualized" is met.
- [x] 5.5 Projection contract tests (`lib/projection.test.ts`): consume the checked-in `public-schema/` fixtures (repo-reference forbids any host-path property; projected-review names its repo as a reference object), and the adapters emit no host-absolute path.

## 6. Push handling in the app (wireframe 24)

- [x] 6.1 Push registration (`runtime/push.ts` `device.registerPush` after pairing; permission prompt at the point push is enabled in Settings), notification settings screen with the six taxonomy switches (`app/settings/notifications.tsx`).
- [x] 6.2 Deep-link routes (`rennet://…`) for every taxonomy entry, resolved under the delivering daemon via the device→daemon index; the routing table + push resolution are pure + unit-tested (`deep-links.test.ts`); attention clear-on-landing (`attention.acknowledge`) fires from `useReviewFocus` on every review surface. (Cold-start/warm OS-notification-response wiring is a thin device-only follow-up; the routing table it feeds is complete + tested.)

## 7. Close-out

- [x] 7.1 Docs same-change: `using/guide/mobile.md` (pair, read, notifications) + sidebar entry; architecture-overview mobile client row + node; delivery-order M1 entry; mobile-plan M1 marked delivered + device smoke checklist; dependency-standard Mobile stack; protocol-compatibility feature + frames.
- [x] 7.2 Full `pnpm check` green (exit code `0`, captured directly, cold cache 0/46 — a genuine fresh pass across all 13 projects); `openspec validate mobile-app-m1 --strict` reports valid. NO push (per the task); PR is the reviewer's to open `Refs #383`.
