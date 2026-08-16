## 1. Composition core (SHIPPED in d1b41e6 — specced here, not re-implemented)

- [x] 1.1 `asksFromBundle` stamps each mechanical task with a stable deterministic id; the same disposition set always yields the same ids (`packages/core/src/handoff-compose.ts`).
- [x] 1.2 `buildComposePrompt` hands the model the asks WITH ids and constrains it to return only a partition (order + grouping + a per-group title), never bodies.
- [x] 1.3 `validateComposition` requires a TOTAL COVER of the ask ids — rejects a dropped id, a duplicated id, or an invented id.
- [x] 1.4 `composeHandoffBundle` reconstructs bodies from the trusted input by id, asserts every original body survived into the rendered prompt, and returns `composed:true`; on unavailable / failed / thrown port / invalid partition it returns the mechanical floor (`composed:false`). Unit-tested and red-proofed in the shipped commit.
- [x] 1.5 `renderComposedPrompt` derives each task heading MECHANICALLY from the trusted ask paths; the model's `title` never enters the executable prompt.
- [x] 1.6 `ComposedHandoffBundle.traceMap` maps every input ask id to its task index, each id exactly once (the forward hook #73 will consume; not consumed here).

> §1 documents behaviour already on `origin/main`. The spec delta in `specs/handoff-bundle-composition/spec.md` promotes it to requirements of record. No code changes in §1.

## 2. Run the composed bundle (the headline wiring gap)

- [x] 2.1 Change the `review.handoff.run` protocol contract so the bundle it runs is the composed one (carry the `ComposedHandoffBundle`, or the digest of the bundle prepared for this run), not a re-derivation from `dispositions`. Hand-write the Zod, reusing `composedHandoffBundleSchema`; the new/changed field is added deliberately.
- [x] 2.2 In `dispatch.ts`, make the `review.handoff.run` handler execute `ComposedHandoffBundle.prompt` (the composed, ordered work order) instead of rebuilding a mechanical bundle from `input.dispositions`. Bind the run to the composed bundle's `digest`.
- [x] 2.3 Refuse a silent mechanical substitution: once a `composed:true` bundle was prepared for a run, a mechanical rebuild at run time is rejected (re-prepare, never run-anyway). A legitimately-composed floor (`composed:false` because the model was unavailable) remains runnable. Red-proof: restore the mechanical rebuild and watch the "run executes the composed order" test fire.
- [x] 2.4 Prove the order survives to the turn: a two-ask bundle the model REVERSED reaches the write turn's prompt reversed, and a two-ask bundle the model MERGED reaches it as one task. (Assert on the prompt handed to `runHandoffTurn`, not on the dispositions.)

## 3. Stage-6 handoff preview on the paper

- [x] 3.1 Add a pure `handoffPreview(bundle: ComposedHandoffBundle)` view-model in `packages/ui/src/canvas/publish.ts` (layer:ui, `@rennet/types` only): ordered tasks, each task's member asks (path, anchor, effective body), each task's `title` marked PREVIEW-ONLY, and the `composed` flag surfaced. Unit-test it.
- [x] 3.2 Render the preview on the own-branch paper at journey stage 6, reading the same `tasks`/`prompt` the run executes ("what you see is what leaves"). A `composed:false` floor renders honestly as an un-composed list, never dressed as authored prose.
- [x] 3.3 Prove the preview cannot show a different order than the run executes: a whole-app / component test that the previewed task order equals the order carried into `review.handoff.run`. Red-proof: sort the preview independently and watch it fire.

## 4. Spec promotion, gate, reconcile

- [x] 4.1 Land `specs/handoff-bundle-composition/spec.md` as the capability spec of record; reference (do NOT delta) `model-council`'s existing handoff-bundle routing entry.
- [x] 4.2 Run the full gate (`NX_DAEMON=false pnpm check` or the repo's canonical target); confirm exit 0 AND `Successfully ran target`; reconcile the test total against the baseline (verify the number, do not trust it). Commit per-group with descriptive messages, push the branch, report the tip sha, the counted whole-branch diff, the gate total, and anything scoped out (#73 traceMap consumption) named specifically.
- [x] 4.3 Do NOT self-review; the orchestrator owns the gate. On merge, archive this OpenSpec change on the real outcome.
