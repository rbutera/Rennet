## Why

The CodeView is a text pane by construction (issue #77, canvas-not-viewer audit 2026-08-07). It takes `{path, diff: string}`, splits on `\n`, and windows rows whose "line number" is the diff-row index — not a real file line, not side-aware, no occurrence identity. It accepts no anchors, marks, highlights, or selection. And the agent's hand (L3 marks) renders in a sidebar strip ABOVE the code (`workspace.tsx` `l3-strip`), never AT the code. **"Marks in a strip are an inbox; marks at anchors are presence."** That single fact is why the surface reads as a diff *viewer* you look at, not a *canvas* the agent inhabits with you.

This is incremental, not a rethink: the coordinate system already exists one layer down and is merged — the anchor grammar expresses side-qualified line spans (`rennet:hunk/<id>#L4-L9@additions`) with byte-verified resolution and fail-closed lineage (`@rennet/protocol` `parseAnchor`/`resolveAnchor`), and L3 events are anchor-agnostic and event-sourced. The plumbing stops at the CodeView's door. This is the smallest component in the system to rebuild.

## What Changes

- Add a pure **anchor↔row registrar** (`packages/ui/src/canvas/registrar.ts`, TDD): `buildRowRegistry({diff, occurrenceIds})` assigns every rendered row a real file line number (parsed from `@@ -a,b +c,d @@` hunk headers), an anchor-grammar `side` (additions/deletions/context), a per-side ordinal within its hunk (what an `AnchorSpan` addresses), and an occurrence identity. `resolveAnchorToRows(registry, parsedAnchor)` maps an anchor-grammar span onto the rendered rows, side-aware, mirroring the substrate's four-outcome `resolveAnchor` (resolved / no-occurrence / no-such-side / out-of-bounds). `placeMarks(registry, marks)` partitions L3 marks into placed-at-their-anchor vs orphaned. Placement is keyed by anchor/(occurrence, side, ordinal), NOT by rendered-row index, so it survives window recycling.
- Rebuild **CodeView** so it renders L3 marks AT their anchors: rows carry real file line + side + occurrence identity (data attributes), a span-highlight (glow) layer marks the anchored rows, a gutter slot renders the agent's-hand glyph at the anchor, and a proposal card renders inline at its span. Additive optional props (`occurrenceIds`, `marks`, `renderProposalCard`, `focusAnchor`, `onPlacement`); a host that passes none gets the surface unchanged. Windowing and the node-count envelope (R16) are preserved — extra nodes render only on marked, in-window rows.
- Demote the **l3-strip to an INDEX** (`workspace.tsx`): a jump-list of marks that navigates to the in-code mark (`canvas.focus`-style deixis), never the mark's home. An L3 mark whose anchor does not resolve to a visible row routes to a visible orphan affordance, never silently into a list.
- Add the Design Doctrine line: **"marks live at their anchors, never in a list."**

## Capabilities

### New Capabilities

- `inhabited-codeview`: the anchor↔row registrar (real file lines, sides, occurrence identity, span→row resolution), L3 marks rendered at their anchors (glow + gutter + inline proposal card, recycle-safe), and the l3-strip demoted to a navigating index with orphan routing.

## Impact

- Adds `packages/ui/src/canvas/registrar.ts` (+ `registrar.test.ts`); rebuilds `packages/ui/src/components/code-view.tsx` (+ updated `code-view.test.tsx`); rewires `packages/ui/src/components/workspace.tsx` (strip→index, marks passed to CodeView); extends `packages/ui/src/index.ts`. No new package, no runtime dependency, no dependency-arrow change: the UI consumes `parseAnchor` + anchor types already exported by `@rennet/protocol`/`@rennet/types`. The architecture and licenses gates are untouched.
- Reuses the existing `ProposalMark`/`AnnotationMark` components (glass doctrine, the ◇ hand) as the inline card renderer at the anchor — no new visual language, only a new location.
- Zero schema change: L3 annotations/proposals already carry an anchor `target`; this slice gives that anchor a place to land.
- Deferred to the DOM harness (issue #53 / bead a20tq): mounted-interaction rendering (scroll-into-view on focus, click-to-navigate wiring exercised in a real DOM). The PURE registrar/resolution/orphan/index logic is covered exhaustively and is red-able; the render wiring is read-verified via `renderToStaticMarkup`. Span-grained dispositions (#78) and the deixis focus stream (#79) build ON this registrar and are separate.
