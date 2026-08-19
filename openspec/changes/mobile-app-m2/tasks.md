# Tasks — mobile-app-m2

## 1. Live turn screen (wireframe 22)

- [x] 1.1 Turn screen: `review.reattach` paints persisted thread state, supervisor `onAskStream` appends live events; virtualized typed timeline (reuse the canvas-row discipline); return-to-tail anchor; unit tests on the timeline reducer (reattach + live fold, no double-render of a caught-up event).
- [x] 1.2 Stop control → the streaming ask interrupt path; interrupted outcome renders truthfully; test. (Added additive `review.interrupt` — no client interrupt seam existed; flagged to main. Finding A resolved: no ownership check (Rule Zero); the interrupted outcome LANDS in the persisted thread messages — `review.reattach` returns it in `threads` as `interrupted` with empty `inFlight`, asserted end-to-end against a real `FileThreadStore`; against a pre-M2 daemon Stop LOOKS disabled — the daemon advertises an additive `act` handshake feature and the phone gates Stop on `actAdvertised()` rather than silently no-opping.)
- [x] 1.3 Mid-turn continuity: test the reducer over a reconnect (rebind delivers later events exactly once — rides the M0 registry).

## 2. Ask answering

- [x] 2.1 Ask card: question + chips + free text composing ONE `review.ask` reply; explicit send-mode (send interrupts / hold queues via supervisor invoke semantics); per-review drafts in AsyncStorage; reducer/composer unit tests.
- [x] 2.2 Genuine turn failure renders truthfully (distinct from connection loss — the M0 ConnectionError discipline).

## 3. Shade answering (notification actions)

- [x] 3.1 Ask push payload gains chip descriptors (additive field); daemon includes them from the ask's live state; schema + planner tests. (Additive `actions` on `attentionItemSchema`, carried through planner + push; populated at the raise site — content producer is the future turn-ask seam, flagged to main. Finding B resolved: `actions` is optional and additive-only — an absent/empty-actions ask still renders a useful shade notification (question body + deep-link tap + in-app free-text; `shadeActionsFor(undefined) ⇒ []`, tested), losing nothing for today's real asks; the M1 refinement discipline holds — `attentionActionSchema` pins `id`/`label` to `z.string().min(1)`.)
- [x] 3.2 App registers notification categories/actions per ask push; response handler posts the same `review.ask` reply (background where the platform allows; otherwise open-prefilled-and-send). Routing/composer unit tests; platform behavior documented.
- [x] 3.3 Truthful outcome: superseded/unreachable answer updates the notification and deep-links into the ask; no silent drop, no duplicate (daemon's superseded-turn refusal is the dedup); tests both refusal paths.

## 4. Publish flow (wireframe 23)

- [x] 4.1 Preview screen: composed outbound review, verdict + destination visible; "Ask for changes" → refine turn; no editor, no ceremony.
- [x] 4.2 One-tap post: `publish.requestConsent` + `publish.review` / `publish.submitPr`; posted screen with the real URL; double-tap/retry test asserting exactly-one via the engine's idempotence; failure states truthful. (BOTH loops end on the phone — Finding C ruling (a). The daemon composes byte-exact via `publish.compose {mode}`: `"review"` → team-PR comments+verdict from `reviewCommentsFromDispositions` (new node-free `@rennet/core` fn) → posted via `publish.review`; `"pr"` → own-branch submission → `publish.submitPr`. The phone previews exactly the bytes it posts. Boundary note: `layer:ui` cannot import `layer:core`, so the ruling's ui-shim step is impossible AND unnecessary — core already owns the postable bytes; the daemon, not ui, composes. No ui file touched.)
- [x] 4.3 publish-ready family live: raises when a composed draft becomes ready, clears on post or preview view; planner + dispatch tests. (Raises off compose-readiness for BOTH modes now — `publish.compose` raises `publish-ready` on a successful `review`/`pr` compose, idempotent by derived id with the own-branch `review.draftPrBody` raise.)

## 5. Kickoff (wireframe 20)

- [x] 5.1 Paste-a-PR-link → `review.openPr` with `onProgress` streaming; own-branch list → `review.capture`; new review appears in the list; tests on the kickoff state machine.
- [x] 5.2 Share sheet: Android intent filter + iOS path per design decision 5 (config-plugin share extension, or the recorded fallback); shared URL lands on kickoff pre-filled; document platform coverage honestly. (Paste + `rennet://kickoff` deep link + Android share target ship; the OS share extension is the recorded follow-up.)

## 6. Remaining family + M1 cut closures

- [x] 6.1 handoff-completed raises from the real `review.handoff.run` outcome with delta summary substance; deep-link + clear tests.
- [x] 6.2 Live proposal adjudication on finding detail (`canvas.adjudicateProposal` with real proposal ids).
- [x] 6.3 Delta digest count tiles (client-side derivation) + full-canvas cohort grouping with judged-cohort collapse; virtualization discipline kept.

## 7. Close-out

- [x] 7.1 Docs same-change: mobile guide acting sections (watch, answer incl. shade behavior per platform, post, kickoff), delivery-order M2 entry, mobile-plan M2 delivered; protocol-compatibility note for the additive push field.
- [x] 7.2 Full `pnpm check` green (exit code captured directly, no pipes); `openspec validate mobile-app-m2 --strict`; report per-scenario test names. NO push; the reviewer opens the PR (`Refs #383`).
