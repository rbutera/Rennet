# Tasks — c06-diff-view (C6, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: INVENTORY §4 (28 `[ws:C6]` claims, `spikes/board-prototype/INVENTORY.md`), client asset §5 diff row (#489 comment 5431046569), fence addendum (#489 comment 5431046732), spike reference read-only (`spikes/board-prototype/components/diff-view.tsx`, `lib/diff-data.ts`). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** confirm the seams C6 leans on are still as the proposal assumes — C4's `review/line-comment-editor.tsx`, `review/code-block.tsx`, `review/selection-toolbar.tsx` and the `review` slice actions (`setCodeComment`/`clearCodeComment`/`stageAsk`, `selectCodeComments`) are landed; `review.load` still returns `{ review, repositoryPresent }` with `review.patchsets[].files[]` + `activePatchsetId`; `syntax/shiki.ts` still exports `detectLanguage`/`tokenizeDiffLine`; C3's `shell/top-bar.tsx` still renders the `Diff` pill over `?view`. If any moved, adjust the seam module, not the surface.

## 1. Foundation — the projection seam and the diff parser

- [ ] 1.1 `packages/app-ui/src/review/diff-source.ts` (reconciliation 2, the single resolution point): a typed helper that selects the active patchset's changed files from a resolved `Review` (`review.patchsets.find(p => p.id === review.activePatchsetId)?.files ?? []`). No `useCommand` call of its own — the projection already arrived via `review.load` in `useSlugResolution`; this module is the ONE place that reads `files` off the review, so a future dedicated patchset-projection command is a one-file swap here. Re-export `PatchFile`/`FileChangeStatus` from `@rennet/protocol` so callers don't reach into `delta/citations`. No filesystem access (grep-provable, §7).
- [ ] 1.2 `packages/app-ui/src/review/diff-parse.ts` (reconciliation 1): pure `parsePatch(patch: string) => Hunk[]` where `Hunk = { oldStart, newStart, lines: { type: "context"|"add"|"del"; text: string }[] }`, using the repo's `@@ -a,b +c,d @@` grammar (reuse `canvas/registrar.ts`'s `HUNK_HEADER_RE` — import it or lift it to a shared spot, do not hand-roll a second regex). Plus `hunkHeader(hunk)` and `fileStats(file: PatchFile)` (prefer `PatchFile.additions`/`deletions`; fall back to counting parsed hunks when null) and `numberLines(hunk)` (dual old/new numbering, `add` ⇒ no old line, `del` ⇒ no new line). No React, no I/O.
- [ ] 1.3 Unit tests: `diff-parse.test.ts` — a multi-hunk patch parses to the right line types and old/new numbers; a rename/added/deleted `PatchFile` yields correct `fileStats`; `hunkHeader` matches `@@ -o,n +o,n @@`. `diff-source.ts` picks the active patchset and returns `[]` for a review whose active patchset has no files. Cluster gate green. Commit.

## 2. The diff surface — presentation over the projection

- [ ] 2.1 `packages/app-ui/src/review/diff-view.tsx`: port the spike's `DiffView`/`FileTree`/`DiffFileCard`/`StatSquares` presentation, taking `files: PatchFile[]` (Objective B — GitHub Files-changed shape). Header: `n files changed`, `+adds −dels`, `StatSquares`, `n / m viewed` (Objective C count). Two scroll frames (cards left, filter + file tree right); the filter narrows both; empty-filter message ports verbatim. Card `id="diff-<path>"`, `scroll-mt` for the jump. Rename shows `oldPath → path`; status badge for added/renamed.
- [ ] 2.2 `DiffHunkView`: dual `old`/`new` gutters, `+`/`−`/context marker column, hunk header via `diff-parse.hunkHeader`, lines via `numberLines`. Tokenize each line through `syntax/shiki.ts` `detectLanguage`/`tokenizeDiffLine` — SYNCHRONOUS, no `useEffect`, no `ThemedToken[][]` state, no skeleton (reconciliation 5). Add/del rows carry their green/red tint.
- [ ] 2.3 Viewed-tracking (Objective C): the per-file **Viewed** checkbox collapses the card (via the C2 `Collapse`/existing collapse primitive — do NOT import the spike's `@/components/collapse`), updates the header count and the file-tree strike-through; the chevron collapses/expands manually, and marking viewed forces-collapses exactly like the spike. Local `useState` (reconciliation 8 — no command, no gate).
- [ ] 2.4 DOM tests over `MemoryBridge`-supplied files: files render in Files-changed shape; filter narrows cards + tree; Viewed collapses a card and moves the count; copy-path shows/hides its 1.5s confirmation and no-ops silently when the clipboard API is absent. Cluster gate green. Commit.

## 3. Line comments — the C4 machinery, one object with the board

- [ ] 3.1 Wire `DiffHunkView`'s per-line comment button to open C4's `review/line-comment-editor.tsx` (imported from the `review` barrel), spanning the card's full width regardless of horizontal scroll (Objective E). Hover swaps the new-line number for `+`; a commented line shows the persistent glyph.
- [ ] 3.2 Comment state through the `review` slice, NOT `useCodeComments()` (Objective G, reconciliation 4): read via `selectCodeComments(path)` and `s.review.stagedAsks`; `onSave` ⇒ `setCodeComment`/`clearCodeComment`; `onRequestChanges` ⇒ `setCodeComment` + `stageAsk({ anchor: `${path}:${line}`, type: "request-change", body })` — byte-for-byte `review/code-block.tsx`'s contract. A line with a matching staged ask reads danger red; a plain comment reads evidence green. No `store?.` guard anywhere.
- [ ] 3.3 Mount C4's `ProseSelectionLayer` around the diff scroll frame (as the spike does) so Comment/Explain on selected diff text works — the existing component only; ask-staging logic over B11 stays C8.
- [ ] 3.4 DOM tests over `MemoryBridge`-backed `useRennetStore`: hover/click opens the editor; Save writes `review.codeComments[path][line]`; the glyph persists across remounts of the SAME store; Request Changes both sets the comment and stages the `${path}:${line}` ask; danger-red vs evidence-green follows the store, not local state. Cluster gate green. Commit.

## 4. Deep-links and the pill mount

- [ ] 4.1 Deep-link (Objective D, reconciliation 3): read `?file=` through `useSearch` + `readSessionQuery(new URLSearchParams(...)).file` — NO `next/navigation`. On mount, scroll the `diff-<file>` card into view (mount-only; the param stays shareable). The filename links that TARGET this (`?view=diff&file=`) are minted by the C4 `counterpart`/C5 surfaces — C6 owns the receiving jump.
- [ ] 4.2 `packages/app-ui/src/review/diff-view-container.tsx`: read the active patchset's files via `diff-source.ts` from the resolved review, render `<DiffView files={…} />`. Handle an empty/absent patchset with an honest one-line state, never a blank frame.
- [ ] 4.3 Mount for `?view=diff` (Objective A, reconciliation 6): add a minimal `?view` switch in `app/review-workspace-route.tsx` — `diff` renders the container, every other value keeps the existing honest placeholder (board = C5). Written so C5 slots its board branch beside this one. This is the only edit outside `review/`.
- [ ] 4.4 `review/index.ts`: barrel `DiffView` (+ props type). DOM test: selecting `diff` (or a `?view=diff` route) mounts the surface; a `?view=diff&file=<path>` deep link renders and scrolls the named card. Cluster gate green. Commit.

## 5. Fence, barrels, docs

- [ ] 5.1 Confirm no `app-ui/src` file imports `next/` (fence rule 3) and no diff module imports from `spikes/` (import fence) — `grep -rn "from \"next/\|from 'next/\|from \"@/\|spikes/" packages/app-ui/src/review/diff-*` returns empty; record the grep here as proof.
- [ ] 5.2 Grep `diff-source.ts`/`diff-parse.ts` clean of `node:fs`/`\bfs\b`/`readFile`/`node:path` (reconciliation 2 — the raw diff needs no filesystem and no span-read); record the grep.
- [ ] 5.3 Grep `docs/` (excl. `docs/dist`) for pages describing the diff view / `?view=diff` / `/api/source` / the review workspace as unbuilt or naming the spike's diff shape; update any page this change makes wrong, or record the grep as a no-op.
- [ ] 5.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm zero new packages, not assume — lint, typecheck, test, build). Commit.

## 6. Verification (packet)

- [ ] 6.1 `pnpm check` green.
- [ ] 6.2 Open-via-pill + open-via-deep-link (Objective A/D, packet V2/V3): DOM/app proof that the top-bar pill's `Diff` navigates to `?view=diff` and renders the surface, and that a cold `?view=diff&file=<path>` renders and scrolls the named card.
- [ ] 6.3 Viewed-tracking (Objective C, packet V4): the Viewed checkbox collapses the card and updates the `n / m viewed` count and tree strike-through.
- [ ] 6.4 **Same-object E2E** (Objective E, packet V5): `review/diff-comment-shape.dom.test.tsx` mounts the diff hunk and C4's `code-block` against the SAME `useRennetStore` and asserts a line comment from each lands in the identical `review.codeComments[path][line]` shape, and that a diff-line Request Changes both sets the comment and stages the `${path}:${line}` ask. **Positive control run**: repoint the diff `onSave` at throwaway local state, watch this test fail, revert — record it here.
- [ ] 6.5 No-fs / no-`next` proof (packet): the §5 greps recorded and green.
- [ ] 6.6 INVENTORY §4 sweep: the 28 `[ws:C6]` claims spot-checked against the ported surface; record conscious divergences (e.g. viewed-tracking stays local per reconciliation 8; the `Map` view is not C6; async-highlight skeleton does not travel per reconciliation 5).
- [ ] 6.7 `BUILD-STATUS.json` left for track-c to land per the dispatch instruction (implementers do not touch it). Sigil `<promise>C06-COMPLETE</promise>` emitted in the completion report.
