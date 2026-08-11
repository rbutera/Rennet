## 1. Types: the shared diff shape

- [x] 1.1 Add `ElementDiff { path: string; diff: string }` and `ElementDiffs = Record<string, ElementDiff>` to `@rennet/types`

## 2. Core: the diff slicer (TDD)

- [x] 2.1 Test (red first): `buildElementDiffs(canvases, decomposition, patchset)` over a real patchset → the sequence chunk element's diff carries the real added/context lines (verbatim), path = the file; a doc-anchored element has no entry; `demoDiff` signature absent
- [x] 2.2 `element-diffs.ts`: parse `patchset.files[].patch` into verbatim raw `@@` hunks; map each decomposition `Hunk` to its containing raw hunk; resolve `chunk`/`hunk` anchors to distinct raw-hunk text (file order); doc anchors → no entry; synthetic-only → file `patch` fallback
- [x] 2.3 Test: hunk-anchor element resolves to that single hunk; split-fragment chunk collapses to its parent raw hunk once (no duplication); pure function (same inputs → identical output)

## 3. Core: deliver with the pipeline result

- [x] 3.1 `buildReviewCanvases` returns `elementDiffs` in `ReviewPipelineResult` (computed from the built canvases + decomposition + patchset)
- [x] 3.2 Test: `buildReviewCanvases` result carries `elementDiffs` for the sequence chunk elements on the floor path (no model)

## 4. Protocol: extend the `review.canvases` output

- [x] 4.1 Add a required `elementDiffs` map (`Record<string, {path, diff}>`) to the `review.canvases` output schema
- [x] 4.2 Update the existing round-trip test to include `elementDiffs`; add a round-trip assertion + a malformed-entry positive control

## 5. Desktop: pass it through

- [x] 5.1 `DispatchDeps.buildCanvases` returns `{ canvases, elementDiffs }`; the `review.canvases` handler returns both
- [x] 5.2 `buildCanvasesForReview` returns `{ canvases, elementDiffs }` from the pipeline result

## 6. UI: real diff on the real path, demo preserved

- [x] 6.1 `loadCanvases` returns `{ canvases, elementDiffs } | null`; update `load.test.ts`
- [x] 6.2 `RennetApp` stores `elementDiffs` + a `liveLoaded` flag; `diffFor` reads the real map when live, `demoDiff(400)` while the demo is up
- [x] 6.3 Read-verify the wiring; `demoCanvases()` / `demoDiff` fallback byte-unchanged

## 7. Gate

- [x] 7.1 `pnpm check` green (real checker, not tsgo); push; verify `origin==HEAD`; open PR (do not merge)
