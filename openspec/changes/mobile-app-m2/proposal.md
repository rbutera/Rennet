# Mobile app M2 — act from the phone

## Why

M1 (merged) made the phone a truthful reader: pair, triage, read whole reviews, get pushed. The [mobile plan](../../../docs/src/content/docs/developing/reference/mobile-plan.md)'s M2 makes it an actor: watch a live turn, answer an ask (from the app or straight from the notification shade), post a review, and kick one off from a PR link or the share sheet. These are the jobs the design pass called headlines — the ask answered from the sofa and the one-tap post — and the attention families M1 left seam-only (handoff-completed, publish-ready) go live with the flows that raise them.

## What Changes

- **Live turn screen** (wireframe 22): the typed ask-stream timeline over `onAskStream` (already rebind-safe from M0), return-to-tail anchor, a visible Stop, and a composer with explicit interrupt-vs-queue send semantics; `review.reattach` paints persisted turn state on entry.
- **Ask answering**: chips + optional free-text redirection composed into one `review.ask` reply; drafts persist per review; a genuine turn failure renders truthfully.
- **Notification answer-actions**: the ask push carries its chips as notification actions; choosing one answers WITHOUT opening the app — the action round-trips to the daemon as the same `review.ask` reply (the paseo#306 lesson, and the plan's "answerable from the shade").
- **Publish flow** (wireframe 23): preview (the collated outbound review, verdict + destination visible) → one-tap post (`publish.requestConsent` + `publish.review` / `publish.submitPr`) → truthful posted screen with the real URL; "Ask for changes" routes to a refine turn, never phone-editing. No sign step, no confirmation ceremony — the post button is the click. **Both loops end on the phone** (Finding C, ruling (a)): a team-PR review posts via `publish.compose {mode: "review"}` (the daemon composes the byte-exact comments+verdict from the review's dispositions, using `@rennet/core`'s node-free composition) and the own-branch PR opens via `publish.compose {mode: "pr"}` + `publish.submitPr`. The phone previews exactly the bytes it posts.
- **Kickoff** (wireframe 20): paste a PR link → `review.openPr`; iOS/Android **share-sheet** entry for a shared PR URL; own-branch list → `review.capture`; progress via `onProgress`.
- **Attention families go live**: handoff-run-completed and publish-ready raised from their real daemon lifecycles; their pushes deep-link per the taxonomy.
- **M1 disclosed cuts closed where they block acting**: live proposal adjudication (`canvas.adjudicateProposal`) on the finding screen; delta-digest count tiles; canvas cohort grouping with judged-cohort collapse.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mobile-shell`: gains the acting requirements — live turn watching with stop and explicit send semantics, ask answering (app + notification action), the publish flow, and kickoff from PR link / share sheet / own branch.
- `attention-notifications`: the remaining two families (handoff-run-completed, publish-ready) become live-raised; the ask push carries answer actions and an action answer round-trips as a `review.ask` reply without the app opening.

## Impact

- `apps/mobile`: new turn/ask/publish/kickoff screens + share-sheet intent config; notification categories/actions.
- `packages/server`: raise/clear wiring for handoff-completed (from `review.handoff.run` outcomes) and publish-ready (from composed-draft readiness); notification-action reply ingestion (the action's payload lands as the review.ask answer — reusing the existing command, no new side channel).
- `packages/protocol`: only if the notification-action round-trip needs an additive field on the push payload (action descriptors); no new commands expected.
- Docs same-change: mobile guide (acting sections), delivery-order, mobile-plan M2 delivered.
- Issues: advances #383 (M2). Acceptance: mobile-plan M2 list (mid-turn reconnect stream continuity, ask answered three ways incl. from the shade, visible stop, one-tap post with exactly-one outcome, share-sheet kickoff, own-branch capture → post → exactly one PR).
