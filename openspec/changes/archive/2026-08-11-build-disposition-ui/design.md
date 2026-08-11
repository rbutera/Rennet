## Context

#11 (`build-canvas-ui`) shipped the canvas surface and left #17 the authoring depth. The relevant existing seams:

- `canvas/logic.ts` exports `fanOutApproval(canvas, scope, type, body)` → `DispositionWrite[]` for `ApprovalScope = rollup | cohort | selection | anchor`, and `canvasCoverage(canvas)` → `{ total, read, unread }` keyed on substrate paths (read = a disposition covers the path).
- `@rennet/core`'s `foldReview` carries dispositions across a `PatchsetActivated` via `carryDispositions` (conservative, byte-identical `path`+`contentDigest`, fails closed). The DROPPED dispositions are the orphans.
- The `Disposition` type (slice 1) anchors at FILE granularity: `{ anchor: { path, contentDigest }, type, body }`. Every L2 write therefore resolves to a path.
- `store.ts` holds ONLY ephemeral view state and explicitly "holds NO read state".
- Components are tested with `react-dom/server`'s `renderToStaticMarkup` — no DOM env (#53 open).

## Goals / Non-Goals

Goals: author at every altitude with a traceable act→writes fan-out; raw-draft body as the supported path; a batch view byte-identical to the publish payload with zero-residue withdraw; an action-defined three-state read fold that rebuilds from replay; a coverage mosaic + next-unread; an orphan tray on patchset advance.

Non-Goals: the #19 refinement loop (refined/published forms + inline thread); a jsdom/happy-dom interactive test env (#53); sub-file L2 anchoring (Spike 1 — line/hunk/symbol acts still resolve to file paths at L2, the finer altitude lives in the trace).

## Decisions

### Granularity resolves to paths; the altitude lives in the trace
Because slice-1 `Disposition` anchors on a path, every authoring act — at any of the six altitudes — fans out to per-path `DispositionWrite`s. The distinction between altitudes is preserved in an `AuthoringTrace { granularity, source, writes }`: one user act, the several writes it produced, and *what* was acted on (`rollup`, a `cohortKey`, an `elementKey`, a `hunkId`, or a `hunkId:Lspan`). This is exactly "a group act is ONE user act fanning to per-anchor L2", made assertable. `rollup`/`cohort`/`element`/`symbol` delegate to #11's `fanOutApproval`; `hunk`/`line` resolve the hunk → its containing chunk → the chunk's file paths from the L0 substrate.

### The batch is upsert-by-path, mirroring the engine
A `DispositionDraft` is `{ path, type, raw }` where `raw` is the sovereign body. The batch upserts by path (last write wins), exactly as `foldReview`'s `DispositionSet` replaces by path — so staging a roll-up then a specific element behaves identically to the engine. `batchPayload(batch)` sorts by path and serialises the `DispositionWrite` view (`{ path, type, body: raw }`); the batch VIEW renders that same derived list, so "view bytes == payload bytes" holds by construction. `withdrawDraft` removes the entry entirely, so its bytes vanish from the payload — verified with a unique sentinel at the byte level.

### Read-state is an order-independent max-rank fold over action-defined events
`ViewEvent = Actioned | ScrolledPast | Collapsed`. Per path, state = the max rank among its events (`Actioned`→`read` rank 2, `ScrolledPast`→`skimmed` rank 1), defaulting to `unread` (rank 0); `Collapsed` never raises rank, so collapse can never be read (OQ4). Max-rank is commutative, so replaying the same events in any order yields identical coverage — the replay-determinism criterion. `Actioned` events are derived from the review's dispositions (`dispositionsToViewEvents`), tying "read" to L2 actions and nothing else. The coverage mosaic projects the fold over the whole changeset's path set (default `unread` for a path with no events); `nextUnread` walks the reading order (wrapping) to the next `unread` cell.

### Orphans are a set difference, not a re-run of the carry
`orphanedDispositions(before, after)` = the `before` dispositions whose `path`+`contentDigest` key is absent from `after`. Since `foldReview` on activation already dropped the non-carrying dispositions, the tray is a pure difference on the two disposition lists — no core-private digest logic, no patch text, boundary-clean.

### Additive, optional workspace wiring
The new sections take new OPTIONAL props on `CanvasWorkspace`; with no props supplied nothing new renders, so #11's tests and demo are untouched. Components are SSR-string tested (the #11 pattern); interactive handlers are read-verified pending #53.

## Risks / Trade-offs

- Sub-file altitude is a trace label, not an L2 anchor, until Spike 1 lands finer anchoring — honest and documented; the fan-out already resolves to the correct paths.
- No interactive-DOM test for click handlers (#53). Mitigated: all decision logic is pure and unit-tested to red; components are rendered to static markup and asserted.
