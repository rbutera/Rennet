## 1. The anchor↔row registrar (pure, TDD)

- [ ] 1.1 `buildRowRegistry({diff, occurrenceIds})` — per-row real file line (parsed from `@@ -a,b +c,d @@`), side (additions/deletions/context), per-side ordinal within the hunk, occurrence id; file-header/hunk-header/meta rows classified, never counted as content
- [ ] 1.2 Header-less diff → one implicit hunk seeded at line 1/1 (the demo/fixture shape); multi-hunk diffs advance per-side file lines independently across `@@` boundaries
- [ ] 1.3 `resolveAnchorToRows(registry, parsedAnchor)` — side-aware span → exactly the correct rows; four outcomes mirroring the substrate (resolved / no-occurrence / no-such-side / out-of-bounds); whole-occurrence (spanless) → all content rows
- [ ] 1.4 `placeMarks(registry, marks)` — partition into placed (with gutter row + spanned rows) vs orphaned (malformed anchor or unresolvable); `indexPlacements` builds the glow/gutter lookups; `markIndexItems` builds the navigating index
- [ ] 1.5 Recycle-safety: placement is keyed by anchor/(occurrence, side, ordinal), identical over the full diff vs a windowed slice — proven by test

## 2. The inhabited CodeView

- [ ] 2.1 Rows render real file line + `data-side` + `data-file-line` + `data-side-ordinal` + `data-occurrence` + `data-raw-index`; the visible line-number cell is the real file line, not the diff-row index
- [ ] 2.2 A passed L3 mark glows on exactly its resolved rows (`cv-glow` + `data-mark`), the ◇ gutter glyph renders at the anchor row, and a proposal card renders inline at its span (via `renderProposalCard`)
- [ ] 2.3 Windowing + node-count envelope (R16) preserved: extra nodes render only on marked, in-window rows; no marks → byte-identical node budget
- [ ] 2.4 `onPlacement` reports placed + orphans up (so the workspace routes orphans + builds the index); `focusAnchor` marks the focused span
- [ ] 2.5 Update `code-view.test.tsx`: real-file-line semantics + `data-window-start` for the scroll-follow test; keep the node-count + add/del/ctx tests; add inhabited-canvas render-verify tests

## 3. The strip demoted to an index

- [ ] 3.1 `workspace.tsx`: the `l3-strip` becomes a `MarkIndex` jump-list built from `markIndexItems` — clicking an item selects its element, zooms to diff, and focuses its anchor (deixis); it is an index, never the mark's home
- [ ] 3.2 CodeView receives the shown occurrence's marks + occurrence ids; orphan marks route to a visible orphan affordance (never silently dropped)
- [ ] 3.3 Read-verify the workspace markup; keep the existing workspace/L3/decisions tests green

## 4. Doctrine + wiring

- [ ] 4.1 Add to `docs/Rennet Design Doctrine.md`: "marks live at their anchors, never in a list" (a strip/panel may index marks but never house them; an unresolvable-anchor mark renders in the orphan tray, visibly)
- [ ] 4.2 Export the registrar API from `packages/ui/src/index.ts`
- [ ] 4.3 Gate green (`nx run <p>:typecheck` real checker + `nx run <p>:test`); open PR (no merge); prove origin==sha
