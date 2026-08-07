# Design — deliver-real-diff-on-zoom

## Delivery path: canvas-response, not lazy `diff.read`

The `review.canvases` command is an on-demand fetch (opened Canvases view), not a stream. Delivering the per-element diffs **alongside** the canvas set is the cleaner path:

- One round-trip. `diffFor` stays synchronous (`(elementKey) => { path, diff } | undefined`) — no async plumbing into `CodeView`, no new IPC command, no per-element fetch storm on zoom.
- The payload is bounded by the captured patchset, which is already byte-bounded and truncatable (`Patchset.byteLength` / `truncated`). The diff map is a re-slice of bytes the response already implies; it is not heavier than the patch itself.

A lazy `diff.read` would add an IPC command, an async loading state in the zoom surface, and a round-trip per element — real cost for no benefit at this payload size. Reach for it only if a future changeset makes the eager map too heavy; the shape here (`Record<elementKey, {path, diff}>`) is the same data either way.

## Where the real hunk material lives, and how it is sliced

`decompose` (#7) parses each `patchset.files[].patch` into `Hunk`s, but stores the body as **separated** `addedLines` / `deletedLines` / `contextLines` arrays — the interleaved order is lost there. Reconstructing a diff from those arrays would **reorder** the lines (all deletions, then all additions), producing a plausible-but-wrong render. That is the exact failure to avoid: a viewer that silently transforms what it shows.

So the slicer goes back to the **verbatim** source: it re-parses `patchset.files[].patch` into raw `@@` hunks, keeping each hunk's header line and body lines exactly as captured, and maps each decomposition `Hunk` to the raw hunk whose new/old line range **contains** it. Non-split hunks match their raw hunk exactly; oversize split fragments (`splitOf`) fall within their parent raw hunk and collapse back to it (shown once, in full — real, never fabricated). Distinct raw hunks per element are rendered in file order.

Anchor resolution (`parseAnchor` from `@rennet/protocol`):
- `rennet:chunk/<chunkId>` → the chunk's `hunkIds` → their decomposition hunks → distinct raw hunks. Path = the chunk's file.
- `rennet:hunk/<hunkId>` → that one hunk → its raw hunk. Path = the hunk's file.
- anything else (`doc`, `spec`, …) → no entry. The flat-angle elements have no code diff; `diffFor` returns `undefined` and the zoom surface is simply not shown (honest, not fabricated).
- synthetic-only hunks (pure rename / mode-only / binary — no `@@` body) → fall back to the file's verbatim `patch` if it carries content, else no entry.

The slicer is a pure function of `(canvases, decomposition, patchset)`: no clock, no fs, no model. Same inputs → byte-identical `elementDiffs`.

## Why not touch the `Canvas` type

The `Canvas` / `AnalysisElement` shapes are frozen from #10 and carry a byte-identical-replay invariant (`canvasDigest`). Embedding diff text on each element would mutate that shape and bloat the canvas digest. The diff map is a **sibling** of the canvas set, keyed by the same `elementKey`, so the canvas projection stays byte-identical and the diff delivery is purely additive.

## Preserving the fixtures demo

`RennetApp` seeds `canvases` from `demoCanvases()` and replaces them on the first successful `loadCanvases`. A `liveLoaded` boolean records whether the on-screen canvases are the real set. `diffFor` branches on it: real map when `liveLoaded`, `demoDiff(400)` while the demo is up. The demo path is byte-unchanged; only the real path shows real code. A missing key on the real path (a doc-anchored element) yields `undefined`, and the zoom surface is correctly hidden rather than showing a fixture.

## Testing (no DOM env in `packages/ui`, per #53)

The strongest surface is core, and the acceptance criterion is a data-path assertion:
- `buildElementDiffs` / `buildReviewCanvases` over a real captured patchset → the sequence canvas's chunk element carries a diff whose lines trace to the **real** patch (exact added/context lines present) and whose text contains **no** `demoDiff` signature.
- Red-capable: without the delivery, `elementDiffs` is empty and the element lookup is `undefined` — the test fails.
- Protocol: the `review.canvases` output round-trips `elementDiffs`, and a malformed entry is rejected (positive control).
- UI: `load.test.ts` asserts `loadCanvases` returns the diffs; the `diffFor` wiring is read-verified + typecheck-covered (no DOM test env).
