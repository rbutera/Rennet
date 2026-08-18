# Design — mobile-app-m2

## Context

M1 shipped the reading phone; M0 shipped the runtime. Everything M2 acts through already exists on the daemon: the streaming `review.ask` lifecycle (raises/clears attention), `review.reattach`, the publish engine (`publish.requestConsent` → `publish.review` / `publish.submitPr`, idempotent, "what you preview is what posts"), `review.openPr` / `review.capture` kickoff, and `review.handoff.run`. The desktop conversation UI (`packages/ui` conversation-host) is the behavioral reference for stream rendering — not a code source (DOM-bound). Wireframes 20/22/23 fix the screens; the ideation taxonomy fixes push behavior. The paper/signing metaphor is dead: preview → post, no ceremony.

## Goals / Non-Goals

**Goals:**

- The phone acts: watch, steer-adjacent answering, stop, post, kick off — every action riding existing commands.
- Shade answering that is trustworthy: exactly-once delivery semantics from a notification action, truthful failure.
- All six attention families live; the taxonomy's seams close.

**Non-Goals:**

- No general steering composer beyond the ask reply (free-form mid-turn steering of arbitrary turns is desktop parity work, not M2 acceptance).
- No voice input; no widgets/live activities; no store distribution (M3).
- No new protocol commands unless the shade-action payload genuinely needs one field (additive only).

## Decisions

1. **Turn screen = reattach paint + live stream.** Enter → `review.reattach` renders persisted thread state; the supervisor's `onAskStream` subscription (rebind-safe) appends live events. Timeline is a virtualized list reusing M1's canvas-row discipline; return-to-tail is a scroll-anchor state, Stop maps to the existing interrupt path of the streaming ask lifecycle.
2. **One reply shape.** Chips and free text compose client-side into the single `review.ask` reply string (chip label + newline + direction, matching how the desktop composes decisions with context). Send-mode (interrupt vs queue) uses the M0 supervisor's invoke semantics; drafts persist in AsyncStorage per review.
3. **Shade actions ride the push payload.** The ask push already carries substance; it gains the chip descriptors (additive field on the existing push payload — no new command). The app registers a notification category per ask push; the OS action handler posts the same `review.ask` reply through a background-capable path (Expo notification response in a headless task where the platform allows; where background execution is denied, the action opens the app pre-filled and sends immediately — still one tap, disclosed in the guide). Exactly-once: the reply carries the ask's turn id; the daemon's existing superseded-turn refusal is the dedup, and a refusal surfaces as the truthful failed-answer notification update.
4. **Publish flow is three screens, zero ceremony.** Preview renders the composed outbound review (the same payload bytes the engine will verify), post taps `publish.requestConsent` + the destination command; the posted screen shows the returned URL. Idempotency is the engine's (consent key + head-branch idempotence) — the app adds nothing. "Ask for changes" starts a refine turn and lands on the turn screen.
5. **Share sheet via Expo intent/config plugin** (Android intent filter + iOS share extension through the config plugin route); shared URL lands on the kickoff screen with the link applied. If the iOS share-extension plugin proves disproportionate this pass, Android intent + iOS universal-link paste path ship and the extension is a recorded follow-up — the acceptance keeps "share a PR URL to Rennet" on at least one platform and paste-everywhere.
6. **Family wiring:** handoff-completed raises where `review.handoff.run` resolves its outcome; publish-ready raises where the composed draft first becomes ready (the same dispatch point the desktop uses to enable its post survace), clears on post or on preview view per the clear-on-view rule.
7. **M1 cut closures:** proposal adjudication wires `canvas.adjudicateProposal` with the proposal ids the canvas payload carries; digest counts derive from the projected canvas/delta payloads client-side (no new protocol); cohort grouping folds the canvas rows under cohort headers with judged-collapse.

## Risks / Trade-offs

- **Background notification actions are platform-fickle** (iOS background execution limits). Mitigated by the decision-3 fallback (action opens app pre-filled + auto-send) and by the truthful failed-answer update — never a silently dropped answer.
- **Share-extension packaging friction on iOS** — mitigated by decision 5's staged fallback, recorded honestly.
- **Answer/turn races** (turn completes while the shade answer is in flight): the daemon's superseded-turn refusal is authoritative; the app/notification always reflects the refusal rather than pretending the answer landed.
- **Scope**: publish-ready raise point must not entangle with the publish engine's consent internals — it raises on readiness state, reads nothing secret, changes no egress semantics.
