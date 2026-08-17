# Design — polish sweep

Only the real decisions. Everything routine lives in tasks.

## #316 — where the shared per-review budget lives

**Decision:** a turn-aware per-review intelligence session owned by the MAIN dispatch composition. The current session for `(reviewId, activePatchsetId)` holds one `InvocationBudget` plus the in-flight hypothesis promise. Both `buildCanvasesForReviewWithContextFeed` and `runFlaggedReviewWithContextFeed` receive that session from dispatch rather than looking it up independently.

- **Turn lifecycle:** the first `flagged.review` and `review.canvases` dispatches for a review turn may arrive in either order and share one same-mode session. Re-entering either flow for the same review and patchset starts a fresh turn, so Quick↔Dual toggles and canvas retries get a fresh budget and hypothesis attempt. After both flows have joined, the coordinator drops its entry; the running pipelines retain the shared object without an immortal session-map value.
- **Mode authority:** the renderer sends the same explicit `deepReview` choice to both commands. The flagged flow determines the normal open/toggle ceiling, while a standalone canvas retry provisions the same explicit mode; there is no hardcoded deep-review ceiling and arrival order cannot change the maximum.
- **Memoize only an in-flight or successful hypothesis:** concurrent callers await one promise. An undefined or rejected result clears the memo so a later retry recomputes instead of preserving a failed hypothesis forever.
- **One ceiling:** the session's budget is created once with `reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, deepReview)`. That exact object is required by the canvas pipeline and Decisions runner as well as hypothesis, flagged seats, verification, CI refinement, and narration. No downstream stage creates a default budget.

## #89 — which amendment option

**Decision:** (c) + (a) combined, as the proposal states: delete `harness` from the override type AND derive `harness = providerHarness(model)` after all overrides. (b) is struck by the Rule Zero amendment. Pure deletion: the two independent-pin lines (`model-council.ts:546`, `:560`) disappear with the field; the derivation already exists for the model-override path (`:543`, `:557`) and simply stops being overridable afterwards. The trace summary then cannot record an incoherent pair, fixing the residual provenance lie the issue names.

## #65 — rollup shape

**Decision:** keep the existing deterministic ordering (freshness by repoId, canvas state by canvas-angle order), emit the first K lines verbatim, then ONE tail line per section aggregating the rest. B2 uses `… +N more repos — X current / Y not current`; `failed` and `updating` are not renamed stale. B3 uses `… +N more canvases — <aggregate counts in the existing count vocabulary>`. K and the compact per-canvas line shape are product constants chosen so the exact 10-repo / 20-canvas acceptance fixture lands at or below 4,096 bytes. The throw stays as the backstop. No configuration knob.

## Wave-11 review corrections

The consolidated review found that the first implementation proved isolated helpers but not the shipped composition. The correction therefore adds one dispatch-level test that runs the real `review.canvases` and `flagged.review` routes and observes the exact session budget passed to both producers. Separate guards prove the same object reaches `buildReviewCanvases` and the Decisions runner, so either private-budget regression reddens the suite.

Numeric separators are valid only between digits in every decimal, exponent, and radix run. Any leading or trailing separator makes the whole candidate plain. CodeView removes the diff marker before grammar tokenization and renders the marker separately, so a column-zero source comment remains a comment without weakening the shell/YAML embedded-`#` boundary.

## #92 — what is deliberately not built

Item 3 (JS/TS regex literals) stays as-is: the `/` divide-vs-literal ambiguity is context-sensitive; a line-local guess would mis-highlight `a / b` division, a worse lie than the current one. Recorded on the issue at close. Items 1–2 are per-grammar data (`commentNeedsWordBoundary: boolean` on `Grammar`; radix-specific digit predicates) — no new abstraction beyond the flag and predicates.
