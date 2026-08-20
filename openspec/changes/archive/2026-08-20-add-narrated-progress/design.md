# Design — add-narrated-progress (#71)

## Context

See `proposal.md` — Why. The load-bearing facts the approach builds on:

- `ProjectProcessing` (`packages/app-ui/src/components/project-processing.tsx`) already implements the full narrated-feed behaviour for one slot: a pure fold (`deriveView`) from an ordered `ProjectProcessEvent[]` into headline + per-repo trail with stage-collapse, plus honest degraded and failure modes. The fold is inline and private.
- The transport exists and is shared: `rennet:progress` (main → renderer), keyed by `commandId`, typed as `ProjectProcessEvent` (`packages/protocol/src/index.ts`), subscribed via `bridge.onProgress`. Dispatch owns the terminal `done` event so the stream and the resolved value always agree (`project.process` in `apps/desktop/src/main/dispatch.ts`).
- Proactive rehydration (`apps/desktop/src/main/proactive-rehydration.ts`) already narrates background passes on that same channel under a stable id (`PROACTIVE_REHYDRATION_COMMAND_ID`), broadcast to all windows. No renderer subscribes — its own handoff notes call the indicator "a one-line follow-up".
- The capture/review wait has no events at all: `review.capture` / regenerate run behind a `busy` boolean in `app.tsx` (busy-bar + disabled controls).
- There are TWO narration organs in this app and they must not be conflated: the **progress narration** (this change) and the **account narration** (`NarrationPanel`, roll-up accounts, #70, governed by `narration-prompt-grounding`). The second is model-voiced and untouched here.

## Goals / Non-Goals

**Goals:**

- One shared, pure, unit-tested progress-feed organ; three consumers; zero duplicate folds.
- Additive protocol evolution: existing `ProjectProcessEvent` consumers compile and behave unchanged.
- Resumability as a property of the transport keying, not a new persistence surface.

**Non-Goals:**

- No delight animation, no model garnish, no R35 change feed (proposal — out of scope).
- No persistence of progress events. A feed is ephemeral UI state; the artifacts it narrates are the durable things.
- No change to `narration-prompt-grounding` or any account-narration behaviour.
- No fix for the rehydration single-manifest eviction limitation (#143 known limitation, pinned by test) — surfacing the narration does not change the pass.

## Decisions

**D1 — Extract the organ from `ProjectProcessing`, don't write a new one.** The fold and trail rendering that already survived real use move to a shared component (working name `ProgressFeed`, deliberately NOT "narration panel" — that name is taken by the #70 organ). `ProjectProcessing` becomes its first consumer with byte-equal behaviour. *Alternative considered:* a fresh component matching the wireframe exactly — rejected; #72's lesson is to wire what exists, and the existing fold already implements stage-collapse (the done-ledger) and degraded modes.

**D2 — Widen the existing event union, additively.** The progress event type gains new `kind`s for the capture/review path (capture milestones, deterministic-floor completion, per-angle admission) alongside the existing repo/stage kinds. Hand-written Zod, discriminated by `kind`, same file and pattern as today. The shared fold treats unknown kinds tolerantly (skip, never throw) so the union can keep growing without breaking older consumers. *Alternative:* a parallel `ReviewProgressEvent` union — rejected; two unions on one channel forces every subscriber to speak both, and the wireframe's one-organ rule wants one vocabulary.

**D3 — Stable command ids; replay from a bounded in-memory buffer.** Processing progress is keyed by a deterministic per-run id derived from the project (the `PROACTIVE_REHYDRATION_COMMAND_ID` precedent) instead of a UUID minted per mount. Main keeps a bounded in-memory event log per live run; a subscriber arriving mid-run receives the backlog as a replay prefix, then live events; the terminal event ends and clears the buffer. This is what makes leave-and-return work without inventing persistence. *Alternatives:* persisting events to the store (rejected — durable truth is the artifact, not the wait), or re-deriving a synthetic "current state" query (rejected — a second source of truth that can disagree with the stream).

**D4 — The project card glyph is derived from the same subscription.** The projects list subscribes to live-run ids and shows the in-progress glyph while a run's terminal event has not arrived. No new IPC surface: same channel, same events, different consumer — exactly how the rehydration module said it should be consumed.

**D5 — Capture/review events come from the pipeline's real seams, emitted through the dispatch `emitProgress` context.** The capture path emits at milestones it already passes through (capture complete, floor complete, per-angle admission); dispatch keeps owning the terminal event so stream and resolved value agree (the `project.process` precedent). No seam is invented to narrate something the pipeline does not actually do. Zero-model completeness follows structurally: every emission site is deterministic; when the run is floor-only (utility port stubbed), the feed is complete for exactly what ran.

**D6 — Anchors are typed refs resolved at fold time, navigated by existing flow handlers.** A terminal/landed event carries what it produced (a project ref, a review ref); the fold surfaces an optional anchor on the line; consumers map anchor → existing navigation (open project detail, open review). No deep-link system, no routing rework. A line without an anchor renders as plain text (spec: honestly inert).

**D7 — The refresh indicator is ambient chrome, not a modal slot.** The renderer subscribes to the rehydration command id and renders the shared organ in compact form (the project-card glyph plus an unobtrusive line), never replacing the user's surface. *Alternative:* a toast/notification — rejected as interruption; the spec forbids takeover.

## Risks / Trade-offs

- [Widening the union breaks an exhaustive `switch` somewhere] → the shared fold's default case skips unknown kinds by design; typecheck the tree after widening; the DOM tests for `ProjectProcessing` must stay green untouched (behaviour-preservation check for the extraction).
- [Replay buffer growth on a pathological run] → bounded ring per run; oldest non-terminal entries drop first; the fold already tolerates a missing prefix (it synthesises blocks from the resolved summary — existing degraded path).
- [Two runs for one project collide on a stable id] → the id carries a run epoch; the fold keys on the newest epoch and ignores stragglers. One live run per project remains the invariant dispatch already implies.
- [The extraction silently changes processing behaviour] → `project-processing.dom.test.tsx` is the guard: it must pass unmodified against the refactored consumer (the literal-original-bug construction: reintroducing a bespoke fold divergence must redden it).
- [Per-angle admission events tempt someone to narrate model text] → event payloads carry counts/ids/titles from the pipeline's own records, never model prose; the zero-model test pins that the feed renders complete without any model output present.

## Migration Plan

Purely additive renderer + main change; no persisted formats touched, no flags needed. Ship in consumer order (extraction with behaviour-pinning tests first, then transport keying, then new consumers). Rollback is a revert; nothing durable depends on the events.

## Open Questions

- Exact placement/visual of the ambient refresh indicator (project card glyph is settled; whether a compact feed line also appears in the detail header can be decided at build time).
- Milestone granularity for the review path (which floor sub-steps earn a line) — tunable without spec change; the spec requires real seams, not a specific count.
