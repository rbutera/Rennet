# Design — polish sweep

Only the real decisions. Everything routine lives in tasks.

## #316 — where the shared per-review budget lives

**Decision:** a lazily created per-review intelligence session in MAIN — a `Map` keyed by `(reviewId, activePatchsetId)` holding `{ budget: InvocationBudget, hypothesis: Promise<ReviewHypothesis | undefined> }`. Both `buildCanvasesForReviewWithContextFeed` and `runFlaggedReviewWithContextFeed` draw from it.

- **Key:** `(reviewId, activePatchsetId)` — a reattach produces a new patchset, so the hypothesis re-derives and the ceiling resets for the new review turn. Not `headOid`: the patchset id already changes when the reviewed range changes.
- **Memoize the promise, not the value:** the canvas and flagged flows can start concurrently; storing the in-flight promise means the second flow awaits the first spend instead of double-spending.
- **One ceiling:** the session's budget is created once with `reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, deepReview)` at first entry. The advertised "one per-review turn ceiling" becomes literally that — one `InvocationBudget` instance across both flows, hypothesis + dual seats + verification all debiting the same counter.
- **No persistence, no eviction ceremony:** the map is process-local; entries are droppable on review close. `ponytail:` unbounded map per process lifetime — add eviction only if long sessions with many reviews measurably matter.

## #89 — which amendment option

**Decision:** (c) + (a) combined, as the proposal states: delete `harness` from the override type AND derive `harness = providerHarness(model)` after all overrides. (b) is struck by the Rule Zero amendment. Pure deletion: the two independent-pin lines (`model-council.ts:546`, `:560`) disappear with the field; the derivation already exists for the model-override path (`:543`, `:557`) and simply stops being overridable afterwards. The trace summary then cannot record an incoherent pair, fixing the residual provenance lie the issue names.

## #65 — rollup shape

**Decision:** keep the existing deterministic ordering (freshness by repoId, canvas state by canvas-angle order), emit the first K lines verbatim, then ONE tail line per section aggregating the rest: B2 `… +N more repos — X fresh / Y stale`; B3 `… +N more canvases — <aggregate counts in the existing count vocabulary>`. K is a named constant chosen so the 10-repo / 20-canvas acceptance fixture lands with real headroom (target ≤ ~3.5 KB), verified by the red-first test rather than arithmetic in prose. The throw stays as the backstop. No configuration knob — the cap is a product constant like `PRIMER_MAX_BYTES`.

## #92 — what is deliberately not built

Item 3 (JS/TS regex literals) stays as-is: the `/` divide-vs-literal ambiguity is context-sensitive; a line-local guess would mis-highlight `a / b` division, a worse lie than the current one. Recorded on the issue at close. Items 1–2 are per-grammar data (`commentNeedsWordBoundary: boolean` on `Grammar`; radix-specific digit predicates) — no new abstraction beyond the flag and predicates.
