## 1. Pure model: turn status, orphaned anchor, stream coalescer (layer:ui, no Electron)

- [x] 1.1 Add a per-turn status (`streaming` | `complete` | `interrupted`) and an `orphaned` flag to the conversation model in `packages/app-ui/src/canvas/conversation.ts`, without changing the privacy law or the `answerInThread` completed-message shape. Unit-test the state transitions.
- [x] 1.2 Add a pure `StreamCoalescer` (clock/scheduler injected) that folds a `(turnId, channel)` delta sequence into one body; unit-test that a replayed sequence under a hand-advanced fake clock is byte-identical every run (spec: clock-driven coalescing).
- [x] 1.3 Prove two channels coalesce independently: orchestrator completes with its full body while the Codex channel is marked failed, not empty-success. Red-proof: make the coalescer share one buffer across channels and watch the independence test fire.

## 2. Protocol: streamed review.ask contract

- [x] 2.1 In `packages/protocol`, add the streamed event schemas — `{ threadId, turnId, channel, delta }`, terminal `{ …, done, finalBody }`, and `{ …, interrupted }` — and the `review.reattach` + orphan-resolution command shapes. Hand-write every Zod schema; the new fields are optional (not build-protected), so add each deliberately.
- [x] 2.2 Schema round-trip tests for every new event/command, including a rejection test proving an event with an unknown/missing `turnId` does not validate (a stray delta must be droppable). Red-proof: drop `turnId` from a schema and watch the round-trip test fire.

## 3. Persistence: ThreadStore extending the store pattern

- [ ] 3.1 Add a `ThreadStore` in `packages/adapters` mirroring `sqlite-review-store.ts` / the file-store pattern, persisting `PersistedThread { thread, harnessVersionAtCreation, turns: TurnRecord[] }`; a `streaming` `TurnRecord` carries no body. Inject it so dispatch is tested against an in-memory fake.
- [ ] 3.2 Implement the crash-recovery read transform: any record left `streaming` at store-open reads as `interrupted`. Red-proof: delete the transform and watch the "killed-mid-stream reads interrupted" test fabricate a completion.
- [ ] 3.3 Prove only completed messages persist: a mid-stream turn leaves no completed harness message; completion writes exactly one durable `ThreadMessage` recoverable unchanged.

## 4. Adapters: PID registration + harness version at creation

- [ ] 4.1 Add an injected `ProcessRegistry` (register on spawn, deregister on natural exit, `reapAll()` signalling only tracked live PIDs). Register the harness child in `codex-exec.ts` and the claude turn runner spawn sites.
- [ ] 4.2 Source `harnessVersionAtCreation` from `harness-discovery.ts` at thread creation and thread it into the `PersistedThread`.
- [ ] 4.3 Unit-test scoped reaping: `reapAll()` signals exactly the registered live PIDs; a negative control (an unregistered, same-named process) is untouched. Red-proof: switch the reaper to a name-based kill and watch the negative control fire.

## 5. Main: streaming live seat, live-turn registry, dispatch handlers

- [ ] 5.1 Convert `review-ask-live.ts` from awaiting a whole turn to emitting the streamed events per channel (delta → done | interrupted), keeping the #139 router's law untouched (streaming changes transport, not routing).
- [ ] 5.2 Add a main-side `LiveTurnRegistry` keyed by `turnId` holding in-flight turns; wire the streamed events through dispatch to the renderer, and persist the completed message on `done` via the `ThreadStore`.
- [ ] 5.3 Add the `review.reattach` dispatch handler: returns the in-flight `turnId`s (main-alive case) so a reloaded renderer re-subscribes to the same coalesced message (dedup on `turnId`, never anchor key).
- [ ] 5.4 Add the orphan-resolution path: on re-attach, an injected `AnchorResolver` resolves each persisted thread's anchor against the current diff; an unresolved thread is stamped `orphaned`. The resolver exposes only resolves/does-not-resolve — no nearest-match substitution. Red-proof: add a nearest-match fallback and watch the "re-anchoring refused" test fire.

## 6. Main: scoped reaping on quit

- [ ] 6.1 Call `processRegistry.reapAll()` in `index.ts` `before-quit` alongside the existing `store?.close()` / `watcher.close()`. Test that reaching before-quit signals every tracked child and leaves none running.

## 7. Renderer: live message, re-attach, orphan surface

- [ ] 7.1 Wire the renderer to feed streamed deltas through the `StreamCoalescer` into one live-updating harness message, committing the durable message on `done` via `answerInThread`; an interrupted turn renders as interrupted, never as a completed answer.
- [ ] 7.2 On review load / renderer reload, call `review.reattach` and resume any in-flight turn without duplicating or losing the message (whole-app DOM test).
- [ ] 7.3 Surface an orphaned thread honestly in the review heart (present, labelled orphaned, content preserved, not attached to any current line) — matching the "unplaceable looks unplaceable" law.

## 8. Privacy proof at the persistence boundary

- [ ] 8.1 Add the persisted-but-unmounted publish proof: persist a thread with a distinctive canary body, do NOT mount it, publish a review, and assert the canary is absent from both the structured payload values and the paper. Red-proof: route a persisted body into the payload and watch it fire. (Compare structured values, not a serialisation — the #36 transformed-needle lesson.)

## 9. Gate, reconcile, hand off

- [ ] 9.1 Run the full `NX_DAEMON=false pnpm check`; confirm exit 0 and `Successfully ran target`, reconcile the test total against the baseline (main post-#36 ≈ 2277/7 — verify, do not trust the number), commit per-group with descriptive messages, push the branch, and report the tip, counted whole-branch diff, gate total, and anything scoped out (e.g. harness grandchildren) named specifically. Do NOT self-review; the orchestrator owns the gate. On merge, archive this OpenSpec change on the real outcome.
