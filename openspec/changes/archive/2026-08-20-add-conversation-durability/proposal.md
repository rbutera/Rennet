## Outcome

This change is retired. Issue #251 is closed. Streaming ask events and review reattachment remain current; durable conversation storage and the remaining process-lifecycle work are outside the product scope. Unchecked tasks record work that was not accepted and must not be treated as debt.

## Why

The inline review conversation (#36) is alive only inside the process that created it. If the app crashes or is quit mid-answer, the thread and its in-flight turn are gone, and any harness child process the turn spawned is left running. #251 makes a conversation **durable**: it survives the process, re-attaches to what is still in flight, surfaces honestly what can no longer be placed, and leaves no orphaned child behind. This is the failure-case half of the conversation cluster, deliberately split from #36 so the anchoring facet could ship without half-building this one.

No wireframe governs this facet: it is Electron-main infrastructure, and frames 06/14 already show the conversation surface #36 built. The one user-visible decision here — how an un-re-attachable thread looks — is designed to the same law the rest of the review heart follows: an unplaceable thing must look unplaceable, never clean.

## What Changes

- **Two-channel token streaming.** `review.ask` stops being one blocking call that returns a finished answer and becomes a stream of token deltas pushed main→renderer, coalesced under an **injected clock** into a live-updating message. A "both" ask streams the orchestrator and Codex channels concurrently. **Only the completed message is durable** — the coalesced deltas are never persisted (the model's own comment already promises this shape).
- **`PersistedThread`.** Conversation threads persist beyond the process that created them, extending the existing store pattern (`local-review-persistence`), carrying `harnessVersionAtCreation` and a per-turn status so a completed answer, a still-streaming turn, and an interrupted turn are distinguishable on reload.
- **Session re-attach, honestly scoped.** Two cases, both real: (1) the renderer reloads while **main is still alive** → it reconnects to the genuinely in-flight stream and resumes receiving deltas; (2) **main was killed** → durable state is restored and any turn that was mid-stream is surfaced as **interrupted**, never silently completed and never silently dropped. Literal re-attachment to a harness process that died with main is not possible and is not faked.
- **Thread-orphan surfacing.** On re-attach, a persisted thread whose anchor no longer resolves against the current diff (the code moved or vanished) is marked **orphaned** and shown as such — **never silently dropped, never silently re-anchored** to whatever now occupies those lines. Silent re-anchoring is the disposition-carry failure class (a human's words attached to code they never wrote them about) and is structurally refused here. Anchor identity is the structural key #36 already made collision-proof; this builds on it rather than inventing a second notion of thread identity.
- **Scoped child-PID reaping.** Every harness child spawned for a turn is recorded in a process registry at spawn time; on `before-quit` the app reaps exactly its own tracked children (scoped, never a blanket kill), so a killed app leaves no `codex`/`claude` harness process running.
- **Privacy holds across persistence.** A persisted-but-unmounted thread must not create a second path by which its text reaches published output. The #36 guarantee (`threadContentForPublish` is structurally empty; the sole private→published path is `promoteMessage`) is preserved and re-proven at the persistence boundary — the DOM-corpus scan cannot see an unmounted thread, so a dedicated persistence→publish proof covers that seam.

## Capabilities

### New Capabilities
- `conversation-durability`: token streaming under an injected clock, thread persistence with harness-version and turn-status, honest re-attach (live-stream reconnect vs interrupted-turn surface), thread-orphan surfacing, scoped child-PID reaping, and the persisted-thread privacy guarantee.

### Modified Capabilities
<!-- None. The privacy guarantee is a requirement OF the new capability, proven at its own boundary; it does not change the publish-safety-gate spec's requirements. Persistence extends the local-review-persistence store PATTERN without changing that capability's requirements. -->

## Impact

- **`packages/ui/src/canvas/conversation.ts`** — the pure model gains a turn-status and orphaned-anchor notion; the streaming seam stays `answerInThread` (completed message appended), plus a coalescing helper under an injected clock. No change to the privacy law.
- **`packages/protocol`** — `review.ask` moves from a single response to a streamed event contract (delta / done / interrupted), with hand-written Zod schemas (optional fields are not build-protected — added deliberately).
- **`packages/adapters`** — harness spawn sites (`codex-exec.ts`, the claude turn runners) register their child PID with an injected process registry; `harness-discovery.ts` supplies `harnessVersionAtCreation`.
- **`apps/desktop/src/main`** — `review-ask-live.ts` emits a stream instead of awaiting a whole turn; a new thread store (following `sqlite-review-store.ts`/file-store patterns) persists threads; a process registry is reaped in `index.ts` `before-quit`; dispatch gains re-attach + orphan-resolution handlers.
- **Testability** — every OS-level interruption seam (clock, process kill/list, persistence store, current-diff resolver) is injected so the failure cases (crash mid-stream, killed app, moved anchor) are unit-provable without a real Electron process or real harness spawn.
