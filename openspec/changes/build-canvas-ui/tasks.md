## 1. Glass design tokens

- [ ] 1.1 Port the ratified glass token set into `packages/ui/src/tokens.css` (dark default) — glass chrome, opaque `--code-bg`, paper tokens, backlight `--private` #85C4DC (only inner glow), amber, no fourth hue
- [ ] 1.2 Compose the bright-room scheme under `[data-scheme="light"]` (both schemes render)
- [ ] 1.3 Import `tokens.css` from `index.ts`; component styles reference `var(--token)` only

## 2. Canvas logic (pure, TDD)

- [ ] 2.1 `fanOutApproval(canvas, scope)` → per-anchor disposition writes (group act = one user act; event trace)
- [ ] 2.2 `canvasCoverage(canvas)` → read/unread independent of cohort expansion (collapse ≠ read)
- [ ] 2.3 `zoomReducer` → roll-up → cohort → element → diff, both directions, keyboard-first
- [ ] 2.4 `rotateLens` → six angles (5 canvases + blast overlay), cursor hunk fixed on rotation
- [ ] 2.5 `adjudicateProposal(proposal, outcome, edited?)` → only `accepted` yields L2; edit-then-accept
- [ ] 2.6 `blastPaint(canvas)` → amber paint targets (overlay, never a queue)
- [ ] 2.7 `windowRows(...)` + `MAX_RENDERED_NODES` envelope (Pierre node-count discipline)
- [ ] 2.8 `feed.ts`: `CanvasFeedSource` + `createCanvasSubscription` (owner + disposal) + `useCanvasFeed` (useSyncExternalStore); leak test
- [ ] 2.9 `store.ts`: zustand ephemeral view state (angle, expanded cohorts, zoom path, selection, cursor anchor, overlay)
- [ ] 2.10 `fixtures.ts`: deterministic sample `Canvas[]` (five angles, 100+ decisions, cohorts, blast paint, L3 annotation + proposal)

## 3. Canvas components

- [ ] 3.1 `LensSwitcher` — five canvas angles + blast-radius overlay toggle (not a sixth canvas)
- [ ] 3.2 `DecisionsCanvas` + `Cohort` — collapsed-by-default roll-up, honest counts, approve at any granularity, 100+ decisions with zero truncation
- [ ] 3.3 `FlatCanvas` — sequence/spec/claims/noise element lists, empty-but-honest
- [ ] 3.4 `DispositionBar` — approve/request-change/comment/question at current granularity
- [ ] 3.5 `Annotation` (L3) — visually distinct glass chrome + pin/clear
- [ ] 3.6 `Proposal` (L3) — accept/edit/dismiss, edit-then-accept, only accept creates L2
- [ ] 3.7 `CodeView` — windowed diff (R16), node-count bounded
- [ ] 3.8 `BlastOverlay` — amber paint on painted targets
- [ ] 3.9 `CanvasWorkspace` — top-level: lens switcher + active canvas + zoom + overlay + subscription

## 4. Lint enforcement

- [ ] 4.1 `no-restricted-syntax` hex rule scoped to `packages/ui/src` non-test/non-fixture source in `eslint.config.mjs`
- [ ] 4.2 Red/green test via ESLint Node API (hex fixture fails, `var(--token)` clean)

## 5. Demo integration

- [ ] 5.1 `RennetApp` additive Canvas view toggle (fixtures-backed), review-capture flow + e2e selectors preserved
- [ ] 5.2 `index.ts` exports `CanvasWorkspace` + `demoCanvases`

## 6. Gate

- [ ] 6.1 `pnpm check` green (format, architecture, licenses, lint, typecheck, test, build): zero errors + `Successfully ran target(s)`
