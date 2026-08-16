# Design: hunk-grain beyond-asks delta re-review

## Context

See proposal.md for motivation. The load-bearing current state:

- `buildDeltaAccount` (`packages/core/src/delta-account.ts`) computes the shipped path-grain account inside `foldReview(PatchsetActivated)` (`packages/core/src/index.ts:640`) from `current.dispositions`, the lineage carry, and `changedPathsBetween(prior, successor)` — a per-path compare of raw `PatchFile.patch` text. The fold sees only the event; it has no view of any handoff bundle.
- `review.handoff.run` (`apps/desktop/src/main/dispatch.ts:1164`) verifies the composed bundle (`verifyComposedBundle`), runs the write turn, then calls `service.capture(commandId, root, reviewId)` — dropping the bundle on the floor at exactly the moment its `traceMap` and id-stamped asks (`ComposableAsk`: id + path/span/side/type) describe what the successor was asked to do.
- Structured hunks already exist: the decomposition floor parses `PatchFile.patch` into `RawHunk`s (`packages/core/src/decomposition.ts` ~line 88; a sibling private parser lives in `element-diffs.ts`). `@rennet/types` has `Hunk`, `AnchorSpan`, `AnchorSide`.
- `DeltaAccount`/`DeltaAskAccount` cross IPC inside `reviewSchema` (`packages/protocol/src/index.ts:250-288`) and are persisted with the review, so shape changes must be additive-optional.
- Consumers of the account: `delta-account-panel.tsx` (renders + `onAnchor(path)`), `delta-digest.ts` (M25 prompt built from only the account).

## Goals / Non-Goals

**Goals:**

- Hunk-grain beyond-asks computed deterministically from data already on the review (the two patchsets), so it works for regenerates as well as handoff runs.
- Consume the composed bundle's traceMap for per-ask task attribution — the spec-of-record hook, closed.
- Additive everywhere: persisted snapshots, IPC schema, and the panel all keep working on accounts without the new fields.

**Non-Goals:**

- Connecting the fuzzy sub-file lineage matcher (`lineage-matcher.ts`) to disposition carry. Not asked for by #73 or any spec; the carry stays the deterministic byte-verified one for the recorded reason (a confident fuzzy `move` can relocate a human's approval onto code they never read — see the closing comment block of `handoff-loop.ts` and issues #16/#254/#266).
- Per-ask status changes. `addressed`/`partially-addressed`/`untouched` semantics are untouched — they are already span-precise via the carry.
- Any new model call. The M25 digest seat is unchanged except for the extra facts in its prompt.

## Decisions

**D1 — Hunk identity is changed-line content, not position.** A successor hunk is NEW iff no hunk in the prior patch for that path (or its `previousPath` when renamed) has byte-identical added+deleted lines. Context lines and header line numbers are excluded from the identity, so pure line-number drift (the base moved, or an earlier hunk grew) produces no false beyond-ask claim — the failure mode `changedPathsBetween`'s doc comment already names. Duplicate identical hunks are matched by multiset (each prior hunk consumes at most one successor hunk). Alternative rejected: positional matching (oldStart proximity) — cheaper but lies under drift, and lying is the one thing this feature must not do.

**D2 — Reuse the decomposition floor's hunk parser; write no second diff parser.** Export the existing raw-hunk parse from `decomposition.ts` (or lift it into a shared module both import) and call it from `delta-account.ts`. `element-diffs.ts` keeps its private copy or migrates opportunistically — not required by this change.

**D3 — Ask coverage is spatial; task attribution is the traceMap's job.** A new hunk is covered by an ask when the ask is path-grained on the hunk's file, or the ask's span (at its carried current path; `side:"deletions"` matched against the hunk's old-file range, otherwise the new-file range) intersects the hunk's range. The traceMap deliberately does NOT attribute hunks: the write turn is one opaque agent session, so no per-task execution telemetry exists — claiming "task 2 caused this hunk" would be a guess, and the account must carry only verifiable facts. The traceMap's honest contribution is per-ASK attribution: which composed task (index + preview title) carried each ask, for the narration "ran as task 2 — 'Tighten the parser'".

**D4 — New shapes are additive-optional.**

```ts
// @rennet/types
interface DeltaBeyondHunk {
  readonly path: string;
  readonly span: AnchorSpan;            // new-file range; old-file range for a pure-deletion hunk
  readonly side?: AnchorSide;           // "deletions" on a pure-deletion hunk
  readonly bucket: "unasked-file" | "asked-file";
  readonly excerpt: string;             // first changed line, bounded — the human hook
}
interface DeltaAskAccount { /* existing fields …, plus */ 
  readonly handoffTask?: { readonly index: number; readonly title: string };
}
interface DeltaAccount { /* asks, beyondAsks unchanged, plus */
  readonly beyondAskHunks?: readonly DeltaBeyondHunk[]; // absent ⇒ path grain only
}
```

`beyondAsks` (paths) stays exactly as-is: it is the floor the truncation fallback and old snapshots rest on, and the protocol schema field the renderer already reads. Alternative rejected: replacing `beyondAsks` with structured entries — breaks every persisted account for no gain.

**D5 — The trace rides the capture, not a second fold pass.** `ReviewService.capture` gains an optional `handoff` argument (the bundle's id-stamped ask anchors, `traceMap`, and per-task titles — a small projection, not the whole bundle: no prompts, no contexts, no instruction bodies in the event log). It enters the idempotency `payloadDigest` and is stamped onto the `PatchsetActivated` event as an optional field, so the fold — the one place the account is computed — receives it. Fold-side, bundle asks are matched to review dispositions by the same anchor identity `buildHandoffBundle` used to mint the tasks (path + span + side + type). An unmatched ask (disposition changed between compose and run — the run handler already refuses stale bundles, so this is belt-and-braces) simply gets no attribution. Event version stays 1: the field is optional and absent for every existing event.

**D6 — Truncation falls back per-file, honestly.** If either side's patch for a file carries `DIFF_TRUNCATION_MARKER`, that file contributes no hunk claims; it participates at path grain only. When NO changed file yields hunk grain, `beyondAskHunks` may be an empty array (computed, nothing beyond) — distinct from absent (not computed / legacy account), and the panel treats them accordingly.

**D7 — Panel anchors through the existing span navigation.** `onAnchor` widens to `(path, span?, side?)`; `app.tsx` routes it into the same diff-navigation the deixis/pointing work established. Ask rows keep navigating to their span/path; beyond-hunk rows navigate to the hunk span. The `role="alert"` loud styling stays on the unasked-file bucket; asked-file hunks render in the same section with their bucket labeled — narration, not a second alarm.

## Risks / Trade-offs

- [Content-identity misses a real revert] A hunk the agent applied and then exactly reverted leaves no successor hunk — correct: nothing changed. A prior hunk that VANISHES from the successor (agent reverted the reviewed change itself) has no successor hunk to report; it still surfaces at path grain via `changedPathsBetween`'s removed-file/changed-patch arm. Accepted: hunk grain narrates what IS in the successor; the path floor catches disappearance.
- [Span-overlap coverage is generous] A hunk merely touching an asked span counts as the ask's answer, and an agent's fix that landed wholly outside the asked span shows up as beyond (asked-file bucket) even though it answers the ask. → The bucket's copy says "in a file you asked about, outside the asked lines" — a fact, not an accusation; #16 (mapping precision) owns doing better.
- [Event-log growth] The trace projection is bounded by ask count (ids + anchors + titles). No prompts or bodies enter the log.
- [Digest prompt growth] Hunk facts lengthen the M25 prompt on large deltas. → Cap the enumerated hunks (count named honestly, e.g. "and N more") the same way the account itself stays complete.
