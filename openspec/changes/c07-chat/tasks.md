# Tasks — c07-chat (C7, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: INVENTORY §5 (34 `[ws:C7]` claims, `spikes/board-prototype/INVENTORY.md`), session mechanics #466, client asset §5 chat row + risk 4 (#489 comment 5431046569), fence addendum (#489 comment 5431046732), spike reference read-only (`spikes/board-prototype/components/{chat-column,conversation-pane,turn,thought-block,action-step,streaming-prose,input-bar}.tsx`). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** confirm C3's `routes/layout.tsx` still renders the always-mounted `data-slot="chat-dock"` element outside the outlet (reconciliation 1) before cluster 1 — if it changed, the mount point moves but the identity guarantee is still the slot's non-unmounting lifetime. Confirm `review.ask`/`review.reattach` are still dispatch-bound and `reviewAskStreamEventSchema` still carries `ask-focus`/`ask-delta`/`ask-complete`/`ask-interrupted` (reconciliation 3) before cluster 2. Confirm `packages/protocol/src/commands/` still carries NO `session.transcript` read (the B9 gap the projection stubs) before cluster 1 — if B9 landed it live, `chat-data.ts` binds `useCommand` directly instead of the stub context, and cluster 7 collapses into cluster 1.

## 1. The seam + the dock, mounted once

- [x] 1.1 `packages/app-ui/src/chat/chat-data.ts` (reconciliation 3, the single resolution point): the typed transcript model (turn / thought-block / action-step / prose-block / code-block / compact-boundary rows), and the seam that resolves it. **Live half (dispatch-bound #251):** a `review.ask` send via `useMutation`; a `useCommandStream({ channel: "askStream", subscriptionKey: reviewId })` fold reducing `ask-delta` (append, honouring `seq`)/`ask-complete` (settle)/`ask-interrupted` into the streaming turn; `review.reattach` reload. **B9-gated half:** a `SessionTranscriptProjection` context (the historical turns + `compact_boundary` rows + context figure), honest-empty in the live client (`EMPTY_TRANSCRIPT`), driven by tests through the context — no invented turns, no fabricated number. No filesystem access; the module imports only `@rennet/protocol` types, `../data`, `../store`.
- [x] 1.2 `packages/app-ui/src/chat/chat-dock.tsx`: port the spike's `ChatColumn` structure into three stacked regions (header · transcript · composer) reading `chat-data.ts`. The transcript region carries `data-testid="chat-dock-transcript"` (the identity anchor for 1.4). No fixture-module import.
- [x] 1.3 `packages/app-ui/src/chat/chat-header.tsx` (port `ChatHeader`): the session trail via `shell/trail.tsx` (C3-landed) + a collapse control wired to the C3 `ui`-slice `setChatOpen`. Mount `<ChatDock/>` as the child of C3's `data-slot="chat-dock"` in `routes/layout.tsx` (reconciliation 1) — the ONLY layout edit; the slot's width-0/`inert`/non-unmount behaviour is untouched.
- [x] 1.4 **First-class identity test** `chat/chat-dock-identity.dom.test.tsx` over `MemoryBridge` + injected history: mount the router, append a turn to the transcript, navigate session → settings (takeover) → back, plus across every board/diff/session route the router exposes today; assert `getByTestId("chat-dock-transcript")` is `toBe`-identical across every hop and the appended turn persists (dock stays mounted while `inert`). Cluster gate green. Commit.

## 2. Transcript + turns

- [x] 2.1 `packages/app-ui/src/chat/conversation-pane.tsx` (port): the scroll region with bottom-anchored auto-scroll on append, mapping `chat-data.ts` rows to `Turn`s (and to `compaction-row` / `anchored-thread` rows added in cluster 4/5).
- [x] 2.2 `packages/app-ui/src/chat/turn.tsx` (port): user bubble vs orchestrator turn (lead prose, activity preface, body of prose/code blocks). Code blocks render through C4's `review/code-block.tsx` (reconciliation 4), never a local `CodeBlock`. The record-vs-arrival `animate` distinction is kept: historical turns replay instantly, live arrivals animate.
- [x] 2.3 DOM tests over `MemoryBridge`: a user turn and an orchestrator turn render their regions; a code block in a turn body is the shared `review/code-block.tsx` (a line comment written from it lands in `review.codeComments`, proving one path); historical turns do not animate, an appended live turn does. Cluster gate green. Commit.

## 3. Live-narration sub-blocks (state-driven, not self-timed)

- [x] 3.1 `packages/app-ui/src/chat/streaming-prose.tsx` (port): per-word CSS-delay reveal, `animate=false` renders instantly (records replay, never re-arrive).
- [x] 3.2 `packages/app-ui/src/chat/thought-block.tsx` + `chat/action-step.tsx` (port): collapsing "Thinking → Thought for Ns" with manual re-expand; running-spinner → done-label. **Reconciliation 2:** the block's live/settled look follows the turn's real `status` (`streaming`/`complete`/`interrupted`) from the stream, NOT the spike's self-timed `setTimeout` fixture animation.
- [x] 3.3 DOM tests: a `streaming`-status thought block reads live and collapses on `complete`; an `interrupted` turn's blocks settle truthfully (no infinite spinner); `streaming-prose` renders instantly when `animate=false`. Cluster gate green. Commit.

## 4. Composer + badges + orchestrator presence

- [x] 4.1 `packages/app-ui/src/chat/composer.tsx` (port `InputBar`): auto-grow textarea, Enter-sends / Shift-Enter-newline / IME-safe, send button, image-paste → local image badges. Send fires `review.ask` via `chat-data.ts` (no ask staging — that's C8; no command effects — that's B10, reconciliation 8).
- [x] 4.2 Badges read the real `review` slice (reconciliation 5): comment badges from `review.codeComments`, quote badges from `review.quoteThreads`; removal calls `reviewActions.clearCodeComment`/`removeQuoteComment`. No `useCodeComments()` shim, no `store?.` guard. Orchestrator-presence affordance reflects whether a turn is in flight (the stream/reattach state), not a fixture flag.
- [x] 4.3 DOM tests over `MemoryBridge`-backed `useRennetStore`: a code comment in the store surfaces a comment badge, removing it clears `review.codeComments`; a quote thread surfaces a quote badge; sending invokes `review.ask` with the typed body; image paste adds/removes a local badge; presence follows in-flight state. Cluster gate green. Commit.

## 5. Anchored threads (transcript-side) + honest compaction

- [x] 5.1 `packages/app-ui/src/chat/anchored-thread.tsx` (reconciliation 6, #466): render a `review.quoteThreads` thread's messages inside the transcript, keyed by a board ref; the board marker is C5's, out of scope here. Focus follows `review.focusedThreadId`.
- [x] 5.2 `packages/app-ui/src/chat/compaction-row.tsx` (reconciliation 7): a `compact_boundary` timeline row and the ask-don't-estimate context meter, reading the stubbed projection's compaction data. The meter shows the harness-reported figure or an honest "unknown" — never a fabricated estimate.
- [x] 5.3 DOM tests over `MemoryBridge` + projection context: an anchored thread renders its messages transcript-side and focuses on `focusedThreadId`; a `compact_boundary` row renders with the honest meter; a projection reporting no context figure renders "unknown", not a number. Cluster gate green. Commit.

## 6. Barrels, dead-code fence, docs, full gate

- [ ] 6.1 `packages/app-ui/src/chat/index.ts`: export `ChatDock` and the seam/projection types; `app-ui/src/index.ts` re-exports it.
- [ ] 6.2 Fence: `grep -rE 'from "\.\./\.\./spikes|conversation-data|useCodeComments' packages/app-ui/src/chat` returns empty (the spike fixture module and shim do not travel — reconciliation 2/5); record the grep. Keep `test/fence.test.ts` green.
- [ ] 6.3 Grep `docs/` (excl. `docs/dist`) for pages describing the chat dock, the transcript, or `conversation-data`/scripted replies as unbuilt or fixture-driven; update any page this change makes wrong, or record the grep as a no-op.
- [ ] 6.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — zero new packages, confirm not assume — lint, typecheck, test, build). Commit.

## 7. Gated: live wiring (deferred until B9)

**Do NOT check these until B9 lands its session-transcript projection — leave unchecked with this note; never a hollow pass.** Everything above is fully working against `MemoryBridge` streams + the projection context; this cluster only swaps the stub for the real session source.

- [ ] 7.1 In `chat/chat-data.ts` ONLY: replace the `SessionTranscriptProjection` context read with `useCommand("session.transcript", { reviewId })` (B9's projection) and resolve the live session's `reviewId` for the `onAskStream` subscription from the real route/session (today the tests inject it). Delete the stub context. Name here the exact lines that change so the diff is a one-file swap.
- [ ] 7.2 Compaction meter binds to B9's real harness-reported context figure + `compact_boundary` events (still honest "unknown" when the harness reports none).
- [ ] 7.3 Live E2E in the real app: a real orchestrator turn streams into the dock; a real compaction boundary renders its row. Deferred with cluster 7.

## 8. Verification (packet)

- [ ] 8.1 `pnpm check` green.
- [ ] 8.2 Live-turn E2E: `chat/live-turn.dom.test.tsx` over `MemoryBridge` — `emitAskStream` a `ask-delta`…`ask-complete` sequence; the folded turn's prose grows then settles in the transcript. **Positive control run**: drop the `ask-complete` settle branch, watch the never-settles assertion fail, revert.
- [ ] 8.3 Identity E2E: the cluster-1.4 test — same `chat-dock-transcript` DOM node and preserved transcript across session ↔ takeover (and every board/diff transition the router exposes today).
- [ ] 8.4 Compaction E2E: the cluster-5.3 test — a `compact_boundary` renders its honest row + ask-don't-estimate meter, no fabricated number.
- [ ] 8.5 INVENTORY §5 sweep: the 34 `[ws:C7]` claims spot-checked against the ported components; record conscious divergences (the scripted-fixture transcript and `setTimeout` reply do NOT travel — reconciliation 2; the board marker for an anchored thread is C5's — reconciliation 6; live-session data is B9's, cluster 7).
- [ ] 8.6 `BUILD-STATUS.json` left for track-c to land (implementers do not touch it). Sigil `<promise>C07-COMPLETE</promise>` emitted in the completion report.
