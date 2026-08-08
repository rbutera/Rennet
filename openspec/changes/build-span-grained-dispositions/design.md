# Design — span-grained dispositions (#78, the keystone)

## The anchor shape (why file-line + side, not occurrence-relative)

```ts
export interface DispositionAnchor {
  path: string;
  contentDigest: string;      // digest of the whole file patch — the path-grained carry key (unchanged)
  span?: AnchorSpan;          // OPTIONAL: {startLine, endLine?} — 1-based FILE-LINE range on `side`
  side?: AnchorSide;          // "additions" | "deletions" | "context" — required iff span present
  spanDigest?: string;        // digest of the span's side-text at authoring time — the span carry key
}
```

`span`/`side`/`spanDigest` travel together: all three present ⟺ span-grained; all three absent ⟺ path-grained (today's shape). A protocol refinement enforces the coupling (partial presence is invalid).

**Why file lines, not the grammar's within-unit `AnchorSpan` ordinal.** The RSP anchor grammar's `AnchorSpan` addresses lines *within an occurrence* and resolves through the manifest / the CodeView's positional occurrence map (issue #84). A disposition must (a) carry across a re-capture by comparing the successor file's text and (b) feed #21's GitHub review threads, which take a **file line + side**. Anchoring by file line + side makes both operations read `Patchset.files[].patch` directly, registrar-independent — so **#78 sidesteps #84 at the data model**. (#84 still governs the UI conversion "selected CodeView row → file line + side"; that authoring conversion is out of #78's core scope and #78 adds no new positional assumption to it.)

`side` maps to the diff image the span reads: `additions`/`context` → the post-image (new-file) lines; `deletions` → the pre-image (old-file) lines. `extractSpanText(file, span, side)` parses the unified `@@ -a,b +c,d @@` hunks and returns the exact side-text at those file lines, or `undefined` when the span is out of bounds or the side has no such lines.

## Fold identity by full anchor

Today `DispositionSet` dedup and `DispositionCleared` key off `anchor.path`, so a second disposition on a file replaces the first. With spans, two dispositions on one file at different spans must coexist. `anchorKey(anchor)` returns a stable string: `path` for path-grained, `path#L<start>-L<end>@<side>` for span-grained.

- `DispositionSet`: dedup by `anchorKey`, sort by `anchorKey`.
- `DispositionCleared`: extend the event to carry the anchor key (or `{path, span, side}`); clear by `anchorKey`. Backward-compat: a path-grained clear (bare `path`) still clears the file-level disposition.

Red-proof: two spans on one file coexist after two sets; clearing one leaves the other; a path-grained + a span disposition on the same file coexist. Neuter `anchorKey` to return `path` only → the coexistence test reddens (the second set wipes the first).

## The carry — a two-tier design (Rai #48 ruling)

### Tier 1 — the deterministic floor (pure, in `carryDispositions` / `foldReview`)

```
carryDispositions(previous, next):
  for each prior disposition d:
    path-grained (no span): carry iff next has file at d.anchor.path with byte-identical whole-file patch (unchanged behaviour)
    span-grained: let t = extractSpanText(next.file[d.anchor.path], d.anchor.span, d.anchor.side)
                  carry iff t is defined AND sha256(t) === d.anchor.spanDigest
    else: DROP (fail-closed)
```

A span whose side-text is byte-identical at the same file-line coordinates carries even if the rest of the file changed — the genuine span-grained win over the file-level floor. A shifted-but-identical span fails the coordinate match and drops to Tier 2 (the judge). This is deliberate: the floor is cheap and strict; relevance-under-shift is the model's call.

Red-proof: an unchanged span carries; a one-byte edit inside the span → digest differs → NAMED carry test reddens → restore byte-identical → carries. An unchanged span whose file changed *elsewhere* still carries (proves span-grained beats file-grained). A shifted span (insert a line above) drops (fail-closed). Out-of-bounds / deleted file / side-gone → drop.

### Tier 2 — the relevance judge (the model layer above the floor)

The pure reducer cannot call a model, so the judge lives OUTSIDE `foldReview`:

```ts
interface RelevanceCandidate { disposition: Disposition; successorPatch?: string; }
interface RelevanceVerdict { carry: boolean; reAnchor?: DispositionAnchor; }
interface DispositionRelevanceJudge {
  judge(candidates: RelevanceCandidate[], patchset: Patchset): Promise<RelevanceVerdict[]>;
}
```

- `partitionCarry(previous, next) → { carried: Disposition[]; candidates: RelevanceCandidate[] }` — pure: the floor result + the dropped set (with each dropped disposition's successor patch text, if the file survives) as relevance candidates. (Verdicts array is positional to `candidates`.)
- `applyRelevanceVerdicts(candidates, verdicts, next) → Disposition[]` — pure: for each `carry: true`, produce the carried disposition, re-anchored to `verdict.reAnchor` when present; **fail-closed** if the re-anchor is out of bounds against `next` (an invalid re-anchor is dropped, never attached). Re-anchored span-grained carries recompute `spanDigest` from `next` so the carried disposition is self-consistent for the next re-capture.
- `carryWithRelevance(previous, next, judge) → Promise<{ carried; orphaned }>` — floor → judge on candidates → apply; union of floor-carried + judge-carried is `carried`, the rest is `orphaned` (the tray).
- `ReviewService.recaptureWithRelevance(commandId, repoPath, reviewId, judge)` — the live entrypoint: capture → `PatchsetActivated` (floor via fold) → run the judge on the dropped candidates → commit a `DispositionsCarried` event re-attaching the judge-approved (validated) dispositions. The default `capture()` stays floor-only.

**CI never runs a model.** Tests inject a `StubRelevanceJudge` returning canned verdicts. Red-proof: a stub that carries a shifted candidate → it re-attaches (proves the judge layer runs above the floor); a stub returning an out-of-bounds `reAnchor` → `applyRelevanceVerdicts` drops it (proves fail-closed); mutate `applyRelevanceVerdicts` to trust the re-anchor blindly → the fail-closed test reddens. A GREEN full pass follows every red-proof (Rule 81al: a red proves only the assertion that fired).

### The council job

`disposition-relevance-judge` → `JOB_CATALOGUE` as **light tier, batched** (it batches across all dropped candidates on a re-capture; bounded inference — it is handed the prior disposition + the successor patch, it does NOT go fetch code it was not given, so by the §1 tier test it is light, sibling to `disposition-triage`). The ruling's "medium model" is the **effort** knob: assignment tables mirror `disposition-triage` — Table 1 `gpt-5.6-luna medium`, Table 2 `haiku low`, Table 3 `gpt-5.6-luna medium`. The council test already asserts every model-facing job has all three table entries, so a missing entry reddens. Doc it in `docs/MODEL_COUNCIL.md` §2.2 (light-tier list) + the three tables + a §2.3-style note reconciling "medium model, light tier". Budget gate: routed through the existing `resolveAssignment` path, so the live budget gate (p0wwp fix, #81) already covers it — no new gate.

## The publish payload contract (#22 / #21 build on this once)

```ts
export interface PublishThread {
  path: string;
  line?: number;        // span-grained: end file line of the span
  startLine?: number;   // span-grained multi-line: the span start (omit when single-line)
  side?: "LEFT" | "RIGHT";  // deletions → LEFT (old file); additions/context → RIGHT (new file)
  body: string;
  type: DispositionType;
}
toPublishThread(disposition): PublishThread
```

- span-grained → `line = endLine ?? startLine`, `startLine` set only when `endLine > startLine`, `side` from the anchor side; feedable directly to #21's GitHub review-thread create (which forbids `position` and requires line/side).
- path-grained → file-level comment: `{path, body, type}`, no line/side (GitHub `subject_type: "file"`).

Red-proof: a span disposition on `additions` → `{line: endLine, side: "RIGHT"}`; on `deletions` → `side: "LEFT"`; a multi-line span → `startLine` + `line`; a path disposition → no line/side. Flip the side map (additions→LEFT) → the NAMED side test reddens.

## Scope boundaries (stay in lane)

- IN: the data model (span anchor), fold identity, the carry logic (floor + relevance judge), the council job, the publish payload contract.
- OUT: the CodeView span-selection UI (authoring — #77-area, and where #84 lives), the collation draft canvas UI (R40 reshape landing in parallel), the actual #21 GitHub wiring, the actual #22 publish sheet. This change hands those the contract; it does not build them.

## Machine notes for the implementer

- Gate via `sh -c 'cd <worktree> && pnpm check'` or `nx run <pkg>:typecheck --skip-nx-cache` — NEVER bare `pnpm exec tsc` (resolves to tsgo/native, silently accepts real type errors). Wrap EVERY git/pnpm/nx command in `sh -c '...'` (RTK hook mangles output → false pass).
- `packages/types` → `packages/protocol`/`packages/core` dependency arrows are enforced by eslint; the anchor types already live in `@rennet/types`, consumed by both — no new arrow.
- Every carry/anchor/payload test names its reddening mutation in a comment and is proven red then green.
