# Narrated progress: watch the AI work (#71)

## Why

While Rennet reads a repo or generates a review, waiting must never feel like a black box (#71). The survey that preceded this proposal found the core is **already built and live for one slot and built-but-dark for a second** — so this change is wiring and formalisation, not greenfield:

- **Processing (the initial context dump) already narrates.** `ProjectProcessing` (#29) renders a live feed of real `ProjectProcessEvent`s — the generator's actual stages with real details ("412 files"), a per-repo trail that collapses as stages complete, and a graceful degraded mode. It already *exceeds* the MVP spinner criterion, with zero model spend.
- **Refresh narration already broadcasts, and nobody listens.** Proactive rehydration (#143/#243) narrates its background snapshot passes on the SAME `rennet:progress` channel under a stable command id, reusing `ProjectProcessEvent` — by design, so a renderer indicator would be "a one-line follow-up". That follow-up was never wired; the narration is dark.
- **The capture/review wait is a mute busy-bar.** `review.capture`, regenerate, and the review pipeline run behind a boolean `busy` — disabled buttons and a `busy-bar` div. No feed, no events, no honesty about what the machine is doing.
- **The one-organ rule is unmet.** The resteer (2026-08-09, item 5 + fresh update 4) is explicit: stage-3 refresh and review-capture narration use *the same component* as the processing screen. Today the feed fold and rendering live inline in `ProjectProcessing`, reusable by nobody.

## What Changes

- **Extract the narration organ.** The event-fold and feed rendering inside `ProjectProcessing` become a shared narration-feed component (spinner-over-feed, done-ledger collapse, honest degraded mode). `ProjectProcessing` becomes its first consumer — same behaviour, no bespoke copy left behind.
- **Light up the dark refresh narration.** The renderer subscribes to the proactive-rehydration command id and shows the background pass through the shared organ (an ambient indicator, not a modal takeover) — the "one-line follow-up" the rehydration module was built for.
- **Give the capture/review wait a real feed.** The capture and review-generation path emits deterministic progress events (capture milestones, floor completion, per-angle admission — the pipeline's real seams) on the existing progress channel, and the wait renders the shared organ over them instead of a mute busy-bar. Plain spinner over a real feed: the MVP shape the issue names.
- **Feed lines anchor.** Tapping a *landed* line navigates to the artifact it produced (the processed project, the captured review); a line with no artifact is honestly inert, never a dead link.
- **Leave and return.** The processing build already continues in main when the user navigates away; the feed must survive the round trip. Progress keys on a stable per-project command id (the rehydration pattern) instead of a mount-minted UUID, the project card shows a progress glyph while a build runs, and returning re-attaches to the live feed or its completed summary.
- **Zero-model-call completeness, proven.** The feed is complete with no model calls: pinned by a test that runs the narrated slots with the utility port stubbed out.

**Explicitly out of scope** (post-MVP or future, listed so nobody folds them in):
- The delightful narrated animation (the rotating glass prism, "little agents fetching context") — promoted only once the rest of the app is worked out (resteer fresh update 4).
- Optional light-tier garnish lines (model-flavoured narration). The spec requires the feed be complete *without* them; adding them is a separate, later change.
- The R35 post-commit change feed. The docs mark it future; today's `rennet:progress` push is the transport and is sufficient here. Generalising to R35 is not this change.

## Capabilities

### New Capabilities
- `narrated-progress`: the shared narration-feed organ and its three consumers (processing, refresh, capture/review wait); deterministic progress events for the capture/review path; feed-line anchoring to landed artifacts; leave-and-return resumability with the project-card progress glyph; the zero-model-call completeness guarantee; and the no-bare-blank-surface floor (an honest spinner over a real feed, never a mute wall).

### Modified Capabilities
<!-- None. narration-prompt-grounding governs the OTHER narration organ (the zoom ladder's
     model-narrated accounts, #70) and is untouched. desktop-review-surface's read-progress
     requirement is unrelated to pipeline progress. The processing screen's existing behaviour
     is formalised, not changed. -->

## Impact

- **`packages/app-ui`** — new shared narration-feed component (extracted from `project-processing.tsx`'s fold + trail rendering); `ProjectProcessing` refactored to consume it; the capture/regenerate wait and the rehydration indicator become consumers; project card gains the in-progress glyph; feed-line anchor navigation.
- **`packages/protocol`** — the progress event union gains the capture/review milestones (extending the `ProjectProcessEvent` pattern, hand-written Zod, discriminated by `kind`); stable command-id convention for resumable feeds (the rehydration precedent, made explicit).
- **`apps/desktop/src/main`** — the capture/review pipeline path emits progress via the existing `emitProgress` context (dispatch keeps owning the terminal event so the stream and the resolved value always agree, the `project.process` precedent); processing progress re-broadcast under the stable per-project id so a re-mounted renderer can re-attach.
- **Testability** — the narrated slots run under a stubbed utility port to pin the zero-model-call guarantee; the shared organ's fold is pure and unit-tested once, not three times.
