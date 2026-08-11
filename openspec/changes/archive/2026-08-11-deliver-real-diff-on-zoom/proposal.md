## Why

After #54 the canvas STATE is real (derived from the real decomposition of the real diff), but zooming into a canvas element to see the code still renders `demoDiff(400)` — a synthetic fixture. `packages/ui/src/app.tsx` wires `diffFor={(k) => ({ path: k, diff: demoDiff(400) })}`, so the last mile of Rai's #1 product ask — "I want to see the actual code" — is unmet: the reviewer navigates real canvases but the diff surface is a fake.

The real hunk material already exists on the live path: `decompose` (#7) derives every chunk's hunks from the real `git diff`, and `buildReviewCanvases` (#54) already has the decomposition and the patchset in scope. Nothing delivers that hunk content to the UI's zoom surface.

## What Changes

- Add `buildElementDiffs` to `@rennet/core` (new `element-diffs.ts`): a **pure** function of `(canvases, decomposition, patchset)` that resolves each canvas element's `rennet:chunk/<id>` / `rennet:hunk/<id>` anchor to the **verbatim** raw-hunk text sliced from the real `patchset.files[].patch`. Doc-anchored elements (flat angles) resolve to nothing (no code diff). The output is `ElementDiffs = Record<elementKey, { path, diff }>`.
- Deliver `elementDiffs` with the canvas response: `buildReviewCanvases` returns it in its result; the `review.canvases` protocol output gains a required `elementDiffs` map; desktop dispatch passes it through.
- Wire the UI: `loadCanvases` returns `{ canvases, elementDiffs }`; `RennetApp` stores both and a `liveLoaded` flag, and `diffFor` reads the **real** map on the real path — falling back to `demoDiff(400)` **only** while the fixtures demo is on screen, so the demo never regresses.
- The diff text is byte-faithful to git (sliced verbatim from the captured patch, never reconstructed from separated add/del/context arrays), so the zoom shows exactly what was captured.

## Capabilities

### Modified Capabilities

- `live-review-pipeline`: the five-angle canvas set delivered over `review.canvases` now carries a per-element real diff map, so zooming into a canvas element renders the real captured hunk content instead of the `demoDiff` fixture.

## Impact

- Adds `packages/core/src/element-diffs.ts`; adds `ElementDiff`/`ElementDiffs` to `@rennet/types`; extends `buildReviewCanvases` in `packages/core/src/pipeline.ts`.
- Extends the `review.canvases` output schema in `packages/protocol/src/index.ts` (required `elementDiffs`).
- `apps/desktop/src/main/dispatch.ts` + `index.ts`: `buildCanvases` returns `{ canvases, elementDiffs }`; the handler returns both.
- `packages/ui/src/canvas/load.ts` + `app.tsx`: real diff on the real path, `demoDiff` preserved on the demo path.
- No new package, no new runtime dependency, no dependency-arrow change. `element-diffs.ts` is a pure string transform over `@rennet/types` + `parseAnchor` (already a `core → protocol` edge). `layer:ui` stays clean (the UI reads diffs over the bridge, never runs the slicer).
