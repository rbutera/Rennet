## Why

A lens seat is asked to think in prose and then hand back one JSON object, and both halves of that bargain are failing.

The Design seat's turns were refused by the API before the model saw them, on 0.6.5 and again on the signed 0.7.0 build: `API Error: 400 tools.9.custom.input_schema.type: Field required`, because `z.union([DraftBoardSchema, DesignNoSpecSchema])` renders as `{ $schema, anyOf: [...] }` with no top-level `type` and `normalizeOutputSchema` strips the `$schema` (#810). The lane produced nothing — no board and no `no-spec` absence, because both returns rode the same union. #810 is closed by `e3dfb3fc`, which holds the two returns apart at the host. That fix is correct and narrow; the class it belongs to is still open, because a seat whose whole output is one document is one schema edit away from the same 400 every time.

The schema also decides what the transcript looks like. Seats now talk in prose as they work, which is the thing worth watching — and the Noise and Decisions live lines on the 0.7.0 drive rendered `StructuredOutput: {"document":null,"elements":[]}` as the seat's speech (#819), because the structured return arrives as an assistant message and `projectLatestEvent` reads assistant messages. The reviewer watching the bench was shown the machinery instead of the work.

And the schema is what makes a repair expensive in the one place cost still bites. A seat that gets one citation wrong re-emits the entire board to fix it. The repair TURN is already pointer-only (7,107 → 469 bytes), but what comes back is the whole document again, every time, because the document is the unit.

Rai's ruling, 2026-09-04: *"we might have chosen the wrong approach for the lens agents in the sense that we force an output schema in order to guarantee that the output will match what we are expecting… it means that every single turn gets rendered in the json schema, and often the lens agent needs to do a lot of thinking and talking as it works."* And the answer: *"there's probably a better approach which revolves around instantiating the boards eagerly / prematurely, exposing specific tools to the lens agents so that they can add to the board, and writing good prompts for them so that they can write to the board."*

The surface has the matching defect. The reviewer waits on a preparation bench, and when a lane settles its board is appended BELOW the bench — on a pane with no scroller, so on a 95-file branch four of five readers went off-screen with no way to reach them, and nothing on those boards said they were provisional. The readers that open a seat's transcript are disabled on a branch review (#819). And when one does open, it takes over the chat dock: *"we take over the orchestrator's chat with the lens agent's chat thread.. thats a big nono and should be removed or reworked. i'd want a right sidebar or something or a drawer or something like that, but the orchestrator chat should always be there"* (#823).

What Rai actually wants to watch is both at once: *"what if we were immediately taken to the main boards views and the lens headers would have spinners showing that they're working and each board would ultimately be visible as it is getting generated but there'd be a prominent ui widget showing the agent doing the work above, and clicking it would show you its full transcript updating live?"* — wireframe option 1, boards first.

## What Changes

- **BREAKING: a board is written with tools, not returned as a document.** Every lens board exists — empty, `drafting` — the moment its seat thread is created. The seat is given a small tool set scoped to its own board, derived from the kinds that lens already authors (`LENS_TYPED_KINDS` in `packages/core/src/board/lint.ts`, `HOST_KIND_SCHEMAS` in `packages/protocol/src/board/schema.ts`): `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, its own typed `add_*`, the matching `update_*`, `remove_element`, `settle_absent` where the lens admits an absence, and `finish`. Every tool input is a flat object of scalars and string arrays — no top-level union, no nested union, nothing that can reproduce the #810 rejection.
- **BREAKING: `outputFormat` is not set on a board seat turn.** The board schema stops travelling. The final assistant message is prose or nothing, `StructuredOutput` disappears from the transcript with the schema that produced it, and `boardOutputSchema()` leaves the seat path.
- **Validation moves to the tool boundary.** Structural rules become tool-input errors returned in the same call, with the element not created: the kind allowlist and dangling/cyclic element references become impossible rather than checked, and `cite` refuses a citation that falls outside the change, naming the nearest changed range. Cross-element rules run in `finish` and come back as a pointer-only list the seat fixes in the same turn. A refusal costs no attempt; an attempt is spent only when a turn ENDS without a successful `finish`.
- **The repair turn becomes "finish said X", and stays.** `renderRepairTurn` keeps its job for the case that still exists — a turn that died before finishing — and carries the last `finish` verdict and nothing else. The whole-board re-emission goes away because the board is no longer the unit.
- **A seat thread carries a per-thread MCP server, upstreamably.** Board seats run on T3 sidecar threads, which build their provider session from the user's settings and cannot today be handed a per-thread server. `thread.create` and `turn.start` gain an `mcpServers` field for both `claudeAgent` and `codex`; the vendored server already keys MCP config per thread internally (`McpProviderSession`) for its own browser tool, so the edit is a seam, not a mechanism. The server itself is Rennet's: a daemon-hosted loopback HTTP MCP server with one address per seat, which is the canvasOps loopback server the codebase has specified and never built — now with a purpose.
- **The live line never renders a tool call's JSON as speech.** Board tool calls project as receipts ("added step 3", "cited `src/foo.ts:41-58`", "finished the board"), and `projectLatestEvent`'s unknown-tool fallback — which prints `<toolName>: <raw JSON input>` — never applies to a board tool.
- **BREAKING: a review opens on the boards.** The preparation bench stops being a stage. Its slab becomes the workspace header while capture runs, its readers become the lens rail's working indicators plus one seat widget above the selected board, and the boards it used to append below itself ARE the workspace. `preparation-bench.tsx` is deleted once its three parts have homes.
- **The lens rail lists all five lenses from the start**, each selectable while its seat runs, each carrying a working indicator — not only the lenses with a terminal result, which is what `lensBoardsFromResolutions` yields today.
- **A board renders as it is written**, element by element off the tool calls, with an unmistakable in-progress state and a settled state at `finish`.
- **BREAKING: the chat dock is the orchestrator's, always.** A seat transcript opens in a right-side drawer that is a SECOND mount of the T3 thread view. `ui.lensThread`, `uiActions.openLensThread` and the dock's lens-thread arm are deleted (#823).
- **The workspace scrolls** (R44).

## Capabilities

### New Capabilities

- `board-tool-authoring`: a board exists before its seat runs and is written through a per-lens tool set; validation is a tool-boundary refusal or a `finish` verdict; no output schema travels on a seat turn; the seat reaches its board through a daemon-hosted loopback MCP server addressed per seat.
- `live-board-workspace`: a review opens on the boards; every lens is listed and selectable from the first frame; a board renders as it is written and says it is provisional; one seat widget carries the working seat and opens its transcript in its own surface.

### Modified Capabilities

- `lens-board-drafting`: a seat settles by calling `finish` or `settle_absent`, not by returning a document; a failure is a turn that ended having done neither.
- `t3-lens-threads`: the repair turn carries the last `finish` verdict, no output schema is attached to a seat turn, and the collector records each turn's tool-call count beside its tokens and duration.
- `t3code-sidecar`: a seat thread is created with a per-thread MCP server naming the daemon's loopback board endpoint, and the sidecar's egress statement names it as loopback that never leaves the machine.
- `t3code-chat-surface`: the chat slot renders the session's thread and only the session's thread; a seat transcript is another surface's business.
- `board-preparation-surface`: the workspace opens on the boards, not on a bench; the live line and the transcript control move to the seat widget and the drawer.
- `round-regeneration-reveal`: reveal is element-grained, not lane-grained; a lane's attempt is spent only by a turn that ended un-finished.
- `angle-prompt-contract`: an instruction names the tools it writes with, and still never restates a schema — the tool definitions travel once, as the tool list.
- `path-line-citations`: a citation is minted by `cite`, resolved against the patchset in that call, and refused with the nearest changed range when it does not resolve, so no board element ever carries an unresolvable one.
- `session-context-files`: a tool RESULT is not an inline prompt payload, and is bounded like one.

## Impact

- `packages/protocol/src/board/*`: the tool-input schemas as the model-facing surface beside `HOST_KIND_SCHEMAS`; the board's `drafting`/`settled` state and its element revision on the wire.
- `packages/core/src/board/lint.ts`: the rule set splits into a per-element set the tool boundary runs and a whole-board set `finish` runs; `LENS_RULES` becomes the union of the two, still one registry.
- `packages/server/src/runtime/lens-pipeline.ts`: `draftOneLens`, `validateDraft`, `renderRepairPrompt`, the retry ladder's attempt accounting, the eager board creation, `boardOutputSchema()`'s seat caller.
- `packages/server/src/board-tools.ts` (new) beside `agent-tools.ts`, and the loopback MCP server that serves it.
- `packages/server/src/t3/{client,threads,seat-progress,latest-event}.ts`: `mcpServers` on thread creation, the board-tool receipt verbs, element-level publication.
- `packages/adapters/src/{t3-seat-turn,council-seat-turn,claude-query}.ts`: the seat turn stops carrying `outputSchema`; the existing `name → { url }` MCP contract carries the seat's address.
- `vendor/t3code/apps/server/src/**`: the per-thread `mcpServers` seam, with a `PATCHES.md` row per file, on the pattern the `outputSchema` seam already set.
- `packages/prompts/src/prompts/{design,sequence,decisions,flagged,noise,report}.md` and `investigate-before-you-draft.md`: "your output is a draft board of typed blocks in the schema supplied with your task" becomes the tool vocabulary; `prompt-contracts.ts`'s emit slot.
- `packages/app-ui/src/app/preparation-bench.tsx` (deleted), `src/board/{lens-switcher,board-data}.tsx`, the board view components, `src/chat/t3-chat-dock.tsx`, `src/store/ui.ts`, `src/routes/{app,layout}.tsx`, and the new seat widget and transcript drawer.
- Docs: `docs/developing/concepts/{lens-pipeline,t3code-sidecar,harness-adapters,architecture-contracts}.md`, `docs/developing/contributing/*` where the board contract is described, and the `docs/using` pages that describe waiting for boards.
- Issues: #810's fix stands and its whole class is made unconstructible (group 1); #819 is closed in three pieces — the JSON live line (group 4), the scroll and the missing provisional state (group 5), the dead readers (group 6); #823 is closed by group 6. #785 is touched, not closed: its cut 1 landed already, its cuts 2 and 3 are about what a seat is SENT and are untouched here, and what this change does to the wire in either direction is a measurement (task 3.7), not a claim.
