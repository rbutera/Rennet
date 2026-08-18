---
title: Mobile plan
description: The phase 6 build plan — screens to components to client-runtime needs, milestones with real sizes, and the acceptance list per milestone.
---

Deliverable 3 of the
[phase 6 gate](/developing/reference/app-server-plan/#the-phase-6-gate-the-mobile-design-pass)
([#382](https://github.com/rbutera/rennet/issues/382)): the impeccable
planning pass over the [ideation doc](/developing/reference/mobile-ideation/)
and the wireframe set (frames 19–24, `wireframes/src/mobile.mjs`). This page
is the concrete input to the Phase 6 OpenSpec change
([#383](https://github.com/rbutera/rennet/issues/383)).

## The brief, settled

- **Job and audience.** Rai (and any Rennet user) away from the desk:
  triage, answer, steer, read, post. Visitor mode is **Operate** — every
  screen is a task surface; scanability and truthful state outrank
  expression.
- **Direction.** The wireframes' visual world is the desktop kit's language
  (same tokens, same ink-vs-blue material law) compressed to stacked phone
  screens: overlay panels, bottom sheets, no persistent tab bar. Navigation
  is a stack scoped by daemon, mirroring the desktop breadcrumb spine.
- **Contract.** The app consumes the R19 projection and device tokens
  exclusively. Anything the phone needs that the projection lacks grows the
  projection — never a side channel.
- **Anti-goals.** No code editing, no host filesystem browser, no reduced
  "safe mode" client, no consent ceremonies (Rule Zero), no relay.

## Screens → components → client-runtime needs

Screens are the wireframe frames; components are the build units inside
them; the last column is what each screen demands from the shared
`client-runtime` package (the extraction scope, in aggregate).

| Screen (frame) | Components | Client-runtime needs |
| --- | --- | --- |
| Welcome / pair (19) | `PairScanner` (camera), `PairLinkEntry`, one-time-code field | `pairing.exchange` call; token persist to Keychain/Keystore |
| Connections (19) | `DaemonRow` (reachability, harness line), `DeviceTokenRow` | connection supervisor (probe, retry/backoff), multi-daemon registry, `harness.detect`/`pairing.listDevices` |
| Review list (20) | `ReviewRow` (status glyph, badges), pinned-section list, pull-to-refresh | replica cache (paint-then-reconcile), cross-daemon aggregation, attention flags |
| Kickoff (20) | `PrLinkField`, share-sheet intent handler, `BranchRow` | `review.openPr` / `review.capture` invocation, `onProgress` subscription |
| Review detail / digest (21) | `DigestStats`, `DeltaRow`, `CanvasEntryRow` | `review.load` + `review.deltaDigest` + `review.canvases` over the projection; cursor reconcile |
| Finding detail (21) | `FindingClaim`, `HunkView`, `DispositionBar`, `ProposalCard` | `canvas.*` invocations; optimistic disposition write-back |
| Full canvas (21) | `SequenceCanvas` (virtualized cohorts/findings/hunks, judged-cohort collapse) | `review.canvases` full read; `canvas.setCohortExpansion`; lazy hunk mounting |
| Live turn (22) | `TurnStream` (virtualized typed timeline), `ReturnToTail`, `StopControl`, `Composer` (interrupt/queue) | `onAskStream` subscribe + **rebind on reconnect (#389)**, `review.reattach`, send-mode semantics |
| Ask (22) | `AskCard` (chips + free text), context attachment row | `review.ask` reply composition (decision + redirection in one) |
| Publish (23) | `PaperPreview`, `PostedOutcome` | `publish.requestConsent` → `publish.review`/`publish.submitPr` on the one tap; idempotent retry handling |
| Pushes (24) | notification handlers, deep-link router, notification actions | push-token registration with the daemon; attention-event → route map; clear-on-view |

## The client-runtime package (extraction scope)

The first Phase 6 step, justified now that a third UI shell exists. Extract
from `packages/client` (today: `WsRennetBridge`) plus the browser/desktop
shells' connection plumbing, so React components never construct
transports, retry loops, or RPC clients:

1. **Transport + session** — `WsRennetBridge` as-is, plus handshake and
   protocol-version negotiation.
2. **Connection supervisor** — probe, retry with backoff, network-change
   detection, reachability state machine (idle/connecting/online/offline/
   error) surfaced as one subscribable.
3. **Auth** — device-token storage abstraction (Keychain/Keystore on
   mobile, config file on desktop shells).
4. **Replica cache** — last-known projected state persisted per daemon;
   paint instantly, reconcile by cursor.
5. **Subscription manager** — `onProgress`/`onAskStream` registry that
   rebinds every live subscription to a reconnected socket (**closes
   [#389](https://github.com/rbutera/rennet/issues/389)** for all shells,
   not just mobile).
6. **Presence reporting** — focus/visibility/device-type beacons the daemon
   uses for notification planning and bandwidth filtering.

Both existing shells adopt it behavior-neutrally, proven by the existing
e2e suite before any mobile code lands.

## Daemon-side work the plan surfaces

Named here so the OpenSpec change scopes them; the projection grows, the
app never gets a side channel:

- **Attention/notification planner** — per-client presence tracking; the
  six-event taxonomy from the ideation doc; per-event in-app-vs-push
  decision; push posting (Expo push service is the working assumption —
  confirm in the OpenSpec change; a push relay is an outbound daemon call,
  consistent with no-inbound-relay).
- **Presence-aware event filtering** — drop unfocused high-frequency stream
  events per client; attention-class events bypass.
- **Notification action round-trip** — an ask answered from the
  notification shade must land as a `review.ask` reply.

## Milestones

| # | Scope | Size | Ships when |
| --- | --- | --- | --- |
| M0 | `client-runtime` extraction; desktop + browser shells adopt; #389 fixed by the subscription manager | ~1 week | Existing e2e green on both shells; a mid-turn socket drop rebinds the live ask-stream |
| M1 — **first shippable cut** | Expo app skeleton; pairing + connections; review list; review detail/digest + finding detail + full canvas; push pipeline (taxonomy, deep links, presence-aware delivery) | ~2 weeks | See acceptance below |
| M2 | Live turn + ask (stream, composer, stop, notification actions); publish flow (preview → one-tap post); kickoff (PR link, share sheet, own-branch capture) | ~1.5 weeks | See acceptance below |
| M3 | Distribution (TestFlight/internal track); `using/` mobile guide; architecture-overview client row; marketing story | ~3–4 days | Docs land same-change; store publishing stays a later decision |

Total: roughly five working weeks, matching the app-server plan's 2–4 week
estimate plus the M0 extraction it always assumed.

### Acceptance — M1

- Pair a phone against a daemon over Tailscale by QR and by pasted link;
  token lands in Keychain/Keystore; revoke works from the phone.
- Review list paints from replica instantly offline and reconciles on
  connect; running and needs-you pin; freshness renders as a row fact.
- Open a finished review: digest counts, delta rows, finding detail; read
  the **whole review** in the full canvas to the last hunk without a
  dropped frame; set a disposition and see it on the desktop.
- "Review finished" push arrives with real counts while the app is
  backgrounded and deep-links to that review's digest; opening clears the
  attention flag; a client focused on that review gets no push.

### Acceptance — M2

- Watch a running review live; background the app, switch networks,
  return: the stream reattaches and no event is lost or duplicated.
- Answer an ask three ways: chip only, chip + free-text redirection, and
  from the notification shade without opening the app.
- Stop a running turn from the visible control; interrupted state renders
  truthfully.
- Post a team-PR review with one tap; the posted URL comes back; a
  double-tap yields exactly one review.
- Share a GitHub PR URL from another app into Rennet → review starts;
  capture an own branch → review → draft body → post → exactly one PR.

### Acceptance — M3

- Install via TestFlight on a clean device; pair and reach M1 acceptance
  with no developer tooling.
- The docs a new mobile user reads are true (`using/` guide, remote-access
  page, architecture overview).

## Open decisions the builder must not invent

- **Push service**: Expo push vs direct APNs/FCM — decide in the Phase 6
  OpenSpec change (working assumption: Expo).
- **Share-sheet packaging**: iOS share extension timing (M2 as designed,
  or M3 if Expo config-plugin friction bites).
- **Presence protocol shape**: beacon fields and cadence are
  protocol-compatibility work (COMPAT-tagged), designed in the OpenSpec
  change.
