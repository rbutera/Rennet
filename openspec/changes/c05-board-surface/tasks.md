# Tasks — c05-board-surface (C5, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster; one commit per checked task. Sources of record: INVENTORY §3 (137 `[ws:C5]` claims, `spikes/board-prototype/INVENTORY.md`), the B3 projection (`packages/protocol/src/board/{schema,lens-board}.ts` — the 13-kind host vocabulary + `LensBoard`), C4's `packages/app-ui/src/review/` barrel, `packages/ui`'s `Collapse`, the spike reference read-only (`spikes/board-prototype/components/lens-board.tsx`, `lib/lens-data.ts`, `lib/fixtures/`). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** verify no board-fetch command has been registered (`grep -E '"(lensBoard|board)\.' packages/protocol/src/commands/index.ts` still empty) and `patchset.readSpan` still throws in `packages/server/src/dispatch.ts` — if B4/B10 landed either, `board-data.ts` binds the real read directly (Reconciliation 1/2 still name the seam either way). Confirm C4's `review/` barrel and `packages/ui`'s `Collapse` are on main before cluster 3.

## 1. Foundation — fixtures, the board-fetch seam, the viewed-delta slice

- [x] 1.1 Convert the spike fixtures (`spikes/board-prototype/lib/fixtures/{design,decisions,sequence,flagged,noise,design-gen0,flagged-gen2}.ts`) into **protocol-shaped** `LensBoard` fixtures under `packages/app-ui/src/test/fixtures/boards/` — a `HostElement` tree + `LensSection` projections validated against `LensBoardSchema` (the spike's composite kinds have no protocol home; express their content through `section`/`prose`/`requirement`/`decision`, Reconciliation 4). Fixtures arrive only through the bridge (the import fence) — deliver them as `MemoryBridge` handlers, not surface-directory imports.
- [x] 1.2 `packages/app-ui/src/board/board-data.ts` (Reconciliation 1, the single resolution point): a typed hook/function every board-rendering component calls to resolve a `LensBoard` for a `(generation, lens)` pair, plus the frozen-generation read. No board command is registered yet, so it reads the bridge-delivered fixture board today, validated against `LensBoardSchema`; the `useCommand(...)` binding is one line, changed only when B4/B10 registers the command (gated cluster 8). No board shape invented locally.
- [x] 1.3 `packages/app-ui/src/board/viewed-delta.ts` (Reconciliation 6): a UI-only store slice — `viewedDeltaSections: Record<string, true>` + `markDeltaViewed(sectionId)`. Not persisted, not on the wire. Unit-test the mark/decay.
- [x] 1.4 DOM test: `board-data.ts` over a `MemoryBridge` resolves a fixture board and rejects a shape that fails `LensBoardSchema` as data (not a thrown render). Cluster gate green. Commit.

## 2. The element registry — one renderer per kind, `assertNever` default

- [x] 2.1 `packages/app-ui/src/board/registry.ts` (Objective clause 1, autopsy S4): a `Record<Exclude<HostKind, "round_outcome" | "review_comment">, ElementRenderer>` map and an `Element` dispatcher that looks up `element.kind`, renders through the map, and has an `assertNever(kind)` default arm (Reconciliation 3 — `round_outcome`→C9, `review_comment`→C7/C8; the domain exclusion keeps totality honest with no stub). Renderer files land in cluster 3; this cluster wires the dispatch mechanism + type-level totality proof.
- [x] 2.2 Type-level positive control recorded: adding a kind to the registry domain without a renderer makes `assertNever` a compile error (run once by hand — widen the domain, watch typecheck fail, revert; record here). This is the named replacement for the spike's silent `default: return null`. Cluster gate green. Commit.
  - **Recorded (2026-08-27):** temporarily added `"callout"` to `BoardKind`'s `Exclude` (narrowing the registry domain / widening the excluded complement) without adding a `case "callout"` arm in `renderOutsideRegistry`. `pnpm nx typecheck rennet-app-ui` failed at `registry.ts:94` — `error TS2345: Argument of type '"callout"' is not assignable to parameter of type 'never'` on `return assertNever(kind)` (plus a corroborating `TS7053` at the `registry[kind]` index). Reverted; typecheck green again. Proves the `assertNever` totality arm turns an unrendered kind into a build failure, not a silent `default: return null`.

## 3. Per-kind renderers — port the JSX through the fence

Each renderer is its own file under `packages/app-ui/src/board/kinds/`, ported from the spike's `lens-board.tsx` per-kind JSX, rewired onto the protocol `HostElement.data` shape and C4's `review/` components. Nothing under `board/` imports from `spikes/`.

- [x] 3.1 Prose family: `prose` (→ `RichText`), `callout` (`variant`/`body`, warn/info tone → `RichText`), `annotation` (`code_ref` element → `AnchorReveal` + body `RichText`). Register in the map.
- [x] 3.2 Code family: `code_ref` (the `code_ref` element's citation → C4's `useSpanRead`/`AnchorReveal` + `CodeBlock`, hydrated through `review/citations.ts`, honest error line when unreadable — Reconciliation 2). Register.
- [x] 3.3 Findings-board family: `finding` (severity glyph, concurrence tally from `concurrence`, folding to its title, `status` open/addressed/dismissed dimming, fix callout wired to `reviewActions.stageAsk` — no `store?.` shim, reads the real `review` slice). Register.
- [x] 3.4 Design/Sequence family: `decision` (`statement`/`why`/`alternatives`/`evidence` → `CodeTabs`/`AnchorReveal`), `requirement` (`shall`/`coverage` met|gap|partial/`trace` → coverage chip + refs), `order_step` (`title`/`span`/`children`). Register.
- [x] 3.5 Thread family: `message` (the conversational/ask kind — `role`, the exchange, optional `code_ref` anchor via `AnchorReveal`, `quote_target`/`quote` anchor surfaced for cluster 5's highlight; `lifecycle` staged/…/detached read distinctly, detached visible never dropped). Register.
- [x] 3.6 `noise_verdict` (`hunk`/`verdict`/`reason`/`judge` llm|deterministic, dismiss/not-noise affordance). Register — the map is now total over its domain (assertNever passes).
- [x] 3.7 DOM tests over `MemoryBridge`: a fixture board exercising each registered kind asserts each renders its distinctive DOM; the honest-error line renders for an unreadable `code_ref`. Cluster gate green. Commit per sub-cluster.

## 4. Section fold grammar, rollups, and delta marks

- [x] 4.1 `packages/app-ui/src/board/section.tsx` (Objective clauses 2, 3): render a section on `packages/ui`'s `Collapse` — folded shows the `LensSection` `gist` + per-kind `counts`; unfolded renders the `section` element's `children` through the registry. Disclosure pattern from the spike (heading wraps the toggle; both states mounted for the fold animation).
- [x] 4.2 Delta marks (Objective clause 8, #486): a section with `delta: "new" | "reworked"` opens expanded and shows the transient gold dot (`bg-primary`) while `!viewedDeltaSections[id]`; interacting (toggle or gist click) calls `markDeltaViewed` and clears the dot. `sr-only` text names the delta for a screen reader.
- [x] 4.3 DOM tests: fold/unfold; folded section shows gist+counts; a delta section opens expanded with the dot; interacting clears the dot (store-driven, not local). Cluster gate green. Commit.

## 5. Prose selection controls + durable quote highlights

- [x] 5.1 `packages/app-ui/src/board/quote-highlight.tsx` (Objective clause 4, Reconciliation 5): wrap C4's `RichText` output with the durable highlight layer — anchored quote ranges from the `review` slice's `quoteThreads` render as highlights; click opens a tooltip showing the thread `messages` with a reply input (`reviewActions.addQuoteReply`); an Explain thread (`kind: "explain"`) reads distinctly and raises no exit count; overlapping highlights resolve to a readable stack.
- [x] 5.2 Board-view selection wiring (Objective clause 5): the board document mounts inside C4's `ProseSelectionLayer` so a selection raises Comment/Explain/Request-Changes (C4 already writes `addQuoteComment`/`stageAsk`); C5 renders the resulting highlight+thread via 5.1. No duplicate toolbar logic.
- [x] 5.3 DOM tests over `MemoryBridge`-backed `useRennetStore`: a `quoteThreads` entry renders a highlight; clicking opens the exchange; reply appends via `addQuoteReply`; overlapping anchors both remain reachable; Explain thread doesn't count as an exit. Cluster gate green. Commit.

## 6. Board view, lens switcher, generation drill-down

- [ ] 6.1 `packages/app-ui/src/board/board-view.tsx` (`LensBoardView`, Objective clause 6): assemble sections in reading order under the board title inside `ProseSelectionLayer`; `foldAll` starts every section folded except the Flagged lens (R44). The Design and Findings compositions render from the canonical kinds (Reconciliation 4).
- [x] 6.2 `packages/app-ui/src/board/lens-switcher.tsx` (Objective clause 7): a segment per lens present in `generation.lensBoards` — a lens with no board yields **no segment** (absent, never disabled). Each segment carries the delta rollup (count of `new`/`reworked` sections, a gold pip clearing as they're viewed — the section dot rolled up). Selecting swaps the board via `board-data.ts`.
- [ ] 6.3 `packages/app-ui/src/board/generation-switcher.tsx` (Objective clause 9): drill from the current generation back to a frozen generation's boards (read-only), resolved through `board-data.ts` with the target generation id.
- [ ] 6.4 Mount the surface: replace `packages/app-ui/src/app/review-workspace-route.tsx`'s B2 stub with the mounted `LensBoardView` + switchers. `board/index.ts` barrels the public surface; `app-ui/src/index.ts` re-exports it.
- [ ] 6.5 DOM tests: absent-lens yields no segment; switching lenses swaps the board; the delta rollup pip clears as sections are viewed; generation drill-down renders a frozen board read-only. Cluster gate green. Commit.

## 7. Barrels, dead-code fence, docs

- [ ] 7.1 Confirm nothing under `packages/app-ui/src/board/` imports from `spikes/` (the fence test `packages/app-ui/src/test/fence.test.ts` stays green; also run `grep -rn "spikes/" packages/app-ui/src/board` returning empty, recorded here).
- [ ] 7.2 Grep `docs/` (excl. `docs/dist`) for pages describing the review/board surface as unbuilt, or mapping `app-ui`'s module layout, or the `review-workspace` stub; update any page this change makes wrong (definition of done), or record the grep as a no-op.
- [ ] 7.3 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — zero new packages, confirm not assume — lint, typecheck, test, build). Commit.

## 8. Gated live cluster — bind to the real board command (BLOCKED on B4+B8)

Genuinely blocked: no board-fetch command is registered and the B8 lint/flagged pipeline is not landed. Build everything above against `MemoryBridge` fixture boards. This cluster is the single live swap — do NOT stub a hollow pass; leave unchecked with a note until B4/B10 registers the command and B8 emits real boards.

- [ ] 8.1 When B4/B10 registers the board command: change `board/board-data.ts`'s fixture read to the live `useCommand("<board command>", ...)` — the only file that changes (Reconciliation 1). Verify no other board file references the fixture path.
- [ ] 8.2 E2E: a live B8/B4-emitted board renders identically to its fixture equivalent through the same registry, folds, highlights, and switchers. Positive control: the fixture-vs-live parity test.

## 9. Verification (packet)

- [ ] 9.1 `pnpm check` green.
- [ ] 9.2 Full fixture board set E2E: a DOM test renders each converted fixture board; every registered kind is asserted present; folds/rollups/delta-dot-clears/quote-threads/absent-lens/generation-drilldown behave per the tagged claims.
- [ ] 9.3 Unregistered-kind positive control run and recorded (cluster 2.2): widening the registry domain without a renderer breaks the typecheck via `assertNever`; reverted.
- [ ] 9.4 INVENTORY §3 sweep: the 137 `[ws:C5]` claims spot-checked against the ported surface; conscious divergences recorded (the spike's four composite kinds → canonical composition, Reconciliation 4; `round_outcome`/`review_comment` left to C9/C7, Reconciliation 3; live board-fetch gated on B4+B8, cluster 8).
- [ ] 9.5 `BUILD-STATUS.json` left for the track manager to land (implementers do not touch it). Sigil `<promise>C05-COMPLETE</promise>` emitted in the completion report.
