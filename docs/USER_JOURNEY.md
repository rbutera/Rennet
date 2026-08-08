# User journey

Rennet is a road from opening a change to signing the paper:

**Open → read through angles → dispose into the draft → collate/refine → sign the paper → delta re-review.**

Every UI issue must state its journey stage and what it shows of the destination. A widget without a journey fit is not sufficient product work.

| Stage | User outcome | Current status |
|---|---|---|
| 0. First run | Detect installed harnesses and local work without key/config ceremony. | Foundation exists; coherent first-run surface remains open. |
| 1. Home | Start from author-first local work; see incoming PRs and freshness alongside the work. | Open as an end-to-end product surface. |
| 2. Open review | Choose working-tree or PR source; create a pinned immutable patchset and see the intended destination. | Source/capture foundations built; destination framing is partial. |
| 3. Capture and decompose | Make the deterministic floor and live work narratable, never a spinner. | Pipeline/decomposition foundations built; polish and full proof remain open. |
| 4. Read angles | Zoom through six angles with fixed-point navigation and totality/residue. | Canvas, real diff, zoom, roll-up, anchored marks, and some angles are built; full angle depth remains open. |
| 5. Dispose = stage | Make a user-sovereign disposition at any granularity; it lands immediately in the draft. | Built, including span-grained authoring; refinement remains incomplete. |
| 6. Collation draft | Edit, merge, split, reorder, refine, and withdraw the forming outbound account. | Draft canvas is built; end-to-end refinement and destination polish remain open. |
| 7. Paper | Inspect precisely what leaves, then sign a review, PR preview, or handoff bundle. | Preview/safety/variants built; actual external submit and full handoff remain open. |
| 8. Delta re-review | After a coding harness works on the author branch, inspect only what changed and reopen ambiguity. | Underlying patchset/carry foundations exist; complete loop remains open. |

## Journey laws

- The destination is visible from review-open; the draft is editable glass and the paper is the frozen signed artifact.
- Disposition is staging; withdraw is unstaging; v1 signing is all-or-nothing.
- Old patchsets and stale analysis remain inspectable until explicit replacement succeeds.
- A coding agent never turns a human's prior reading into automatic approval of changed code.
- Prototype alignment applies at each stage; see [PRODUCT_VISION.md](./PRODUCT_VISION.md) and [DESIGN_DOCTRINE.md](./DESIGN_DOCTRINE.md).
