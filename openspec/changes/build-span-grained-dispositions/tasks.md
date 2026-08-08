## 1. The span anchor (types + protocol, additive)

- [ ] 1.1 Extend `DispositionAnchor` in `@rennet/types`: optional `span?: AnchorSpan`, `side?: AnchorSide`, `spanDigest?: string`; doc that all-three-present ⟺ span-grained, all-absent ⟺ path-grained (file lines, 1-based, side-qualified). Re-export `AnchorSpan`/`AnchorSide` reuse (already exported).
- [ ] 1.2 Extend `dispositionAnchorSchema` in `@rennet/protocol`: optional `span` (`startLine` int ≥1, `endLine?` int ≥ startLine), `side` enum, `spanDigest` (min 1); a `.refine` enforcing all-three-or-none (partial presence invalid). Backward compat: bare `{path, contentDigest}` still valid.
- [ ] 1.3 Tests: a path-grained anchor validates; a full span anchor validates; a span-without-side / span-without-digest is REJECTED (name the reddening: drop the refine → the partial-anchor test reddens).

## 2. Full-anchor fold identity

- [ ] 2.1 `anchorKey(anchor)` in `@rennet/core`: `path` (path-grained) or `path#L<start>-L<end>@<side>` (span-grained), stable.
- [ ] 2.2 `foldReview` `DispositionSet`: dedup + sort by `anchorKey` (not bare `path`). `DispositionCleared`: extend the event to carry the anchor key (keep a bare-`path` clear working for path-grained); clear by `anchorKey`.
- [ ] 2.3 Tests: two spans on one file coexist after two sets; clearing one leaves the other; a path-grained + a span disposition on the same file coexist; a re-set on the same span replaces. Reddening: revert `anchorKey` to `path`-only → coexistence test reddens (second set wipes first).

## 3. Span-aware carry — the deterministic floor (pure)

- [ ] 3.1 `extractSpanText(file, span, side)`: parse `@@ -a,b +c,d @@` hunks; return the exact side-text at the 1-based file-line span (additions/context → post-image, deletions → pre-image), or `undefined` when out of bounds / side absent / file gone.
- [ ] 3.2 `carryDispositions` extended: path-grained → carry iff file byte-identical (unchanged); span-grained → carry iff `sha256(extractSpanText(...)) === spanDigest` and defined; else DROP. `foldReview` `PatchsetActivated` uses it (default `capture()` path stays floor-only).
- [ ] 3.3 Tests (each names its reddening mutation, proven red→green, then a full GREEN pass): unchanged span carries; one-byte edit in the span drops; unchanged span whose file changed ELSEWHERE still carries (span beats file-grained); a line inserted above the span shifts it → drops (fail-closed); out-of-bounds span drops; deleted file drops; side-gone drops; a path-grained disposition still carries file-byte-identical (regression).

## 4. `setDisposition` authors span anchors

- [ ] 4.1 `setDisposition` gains optional `span`/`side`; when present, `extractSpanText` from the active patchset's file, compute `spanDigest`, store the span anchor; when absent, path-grained (unchanged). Error if the span is out of bounds for the active file.
- [ ] 4.2 Tests: a span disposition round-trips (span + side + spanDigest stored); an out-of-bounds span at author time errors; a path-grained set is unchanged.

## 5. The relevance judge (Rai #48 ruling — the model layer above the floor)

- [ ] 5.1 Types: `RelevanceCandidate`, `RelevanceVerdict`, `DispositionRelevanceJudge` port; `DispositionsCarried` event field types.
- [ ] 5.2 `partitionCarry(previous, next) → {carried, candidates}` (pure): floor-carried + dropped set as candidates (each with the successor patch text when the file survives).
- [ ] 5.3 `applyRelevanceVerdicts(candidates, verdicts, next) → Disposition[]` (pure): carry `true` verdicts, re-anchor to `verdict.reAnchor` when present, recompute `spanDigest` from `next` for re-anchored spans; FAIL-CLOSED (drop) an out-of-bounds re-anchor.
- [ ] 5.4 `carryWithRelevance(previous, next, judge) → Promise<{carried, orphaned}>`: floor → judge(candidates) → apply; union carried, rest orphaned.
- [ ] 5.5 `ReviewService.recaptureWithRelevance(commandId, repoPath, reviewId, judge)`: capture → `PatchsetActivated` (floor) → judge the candidates → commit `DispositionsCarried` re-attaching validated approvals. Default `capture()` unchanged.
- [ ] 5.6 Tests with a `StubRelevanceJudge` (NO live model): a stub carrying a shifted candidate re-attaches (judge runs above the floor); a stub returning an out-of-bounds `reAnchor` is dropped (fail-closed) — reddening: make `applyRelevanceVerdicts` trust the re-anchor blindly → this test reddens; `carryWithRelevance` orphans everything the floor dropped and the judge declined. Prove red then a full GREEN pass.

## 6. The council job (registration)

- [ ] 6.1 `disposition-relevance-judge` → `JOB_CATALOGUE` (light tier, batched, sibling to `disposition-triage`); entries in all three assignment tables (Table 1 `gpt-5.6-luna medium`, Table 2 `haiku low`, Table 3 `gpt-5.6-luna medium`).
- [ ] 6.2 The existing council test (every model-facing job has all three table entries; tier ∈ {light,heavy}) stays green with the new job — add an explicit assertion the job resolves via `resolveAssignment` in the `both` scenario.
- [ ] 6.3 `docs/Rennet Model Council.md`: add to §2.2 light-tier list + the three assignment tables + a §2.3-style note reconciling "medium model (effort), light tier (bounded inference)"; note the live budget gate covers it via `resolveAssignment` (no new gate).

## 7. The publish payload contract (#22/#21 build on this once)

- [ ] 7.1 `PublishThread` type + `toPublishThread(disposition)` (pure): span → `line`/`startLine`/`side` (deletions→LEFT, additions/context→RIGHT); path → file-level (no line/side).
- [ ] 7.2 Tests: additions span → RIGHT + end line; deletions span → LEFT; multi-line span → startLine+line; single-line → line only; path disposition → no line/side. Reddening: flip the side map → the side test reddens.
- [ ] 7.3 Export `toPublishThread`, `carryWithRelevance`, `partitionCarry`, `applyRelevanceVerdicts`, `anchorKey`, the port + payload types from the package index files.

## 8. Gate + PR (#84 named, not deepened)

- [ ] 8.1 Design/PR text NAMES #84: authoring inherits it, the file-line+side data model is registrar-independent so carry/payload are #84-clean; #78 adds no new positional assumption.
- [ ] 8.2 Gate green UNCACHED: `nx run @rennet/types:typecheck --skip-nx-cache`, `@rennet/protocol`, `@rennet/core`, + `nx run @rennet/core:test`, `@rennet/protocol:test` (real checker, not tsgo). Confirm read-set sites (`canvas.ts`/`canvas-ops.ts`/`orchestrator-primer.ts`) untouched and green (every disposition still carries `anchor.path`).
- [ ] 8.3 Open PR (no merge) describing the span model + two-tier carry + payload contract; the orchestrator runs dual review + merge.
