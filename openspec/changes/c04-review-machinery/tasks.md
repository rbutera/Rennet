# Tasks — c04-review-machinery (C4, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: INVENTORY §3 (47 `[ws:C4]` claims, `spikes/board-prototype/INVENTORY.md` — "Board prose and reading affordances", "Selection controls on board prose", "Code blocks", "Multi-site evidence and anchor reveals" sections, plus the #492 impl↔test-flip note), client asset §1 review layer + risk 2 (#489 comment 5431046569), autopsy keep-list + fence (#489 comment 5431046732), spike reference read-only (`spikes/board-prototype/components/{code-block,code-tabs,selection-toolbar,rich-text,code-comments}.tsx`). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** verify `patchset.readSpan` is still contract-only on main (`packages/server/src/dispatch.ts` should still throw `"patchset.readSpan is not bound yet"`) before starting cluster 1 — if B4/B10 landed it live, `review/citations.ts` binds directly instead of stubbing (reconciliation 6 still names the seam either way). Also confirm `packages/app-ui/src/store/review.ts` still has the thin `quoteThreads: { anchor: string }` shape (reconciliation 1) before cluster 2.

## 1. Foundation — the `review` slice extension and the citations seam

- [x] 1.1 Extend `packages/app-ui/src/store/review.ts` (reconciliation 1): `quoteThreads` value type becomes `{ anchor: string; kind?: "comment" | "explain"; messages: { author: "user" | "orchestrator"; text: string }[] }`. Add `reviewActions.addQuoteComment(anchor, text, kind?) => threadId`, `addQuoteReply(threadId, author, text)`, `removeQuoteComment(threadId)`. Keep every existing field/action (`stagedAsks`, `codeComments`, `focusedThreadId`, `retired`, `verdictOverride`, `draftEdits`) untouched. Update `store/store.test.ts` for the new shape.
- [x] 1.2 `packages/app-ui/src/review/citations.ts` (reconciliation 6, the single resolution point): a typed wrapper over `useCommand("patchset.readSpan", ref)` — one function/hook every citation-resolving component calls. No filesystem access anywhere in this module (the DOM test in 1.3 asserts it). Exports the typed `CodeRef` re-export from `@rennet/protocol` so callers don't reach into `delta/citations` directly.
- [x] 1.3 DOM test: `review/citations.dom.test.tsx` over `MemoryBridge` — a handler that resolves `patchset.readSpan` returns lines/context; a `MemoryBridge` with NO handler for it produces the command's `error` state (matching production's unbound-dispatch throw) and the seam surfaces that as data, not a thrown render error. Cluster gate green. Commit.

## 2. `LineCommentEditor` — the ONE editor

- [x] 2.1 `packages/app-ui/src/review/line-comment-editor.tsx` (reconciliation 2): port the spike's `code-block.tsx#LineCommentEditor` verbatim as its own module — `lineLabel`, `initialText`, `hasComment`, `onCancel`, `onSave(text | null)`, `onRequestChanges(text)`. Delete shown only when `hasComment`; Escape triggers `onCancel`; saving empty text calls `onSave(null)`.
- [x] 2.2 DOM tests: Save/Delete/Cancel/Escape/empty-clears, over a bare host (no store — the component takes only callbacks). Cluster gate green. Commit.

## 3. `code-block.tsx` — the one code surface

- [x] 3.1 `packages/app-ui/src/review/code-block.tsx`: port the spike's `CodeBlock` presentation, tokenized through `syntax/shiki.ts`'s `detectLanguage`/`tokenizeDiffLine` (reconciliation 3 — no async load, no skeleton state). Header: path, `L42`/`L42–L58` line range, Copy (`navigator.clipboard`, 1.5s "Copied", silent no-op if unavailable). Sticky gutter; absolute line numbers from `startLine`; `highlightLines` tinted.
- [x] 3.2 Hover-to-`+`, click opens `LineCommentEditor` (full card width regardless of horizontal scroll); a line with `review.codeComments[path][line]` shows a persistent glyph instead of `+`; a line with a matching `review.stagedAsks` entry (anchor `${path}:${line}`) reads danger red, a plain comment or cited/highlighted line reads evidence green. `onSave`/`onRequestChanges` call `reviewActions.setCodeComment`/`clearCodeComment`/`stageAsk` directly — read via `selectCodeComment`, no local mirror state.
- [x] 3.3 Optional `counterpart` prop (reconciliation 4) matching `CodeView`'s `{ label, path, onView() }` exactly, rendered right of Copy (#492 placement). Absent ⇒ no button.
- [x] 3.4 DOM tests over `MemoryBridge`-backed `useRennetStore`: hover/click opens the editor; Save writes `review.codeComments`; a comment persists the glyph across remounts of the SAME store; Request Changes both sets the comment and stages the ask; danger-red vs evidence-green classes follow the store, not local state; Copy shows/hides its confirmation; `counterpart` renders exactly when passed. Cluster gate green. Commit.

## 4. `code-tabs.tsx` + `reference-chip.tsx` — multi-site evidence

- [ ] 4.1 `packages/app-ui/src/review/reference-chip.tsx`: one presentational `basename:line` chip (label via `canvas/symbol.ts#basename`, full path in `title`), used by both this cluster and cluster 6 — no duplicate pill markup (the spike has two).
- [ ] 4.2 `packages/app-ui/src/review/code-tabs.tsx`: `CodeTabs` (pill tabs over `CodeBlock`s via `reference-chip`, tab strip hidden at one excerpt) and `AnchorReveal` (a row of chips; click fetches via `review/citations.ts` and renders the slice below via `code-block.tsx`, clicking the active chip folds it). Unreadable citation renders the citations seam's `error` state as one line of text, never silently empty.
- [ ] 4.3 DOM tests over `MemoryBridge`: single-excerpt hides the tab strip; multi-excerpt renders one visible card at a time; `AnchorReveal` toggle fetch/fold/re-fold-without-refetch (assert the underlying `useCommand` call count via the `MemoryBridge` handler's call count, not a separate cache); the honest-failure line when the stub has no handler. Cluster gate green. Commit.

## 5. `selection-toolbar.tsx` — `ProseSelectionLayer`

- [ ] 5.1 `packages/app-ui/src/review/selection-toolbar.tsx`: port `ProseSelectionLayer`, mode union kept verbatim (`"toolbar" | "comment" | "comment-rc" | "revise" | "explain"`). Floating toolbar above the selection, flips below near the viewport top, positioned inside the scrolling container, dismissed by Escape or outside click. `draftHandlers` prop (Revise/Drop/Explain) kept as host-supplied callbacks, unchanged.
- [ ] 5.2 Rewire onto the extended `review` slice (cluster 1): Comment/Explain call `reviewActions.addQuoteComment` (Explain sets `kind: "explain"`) and `setFocusedThread(newId)` so the state is ready when C5 renders the tooltip; Request Changes calls `addQuoteComment` then `stageAsk` with the quote as provenance and the new `threadId`, so the ask claims that thread (counts once). No `useCodeComments()`, no `store?.` anywhere.
- [ ] 5.3 DOM tests over `MemoryBridge`-backed `useRennetStore`: selecting text shows the toolbar; Comment/Explain/Request-Changes each write the correct `review` fields; Escape and outside-click dismiss; the toolbar flips placement near the top. Cluster gate green. Commit.

## 6. `rich-text.tsx` — R45 markdown subset (base tier)

- [ ] 6.1 `packages/app-ui/src/review/rich-text.tsx`: port the spike's tokenizer (`FILE_REF`/`TOKEN`/`SPEC_KEYWORD` regexes, `parseRef`) and render pipeline for: bold (`**text**` → `<strong>`, literal asterisks never survive), bulleted paragraphs (every line starting `- `, each line keeping the full token pipeline), normative-grammar bolding (SHALL/SHALL NOT/MUST/MUST NOT/WHEN/THEN/AND/IF/WHILE/WHERE), backticked terms as plain monospace (never a boxed pill). Reconciliation 7: do NOT port `QuoteHighlight` (durable highlight + tooltip + reply input + overlap resolution) — that block is `[ws:C5]`.
- [ ] 6.2 Citation rendering: a `path:line` token renders as a `reference-chip` (cluster 4); click hydrates via `review/citations.ts` and reveals the slice inline (via `code-block.tsx`), a second click folds it. An unreadable citation renders one honest line, not a silent skip.
- [ ] 6.3 DOM tests: each token kind (bold, bullet, spec keyword, backtick, citation) renders correctly in isolation and combined in one paragraph; citation click-to-reveal/fold; unreadable-citation honest line. Cluster gate green. Commit.

## 7. Barrels, dead-code sweep, docs

- [ ] 7.1 `packages/app-ui/src/review/index.ts`: export `CodeBlock`, `CodeTabs`, `AnchorReveal`, `LineCommentEditor`, `ProseSelectionLayer` (+ `DraftHandlers`), `RichText`, `ReferenceChip`, and the citations-seam types (`CodeRef`, the hook). `app-ui/src/index.ts` re-exports the barrel.
- [ ] 7.2 Confirm nothing in `packages/app-ui/src` imports from `spikes/` (the fence test, if one exists, must stay green; if it doesn't exist yet, a `grep -r "from \"../../spikes\|from \"@/spikes" packages/app-ui/src` returning empty is the proof, run and recorded here).
- [ ] 7.3 Grep `docs/` (excl. `docs/dist`) for pages mapping `app-ui`'s module layout (mirroring C3's task 6.2) or describing `/api/source`, code-block, or line comments as unbuilt; update any page this change makes wrong, or record the grep as a no-op.
- [ ] 7.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — zero new packages, confirm not assume — lint, typecheck, test, build). Commit.

## 8. Verification (packet)

- [ ] 8.1 `pnpm check` green.
- [ ] 8.2 Same-shape E2E: a DOM test mounts `LineCommentEditor` twice against the SAME `useRennetStore` instance — once as `code-block.tsx`'s board-excerpt caller, once standing in for a diff-line caller (same component, different `path`/`line` props, no `CodeView` dependency needed to prove the store contract) — and asserts both writes land in `review.codeComments` under their own `path`/`line` keys with identical shape.
- [ ] 8.3 Citation-from-patchset proof: `review/citations.ts` never imports Node's `fs`/`path` file-read APIs (grep-provable) and resolves only through `useCommand("patchset.readSpan", ...)`. **Positive control shown once**: remove the seam's error-state branch, watch the unreadable-citation DOM test (4.3/6.3) fail, revert.
- [ ] 8.4 INVENTORY §3 sweep: every `[ws:C4]` claim (47, across "Board prose and reading affordances", "Selection controls on board prose", "Code blocks", "Multi-site evidence and anchor reveals", plus the #492 impl↔test-flip note) spot-checked against the ported components; claims that INVENTORY tags `[ws:C5]` inside the same source files (the durable-quote-highlight section) are named as left for C5, not silently dropped.
- [ ] 8.5 `BUILD-STATUS.json` c04 → `{"status":"done","passes":true}` (or leave for the dispatching track to land, per its own convention — note which here). Emit `<promise>C04-COMPLETE</promise>`.
