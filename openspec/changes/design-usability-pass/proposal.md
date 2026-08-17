# Design and usability pass across the whole app (#85)

## Why

Every feature wave (1–11) has shipped; #85 is the open closing milestone of the delivery order. The app is feature-complete and honest, but several surfaces landed functional-but-minimal (the #352 verify-ui strip has **zero** CSS anywhere; the stage-6 handoff paper renders with **zero** CSS), the two visual decisions deliberately deferred to this pass (in-rail thread alignment from #36, the real wordmark from #43) are still open, and `packages/ui/src` carries accumulated design-system debt: ~63 font-size and radius literals off any documented ramp, because DESIGN.md documents the *marketing* scale (16px body, 10/12px corners) and says only that "the desktop keeps a smaller, more spatially stable scale" without ever enumerating it. The canonical wireframes (`wireframes/`, v4.0 — the design source of truth per its README and the #85 comment) already use that denser scale; the app converged on it too (~89% of font-size literals sit on eight values). The debt is drift *around* an undocumented ramp, not 143 mistakes.

## What Changes

- **The desktop scale becomes documented truth, then the CSS converges on it.** DESIGN.md gains an explicit desktop type ramp (10/11/12/13/14/16/19/22px + the front-door display clamp) and radius scale (4/6/8/12/16px + pill/circle geometry), derived from the wireframe kit and the audited live values. `packages/ui/DESIGN.md` carries the machine-readable desktop source beside the CSS it governs; the root `.impeccable/design.json` remains a consistent generated mirror for the shared design artifact. Every off-ramp literal in `styles.css`, `canvas.css`, and the radius tokens collapses onto its documented neighbour. Evidence: the design detector reports zero off-ramp longhand findings, and an owned UI Vitest reads the package frontmatter to cover longhand, `font:` shorthand, and radius-bearing tokens.
- **The unstyled surfaces get their design:** the verify-ui strip (`.ui-verification*`, #352) joins the existing chrome-verdict chip language; the handoff paper (#72) becomes the paper material (`--sheet-*` tokens, R40: warm, opaque, what leaves the machine).
- **The deferred alignment component ships dormant; the wordmark lands:** `ConversationMargin` can align threads in-rail to their anchor line when a rendered diff ref is supplied, while its shipped review-heart caller continues to omit that ref and therefore uses the honest stacked fallback. App adoption is the follow-up rail-architecture decision in #356. `RennetMark` swaps its placeholder mono "R" for the real split-disc glyph from `site/brand/rennet-glyph.svg`, token-driven (`--mark-ink`/`--private`).
- **Partially-styled surfaces align to the shared language:** the delta re-review panel, the adjudication chip, the settings Keyboard section, and the title-bar mode pill / patchset chip.
- **Doctrine conformance sweep, deletion-first:** terse chrome voice (R41, four words or fewer), legend coverage for every chrome glyph (R42), no monospace as UI chrome, vertical scroll with no viewport cramming (R44), usable at narrow widths.
- **A real CSS bug is fixed:** the pre-existing `noDescendingSpecificity` warning in `canvas.css` (base `.conversation-host` at line 2744 declared after its `.review-heart-split > .conversation-host` override at 2433) is resolved by reordering.
- **Docs in the same change:** DESIGN.md desktop-scale section; the delivery-order closing entry for #85.

**Explicitly out of scope** (recorded so nobody folds them in):
- A new execution-mode capability behind the resteer's title-bar mode glyph. No execution-mode state exists in the product; the pill honestly shows the mode axis that does exist (Quick/Dual review). Inventing the state is a feature, not design.
- A wholesale navigation restructure to frame 18. The nav spine (breadcrumb + NavRail + palette + patchset chip) is already live; this pass aligns its presentation, not its structure.
- Pixel-perfect thread alignment for off-screen anchor rows in the virtualized diff (the honest fallback is stacked order — see design.md).

## Capabilities

### New Capabilities

<!-- None. This is a design pass over shipped capabilities. -->

### Modified Capabilities

- `canvas-ui`: one component contract — `ConversationMargin` aligns a panel when its caller supplies a diff ref containing the rendered anchor row, with an honest stacked fallback otherwise and the existing no-reflow guarantee intact. The app does not adopt that optional path in this change.

## Impact

- **`packages/ui/src/styles.css`, `canvas.css`, `tokens.css`** — ramp migration (~63 literal edits), the specificity reorder, new rule blocks for `.ui-verification*` and `.handoff-paper*`, polish on `.delta-account*`, `.flag-adjudication*`, `.settings-key*`, `.navigation-*`.
- **`packages/ui/src/components`** — `icons.tsx` (`RennetMark` glyph), `conversation-cluster.tsx` (dormant anchor-alignment component contract via the existing `data-anchor-key` hooks), small class/DOM adjustments where a surface's structure needs them (each DOM-tested). Threading the diff ref through `CodeView` and `ConversationPanel`/`ConversationHost` remains follow-up work.
- **`DESIGN.md` + `packages/ui/DESIGN.md` + `.impeccable/design.json`** — the desktop scale, enumerated, with the package frontmatter as the UI checks' source; **`docs/`** — delivery-order closing entry.
- No protocol, core, or adapter changes. No new dependencies.
