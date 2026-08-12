# Tasks — renderer-polish

Red-proof each issue with the failing prediction named before implementation. Keep every change under `packages/ui/src`; do not alter protocol, core, adapters, desktop main, snapshot generation, or add a consent/approval/capability gate.

## 1. Thread the live review identity

- [ ] 1.1 Add `reviewId` to `CanvasWorkspaceProps` and pass `review.id` from the live mount in `packages/ui/src/app.tsx`.
- [ ] 1.2 Update focused component fixtures to supply explicit review identities; do not add `key={reviewId}` because the workspace must remain mounted and remember each review's state.

## 2. #223 — red-proof source routing and wireframe placement

- [ ] 2.1 Prediction: mount the real `CanvasWorkspace` with committed and working-tree lookup ports returning distinct definition paths; before the fix, only the one existing committed port can run, so selecting a working-tree source and seeing its path is impossible.
- [ ] 2.2 Add a DOM test in `components/workspace-symbol.dom.test.tsx`: first click invokes committed only; selecting `Working tree` re-runs the visible symbol and renders the working-tree-only path; selecting `Committed` restores the committed path.
- [ ] 2.3 Add a pinned case: change source while pinned, assert the inspector remains in `.diff-zoom-rail`, cross-source crumbs are cleared, and the selected diff element/path is unchanged. Removing the source-router branch must make this test fail.

## 3. #223 — add the renderer source selector

- [ ] 3.1 Keep `SymbolLookupPort` as the lookup shape and add an optional `workingTreeSymbolLookup` alongside the existing committed port; record `committed | working-tree` by `reviewId`, defaulting synchronously to committed for unseen reviews.
- [ ] 3.2 Add the compact `Committed` / `Working tree` control to fixed workspace chrome in `components/workspace.tsx` and `styles.css`; do not add a dialog, confirmation, permission step, or mode row inside the floating/pinned inspector.
- [ ] 3.3 Route the current and subsequent symbol lookup through the selected port. On source change, reissue the current name, preserve floating/pinned placement, discard cross-source history, and leave `CodeView` selection/zoom untouched.
- [ ] 3.4 Keep the selector absent unless the dependency-provided working-tree port exists; the committed inspector remains byte-behaviourally unchanged for current callers.

## 4. #240 — red-proof per-review collapse state

- [ ] 4.1 Prediction: extend `components/workspace.hypothesis.dom.test.tsx` to collapse review A, rerender the same component as unseen review B, then return to A; with the current single `useState(true)`, B incorrectly stays collapsed.
- [ ] 4.2 Assert B starts expanded, A restores collapsed, and changing A's canvas/patchset fixture while keeping `reviewId = A` preserves collapsed. Replacing the keyed state with one boolean must fail the B assertion.

## 5. #240 — key the frame state

- [ ] 5.1 Replace the single `hypothesisOpen` boolean with session state keyed by `reviewId`; derive an unseen review's expanded default synchronously and write only the active review's entry on toggle.
- [ ] 5.2 Keep hypothesis content, counts, toggle chrome, and `HypothesisReadingFrame` rendering unchanged; this task changes ownership of collapse state only.

## 6. Focused proof and scope audit

- [ ] 6.1 Run `NX_DAEMON=false pnpm nx test rennet-ui`; confirm the #223 source-routing and #240 A → B → A red controls pass for the intended reason.
- [ ] 6.2 Run `NX_DAEMON=false pnpm nx run-many -t lint,typecheck -p rennet-ui`; confirm only `packages/ui/src` and this OpenSpec change differ.
- [ ] 6.3 Read-verify `apps/desktop/src/main/symbol-lookup-live.ts` and `apps/desktop/src/main/index.ts` are unchanged, committed lookup remains default, and no consent, confirmation, capability denial, read-only posture, sandbox, or hardening work entered the diff.

## 7. Gate

- [ ] 7.1 `NX_DAEMON=false pnpm check` (green = exit 0 AND output contains "Successfully ran target").
