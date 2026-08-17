# Tasks — design-usability-pass (#85)

Design pass, not a feature wave: visual coherence, usability, honest affordances.
DOM tests only where structure/classes change; the ramp migration's evidence is the
design-lint count, not screenshots. Deletion over addition wherever a frame says so.

## 1. The ramp lands (DESIGN.md → lint → CSS)

- [ ] 1.1 Add the "Desktop scale" documentation to DESIGN.md (Typography + Shapes): type ramp 10/11/12/13/14/16/19/22px + display clamp; radius scale 4/6/8/12/16px + pill(999)/circle(50%) geometry exemptions; one sentence per step on when it is used. Frontmatter stays the marketing scale (it feeds the site); the desktop scale is prose + a machine-readable extension in `.impeccable/design.json`
- [ ] 1.2 Regenerate/update `.impeccable/design.json` (schemaVersion 2) so the design-lint's ramp includes the desktop scale; confirm the lint now reports ONLY the genuine-drift literals (the ~31 type + ~32 radius strays from design.md's audit tables) — this is the positive control proving the lint still fails on real drift
- [ ] 1.3 Migrate every off-ramp `font-size` literal in `packages/ui/src/styles.css` and `canvas.css` onto its ramp neighbour per the design.md table (fractional sizes, 9px, 15px, 18px, 20px; "judged per use" picks the neighbour matching that surface's frame)
- [ ] 1.4 Migrate every off-ramp `border-radius` literal per the table (2/3/5/7/9/10/11/14/15px), including `--chip-radius: 9px → 8px` in `tokens.css`
- [ ] 1.5 Evidence: impeccable design-lint reports **zero** design-system-radius and design-system-font-size findings over `packages/ui/src`; `grep -E "font-size: *[0-9]+\.[0-9]" packages/ui/src/*.css` returns nothing; full UI test suite stays green (no DOM contracts touched)

## 2. canvas.css specificity fix

- [ ] 2.1 Confirm the failing state first: `node_modules/.bin/biome check packages/ui/src/canvas.css` reports `noDescendingSpecificity` (base `.conversation-host` ~2744 after `.review-heart-split > .conversation-host` ~2433)
- [ ] 2.2 Reorder so the base block precedes the override (move the block, keep every declaration byte-identical); biome reports zero warnings on canvas.css; conversation-host DOM tests stay green

## 3. Verify-ui strip (#352)

- [ ] 3.1 Style `.ui-verification`, `-pending`, `-unavailable`, `-ran`, `-label`, `-reason`, `-head`, `-count`, `-shots` in canvas.css in the `.flag-verification`/`.flag-adjudication` chrome-verdict language (bordered strip, `--text-soft` reason, screenshot thumbnails on the opaque code surface; no amber for `unavailable`)
- [ ] 3.2 If any DOM structure changes (e.g. a shots-row wrapper), red-first: extend `flagged-ui-verification.dom.test.tsx` for the new structure before the component edit; otherwise the existing status/class tests are the guard
- [ ] 3.3 R41 audit of the strip's chrome strings (≤4 words; reasons/evidence are content and exempt)

## 4. Handoff paper (#72)

- [ ] 4.1 Style `.handoff-paper*` in styles.css as the paper material: `--sheet-*` tokens, 16px corner, document rhythm on the ordered tasks; preview-only model `title` visibly separate from the executable heading
- [ ] 4.2 The un-composed (`composed:false`) state stays visually a mechanical list — plain rules, no authored-prose dress; run outcomes (`refused`/`unavailable`/`failed`/`ran`) styled honestly in plain words on the sheet; Run stays one button
- [ ] 4.3 Existing `handoff-paper.test.tsx` stays green (presentation only); add a DOM assertion only if structure changes, red-first

## 5. In-rail conversation alignment (#36 deferred; canvas-ui spec delta)

- [ ] 5.1 Red-first DOM test: a thread panel whose `data-anchor-key` row is rendered in the windowed diff carries an alignment offset derived from that row's position; a panel whose anchor is outside the window renders in stacked order with no synthetic offset
- [ ] 5.2 Implement in `conversation-host.tsx`/`conversation-cluster.tsx`: read rendered anchor-row offsets from the CodeView window, offset panels within the rail only; never touch the diff column (assert diff row positions unchanged — the third scenario)
- [ ] 5.3 Existing no-reflow and reattach tests stay green; virtualization scroll churn only ever re-offsets panels, never hides one

## 6. Wordmark promotion (#43 deferred)

- [ ] 6.1 Swap the placeholder mono "R" in `RennetMark` (`packages/ui/src/components/icons.tsx`) for the split-disc glyph paths from `site/brand/rennet-glyph.svg`, rendered `fill="var(--mark-ink)"` / `stroke="var(--private)"` (the site masthead pattern)
- [ ] 6.2 Legend-coverage test stays green; visual check in both schemes (dark default + bright room)

## 7. Partially-styled surfaces align

- [ ] 7.1 Delta re-review panel (`.delta-account*`) against frame 06a: ramp typography, spacing, chip language; DOM tests untouched
- [ ] 7.2 Adjudication chip (`.flag-adjudication*`) against frame 09: consistent with the verification strip from group 3
- [ ] 7.3 Settings Keyboard section (`.settings-key*`, chord capture rows, conflict disclosure) against frame 15: ramp typography, honest conflict styling (amber is disagreement — a chord conflict qualifies), no new confirmation affordances
- [ ] 7.4 Title-bar context (`.navigation-mode-pill`, `.navigation-patchset-chip`) against frame 18's spine presentation: pill stays a pill (chip geometry), patchset chip keeps `<code>` (genuine technical value)

## 8. Doctrine conformance sweep (deletion-first)

- [ ] 8.1 R41 chrome-voice audit across `packages/ui/src/components`: every chrome string ≤4 words and functional; cut editorial copy (LLM canvas content exempt); adjust affected DOM tests in the same commit
- [ ] 8.2 R42 legend audit: every glyph rendered in chrome has an icons.tsx legend entry; the legend-coverage test is the check — extend it if any glyph escapes the registry
- [ ] 8.3 No-mono-chrome audit: every `--code` use sits on actual code or an exact technical value; anything else moves to `--sans`
- [ ] 8.4 R44 + narrow widths: no screen crams or truncates a stage to fit a viewport (hunt `overflow: hidden` truncations); shell stays vertically scrollable and horizontally unscrolled at narrow window widths
- [ ] 8.5 First-impression pass over the front door and review heart against frames 01/06: hierarchy and quiet defaults; deletions where a frame shows less chrome than the app has

## 9. Docs and gate (same change)

- [ ] 9.1 Delivery-order closing entry for #85 in `docs/src/content/docs/developing/reference/delivery-order.md` (wave list + the "remains the open closing milestone" sentence both updated — the docs must not read as if #85 is still open)
- [ ] 9.2 DESIGN.md updates from group 1 meet the docs style guide; any docsite page describing the placeholder wordmark or unstyled surfaces is corrected in the same change
- [ ] 9.3 `pnpm check` green; design-lint zero findings re-confirmed on the final tree
