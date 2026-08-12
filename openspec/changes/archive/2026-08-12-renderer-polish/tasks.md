# Tasks — renderer-polish

Red-proof each issue with the failing prediction named before implementation. Keep every change under `packages/ui/src`; do not alter protocol, core, adapters, desktop main, snapshot generation, or add a consent/approval/capability gate.

> **Shipped #240 ONLY (Navi's call, 2026-08-12): #223 is DEFERRED** — it crosses zones (the working-tree symbol lookup port is host-side, desktop main) and is P2/P3 polish. Tasks 2 and 3 below (#223) are intentionally not built; issue #223 stays open. This change ships the #240 per-review-hypothesis-frame fix.

## 1. Thread the live review identity
- [x] 1.1 Added `reviewId` to `CanvasWorkspaceProps` and pass `review.id` from the live mount in `packages/ui/src/app.tsx`.
- [x] 1.2 Fixtures supply explicit review identities where they test cross-review behaviour; no `key={reviewId}` — the workspace stays mounted and remembers each review's state.

## 2. #223 — red-proof source routing and wireframe placement
- [ ] 2.1 **DEFERRED (#223)** — not built this wave.
- [ ] 2.2 **DEFERRED (#223)**.
- [ ] 2.3 **DEFERRED (#223)**.

## 3. #223 — add the renderer source selector
- [ ] 3.1 **DEFERRED (#223)**.
- [ ] 3.2 **DEFERRED (#223)**.
- [ ] 3.3 **DEFERRED (#223)**.
- [ ] 3.4 **DEFERRED (#223)**.

## 4. #240 — red-proof per-review collapse state
- [x] 4.1 Extended `components/workspace.hypothesis.dom.test.tsx`: collapse review A, rerender the same mounted component as unseen review B, then return to A. Prediction: with the current single `useState(true)`, B stays collapsed.
- [x] 4.2 Asserts B starts expanded, A restores collapsed, and a fresh canvas set under the same `reviewId` (a regenerate) preserves collapsed. Red-proof verified live: forcing a single bucket reddens exactly the B assertion.

## 5. #240 — key the frame state
- [x] 5.1 Replaced the single `hypothesisOpen` boolean with `Record<reviewId, boolean>` in `useState`; an unseen review's expanded default is derived synchronously (`?? true`, no flash); the toggle writes only the active review's entry.
- [x] 5.2 Hypothesis content, counts, toggle chrome, and `HypothesisReadingFrame` rendering unchanged — only collapse-state ownership changed.

## 6. Focused proof and scope audit
- [x] 6.1 `NX_DAEMON=false pnpm nx test rennet-ui` green; the #240 A→B→A red control passes for the intended reason (verified by mutation).
- [x] 6.2 `lint,typecheck -p rennet-ui` clean; only `packages/ui/src` + this OpenSpec change differ.
- [x] 6.3 Read-verified `apps/desktop/src/main/symbol-lookup-live.ts` and `index.ts` are unchanged; committed lookup remains default; no consent/confirmation/capability/read-only/sandbox/hardening work entered the diff.

## 7. Gate
- [x] 7.1 `NX_DAEMON=false pnpm check` → Successfully ran targets for 8 projects, exit 0. Feature tip `1311e67` (ff from `cbb6d3e`; rebased onto C1). Dual Opus review: both SOLID, no confirmed issues.
