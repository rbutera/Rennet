## Context

See `proposal.md` for why. This change follows `session-bound-workspace` and `round-worker-thread`, both still open; it takes their world as its starting state and archives neither. The state it starts from, read on `origin/main` on 2026-09-04:

- **One palette, five lenses.** `packages/protocol/src/board/schema.ts` freezes 13 host kinds; `DRAFT_OMITTED_KINDS` removes `message` and `review_comment`, leaving 11 a draft may author. Which of those a given lens may author is not in the schema at all — it is `LENS_TYPED_KINDS` in `packages/core/src/board/lint.ts` (`design: decision + requirement`, `sequence: order_step`, `decisions: decision`, `flagged: finding`, `noise: noise_verdict`, `report: round_outcome`) plus a `SHARED_KINDS` set of `prose / section / callout / annotation / code_ref`. A wrong kind is caught by the `kind-allowlist` lint rule after the fact.
- **The board is one return.** `boardOutputSchema()` binds the seat's turn through `startTurn`'s `outputSchema`; `draftOneLens` parses it, `validateDraft` lints it, and one pointer-only repair turn follows (`LADDER_RUNGS = 1`, the per-lane budget table is `[1, 1]`). Design's own return needed two shapes and got a `z.union`, which renders as `{ $schema, anyOf }` with no top-level `type` — `400 tools.9.custom.input_schema.type` (#810, since fixed at the host by `e3dfb3fc`).
- **Lint is 21 rule functions over 29 rule ids**, pure, `lint(draft, ctx) => Violation[]` with `Violation = { ruleId, elementRef, message }` and an `<elementId>/<field>` pointer grammar. Roughly two thirds of them read one element; the rest read the whole board.
- **A seat thread cannot be handed an MCP server.** `createThread` on `packages/server/src/t3/client.ts` has no such parameter, and neither does anything under it: `ThreadCreateCommand` (`vendor/t3code/packages/contracts/src/orchestration.ts:737`) and `ThreadTurnStartCommand` (`:903`) carry no server field. Inside the vendored server the machinery is per-thread already — `McpProviderSession` is a `Map<ThreadId, config>` written only by `ProviderService.prepareMcpSession` behind the `enableAgentBrowserAccess` setting, and read by `ClaudeAdapter.ts:4462-4474` and `CodexAdapter.ts:1686-1715` under the hardcoded name `t3-code`.
- **The transport contract already exists on Rennet's side.** `ClaudeQueryOptions.mcpServers` is a `name → { url }` record shared by the Claude, Codex and OMP adapters; `claude-query.ts` lowers it to the SDK's `{ type: "http", url }`. Codex's app-server takes `-c mcp_servers.<name>.url=…` and `-c mcp_servers.<name>.bearer_token_env_var="…"`, with the raw token in the child environment and never on argv.
- **The live line reads assistant messages and tool details.** `projectLatestEvent` picks the newest in-flight tool activity or the last sentence of assistant text. An unknown tool falls back to `capLine(detail)`, where `detail` is `<toolName>: <raw JSON input>`; and the structured return arrives as assistant text, which is how `StructuredOutput: {"document":null,"elements":[]}` became the Noise seat's speech (#819).
- **The surface waits on a bench.** `preparation-bench.tsx` (646 lines, one importer) draws a slab, a capture rail, five readers with per-seat live lines and core-sample marks, and appends each settled board below itself. Its root `<section>` is `mx-auto flex min-h-full … justify-center-safe` with no scroller, under `routes/layout.tsx`'s `fixed inset-0 … overflow-hidden` frame — the repo's own primary-scroller idiom (`min-h-0 flex-1 overflow-y-auto`, named at `routes/layout.tsx:208-210`) was never applied to it. Which lenses the rail lists is decided by `lensBoardsFromResolutions` in `board/board-data.ts:196-211`: terminal results only. `t3-chat-dock.tsx` is the single mount of the T3 thread view, and `ui.lensThread` retargets it.
- **Measured, 0.7.0, `drive/group5` (95 files):** seat prompts are 6,293–6,962 bytes and Design 12,441, byte-identical across a 1-file and a 95-file branch. The generation billed 6,687,639 tokens across 11 turns, 6,231,962 of them cache reads. Wall clock 9 min 32 s; first core board at 360 s. Those are the numbers this change is measured against.
- Constraints: Rule Zero; the token-discipline section of `CLAUDE.md` (no inline context, the schema travels once, usage reaches a sink, seats inherit the user's settings); `effect`/`@t3tools` stay behind `t3/client.ts`; every vendored edit gets a `PATCHES.md` row; the documentation obligation is part of done.

## Goals / Non-Goals

**Goals**

- A seat writes its board as it works, in small typed calls, and the reviewer watches the board fill.
- No output schema travels on a board seat turn, so the #810 family cannot recur and the transcript is prose.
- Two whole classes of lint violation become impossible rather than checked, and the rest are answered inside the turn that caused them.
- A review opens on the boards; every lens is present and selectable from the first frame; the board says it is provisional in three independent ways.
- The orchestrator's chat dock is never displaced by anything.
- The persisted board is byte-compatible with the boards drafted before this change.

**Non-Goals**

- Changing the 13-kind palette, the frozen `HostElementSchema`, or what a board IS. This changes how one gets written, not what it holds.
- Changing which seat runs on which provider, the Flagged dual-seat reconciliation, or the model council's resolution.
- Re-litigating settings inheritance. `strictMcpConfig` and `settingSources` stay exactly where they are on both the Rennet and the vendored side.
- A general agent-tool framework. This is one tool surface for one job, derived from a table that already exists.
- Bounding what a seat may do. The per-seat address names which board a call writes; it is addressing, not authorization, and nothing here denies a seat a capability.
- Compacting the hunk inventory (#785 cut 2) or discovery relevance (cut 3). Those are about what a seat is SENT; this change is about what it sends back.

## Decisions

**D1. One change, not two.** The client cannot render a board element by element unless the engine emits element-level events, and those events exist only because a tool call is the unit of work. Splitting would leave a client change specifying a surface for events that do not exist, or an engine change whose whole visible benefit is unreachable. So: one change, two new capabilities, and a task order in which every engine group ships before the client group that consumes it.

**D2. The tool set is a projection of the tables that already decide it.** `SHARED_KINDS ∪ LENS_TYPED_KINDS[lens]` names the kinds; `HOST_KIND_SCHEMAS[kind]` and `AUTHORED_BOARD_SCHEMA[kind]` name the fields and which of them are element references. The tool surface is built by iterating those, exactly as `buildAppTools` iterates the command registry — no hand-written per-lens list, so a new kind or a lane reassignment cannot leave the tools behind. Host-owned fields are not on any tool: `author` (the seat is known), `patchset_id` (stamped once before persistence, as today), `judge` on a noise verdict (a seat is `llm`), `status` on a finding (a draft is `open`), and `concurrence` / `accord` (computed by `reconcileFindings` at lane settle).

Per lens, in one line each:

- **Design** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_requirement`, `add_decision`, `update_*` for each, `remove_element`, `settle_absent`, `finish`.
- **Sequence** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_step`, `update_*`, `remove_element`, `finish` — and no `settle_absent`, because Sequence admits no absence.
- **Decisions** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_decision`, `update_*`, `remove_element`, `settle_absent`, `finish`.
- **Flagged** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_finding`, `update_*`, `remove_element`, `settle_absent`, `finish`.
- **Noise** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_noise_verdict`, `update_*`, `remove_element`, `settle_absent`, `finish`.
- **Round report** — `set_document`, `add_section`, `add_prose`, `add_callout`, `cite`, `add_annotation`, `add_outcome`, `update_*`, `remove_element`, `finish` — and no `settle_absent`, because the report seat is not a lens and admits no absence.

Those lines are a gloss on the derivation, not a second source for it. The set is `SHARED_KINDS ∪ typed kinds` with an `add` and an `update` for every kind in it, which is why the report seat gets `add_callout` and `add_annotation` like every other target — the kind table already grants it those kinds, and a hand-kept exception is exactly what D2 exists to forbid.

`settle_absent` takes a note and no reason: the reason is the lens's one admissible absence, named in the tool's own description (`no-spec`, `no-decisions`, `no-findings`, `no-noise`). A seat cannot name an absence its lens does not admit, because there is no field to name it in. A lens with more than one LIVE absence is a build-time error rather than a lens quietly losing the verb: the derivation would have nothing to choose with.

**D3. Every tool input is a flat object of scalars, string enums and string arrays, and a control proves it.** No object-valued field, no array of objects, no union of shapes, nothing that renders as a bare `anyOf`. A `SourceRef` becomes `source_path` / `source_candidate` / `source_line`; a citation is not a nested object but an id returned by `cite`. A LIST of source refs carries only `source_paths`: parallel arrays are aligned by index, every extra part is one more way to misalign them, and candidate and line earn their place only on the single-valued form where there is no index. Where a list keeps two parts because both are load-bearing (`stats`), the writer refuses a companion without its spine and refuses arrays of different lengths, naming the field — the alternative is a call that quietly writes the shorter list or wipes the field it was never given. The tool-input schemas are their own module beside `HOST_KIND_SCHEMAS`, and a test renders every one of them to JSON Schema and fails when any lacks a top-level `"type": "object"` or contains `anyOf` / `oneOf` / `allOf` at any depth. That control is the whole answer to #810: not a fixed union, but a shape in which a union cannot be written.

Alternative considered: one `add_element({ kind, data })` tool with `data` as free JSON. Rejected — it puts the palette back inside a payload the API cannot check, restores the kind allowlist as a runtime rule, and gives the model no per-kind field documentation, which is the main thing tools buy over a schema.

**D4. Ids are minted by the host and returned; a child names its parent.** `add_*` returns `{ id }`. Every reference argument (`parent_id`, `code_ref_ids`, `span_ref_id`, `evidence_ref_ids`, `alternative_ids`, `scenario_ids`, `trace_ref_ids`, `hunk_ref_id`) must name an element the board already holds, and the tool refuses one that does not, naming what it does hold. Two consequences, both structural rather than checked: a dangling element reference cannot be created, and neither can a cycle, because a reference can only point backwards in time. The board's `children` arrays are maintained by the host from the parenting, so the tree is always orderable — which is exactly what `element-reference-resolves` exists to prove.

Alternative considered: let the seat mint ids. Rejected — it re-admits both failure modes and adds a third (collision between the two Flagged seats).

**D5. Validation is two-tier, and the tiers are assigned by what a rule reads.**

*Refused at the tool boundary, in the same call, with the element not created:*

| Rule | Where |
|---|---|
| `kind-allowlist` | impossible — the lens has no tool for a foreign kind |
| `element-reference-resolves` (dangling and cyclic) | impossible — D4 |
| `no-code-bytes`, `no-dialogue`, `no-remainder-narration` | the prose field the call carries |
| `citation-well-formed` | the prose field the call carries |
| `process-vocabulary` | the structural field the call carries |
| `citation-resolves` (file exists, side inventory, range order, patchset identity) | inside `cite` |
| `unresolvable-citation` | inside `cite`, refusing with the nearest changed range on that path and side |
| `scaffold-is-noise-lane` | inside `cite`, on any seat but Noise |
| `decision-grounded` | `add_decision` needs at least one evidence id and one alternative id, unless the Design stated-source arm applies |
| `design-source-known`, `-candidate-known`, `-line-known`, `design-decision-stated`, `design-related-file-known`, `requirement-source-known` | the source and related-file fields the call carries |

*Returned by `finish` as a pointer list the seat fixes in the same turn:*

`report-coherent`; `requirement-order`, `requirement-scenario-parenting`, `requirement-scenario-narrative`, `requirement-verbatim`; `design-artifact-set-complete`, `design-artifact-content-complete`, `design-artifact-content-hierarchy`, `design-artifact-content-order`, `design-header-complete`, `design-incompleteness-visible`; the Sequence reachability rule (every step reachable from a top-level section); and the emptiness check that today authorizes an absence.

`lint` stays one pure function over one registry — the split is a partition of `LENS_RULES`, not a second rule set, and a test asserts the two partitions reunite to exactly `LENS_RULES` so a new rule cannot land unassigned.

**D6. A refusal costs nothing; an attempt is spent by a turn that ends unfinished.** A tool-boundary refusal and a `finish` verdict are both tool results inside a live turn: the seat reads them and fixes the thing, and no ladder rung is consumed. An attempt is spent only when the turn ENDS having called neither `finish` nor `settle_absent` — the context ran out, the harness died, the seat stopped. The per-lane budget table (`[1, 1]`) and `round-regeneration-reveal`'s proportionality requirement are unchanged in shape; what changes is that they now count a much rarer event.

`renderRepairTurn` survives with a smaller job: the follow-up turn carries the last `finish` verdict and nothing else — "finish said X" — because the base prompt and every element are already in the thread and on the board. It does not disappear, because a turn that dies before finishing is a real state and the lane must still be repairable from it. The partial board is KEPT, not discarded: the seat resumes writing into it.

**D7. The MCP seam is the minimal upstreamable T3 change, not a `.mcp.json`.**

The vendored server already keys MCP configuration per thread; what is missing is a way for a caller to reach it. So: `ThreadTurnStartCommand` and `ClientThreadTurnStartCommand` (`packages/contracts/src/orchestration.ts:903`, `:928`) gain an optional `mcpServers` record of `{ url, bearerToken? }`, immediately after the `outputSchema` field that set this precedent; `decider.ts:964` copies it onto the turn-start event; `ProviderCommandReactor.ts` threads it into `ProviderSessionStartInput` and `ProviderSendTurnInput`; `packages/contracts/src/provider.ts:52-86` declares it on both, because `ProviderService` re-decodes them and strips unknown keys; and the two adapters merge it with whatever `McpProviderSession` holds, `t3-code` last so T3's own server wins a name collision. `ThreadCreateCommand` needs nothing: `ThreadTurnStartBootstrap` already carries `createThread`, so the turn-start path covers creation.

`McpProviderSession` is left alone. Widening it looks tidier and is worse: `prepareMcpSession` re-runs on every session re-prepare (runtime mode, cwd, model), so a merged map would need the caller's servers threaded through all of those paths or be clobbered by one of them; and its `agentBrowserAccessEnabled` deny branch clears the whole map, so a user turning off agent browser access would silently lose the board server too. Carrying the caller's servers alongside, and merging at the adapter, is also the closer analogue of `outputSchema`, which touched no registry.

Two constraints inherited from the SDK, both already solved once in this tree: `mcpServers` is fixed when `query()` is constructed, exactly as `outputFormat` is, so the servers are a session-level fact decided by the thread's FIRST turn — the mismatch machinery `ClaudeAdapter.ts` already carries for `outputSchema` (remember the contract on the session context, compare on a later turn, refuse by name) is copied verbatim. And `strictMcpConfig` is not set on the turn path and is not added here; the user's own configured servers keep merging in, which is the settled ruling.

On the Codex leg the args are `-c mcp_servers.<name>.url=<endpoint>` and `-c mcp_servers.<name>.bearer_token_env_var="<VAR>"`, with the raw token placed in the child environment under that variable and never on argv — copy that hygiene exactly. One latent bug must be fixed in the same change: `hasConfiguredMcpServer` substring-matches `mcp_servers.`, and its second consumer sets `browserToolsAvailable` on the Codex turn params. Appending a board server to `appServerArgs` earns the tool-catalog reload for free but would also make Codex's prompt claim browser tools it does not have — a lie in the prompt. Split the predicate, or narrow the `browserToolsAvailable` check to `mcp_servers.t3-code.`.

**Rejected alternative (b): write a `.mcp.json` into the bound worktree.** It needs no vendored edit and rides settings inheritance, which is genuinely attractive. Its costs are the reasons it is the fallback and not the plan: it is per-WORKTREE, not per-thread, so all six seats of a generation see all six boards' tool sets and the address stops naming which board a call writes — the seat would have to pass a board id and get it right; it writes a file into the reviewer's own checkout, which Rennet must then add to its managed ignore block and purge, in a repository that may already have its own `.mcp.json` to merge with; it cannot be revoked per seat when a lane settles; and Codex's app-server reads `-c` args, not `.mcp.json`, so the Noise and Flagged-second seats would need the other mechanism anyway. It stays written down as the escape if the fold cost of the vendored rows proves unacceptable.

**D8. The board server is Rennet's, on loopback, addressed per seat.** The daemon hosts one HTTP MCP listener bound to `127.0.0.1`. Each seat gets an address of the form `http://127.0.0.1:<port>/board/<seatId>` and a bearer minted as 32 random bytes, of which only the SHA-256 hex is stored, against a scope carrying the generation, the lens and the seat — the pattern `McpSessionRegistry` already uses for T3's own browser server, with liveness refreshed on every turn and eager revocation when the lane settles rather than a timeout. It is NOT mounted inside T3's `/mcp`, whose own comment records that it sits outside the environment auth stack; it is Rennet's listener, and its only client is a harness child on the same machine.

This is the loopback MCP server `canvasops-mcp-surface` and `codex-harness-adapter` have specified and Rennet has never built. It is not canvasOps@2 — the tools are board authoring, not canvas interaction — but it lands the transport those requirements assume.

**The address is addressing, not authorization.** A seat writes its own board because that is what its endpoint is for, the same way a file handle names a file. Nobody is being prevented from anything, no capability is being withheld, and a later reader who reads a restriction into it and reaches for more of one is on the wrong side of Rule Zero.

**D9. Flagged is two seats, two addresses, one board.** Each seat's elements are stamped with the voice that wrote them and land on the Flagged board as they arrive; ids are host-minted so the two writers cannot collide; `concurrence` and `accord` are stamped by the existing `reconcileFindings` when both seats have settled, not by a tool. The surface shows findings from both voices as they land and the reconciliation marks appear at lane settle.

**D10. Counts are derived; the gist is authored.** `LensSection.counts` is computed by the host from what the seat actually added under that section. A seat-typed count can disagree with the board it describes; a derived one cannot, and the Sequence prompt's "honest counts" instruction becomes a property rather than a request. The one-line `gist` stays the seat's, on `add_section`.

**D11. The live line reads a receipt, never a payload.** `projectLatestEvent` gains a board-tool arm ahead of its unknown-tool fallback, so `<toolName>: <raw JSON>` can never be a seat's speech: `cite` reads `cited src/foo.ts:41-58`, `add_step` reads `added step 3`, `finish` reads `finished the board` or `finish returned 1 pointer`. `StructuredOutput` stops appearing at all, because nothing produces it once the schema is gone. Both halves of #819's live-line defect are answered — one by a new arm, one by deletion.

**D12. The bench is decomposed, not moved.** `preparation-bench.tsx` is deleted, and each of its three parts gets a home: the slab and its two-beat capture rail become the workspace header while capture runs; the five readers become the lens rail's per-seat indicators plus one seat widget above the selected board; the boards it appended below itself are the workspace. The core-sample marks (#818) move onto the rail's existing per-lens stop — `lens-switcher.tsx`'s own comment already calls that stop "the same device the bench's core samples hang on, at rail scale", so the `data-cut` register rides it rather than being invented somewhere new.

The rail lists all five lenses from the first frame. That is a change to `lensBoardsFromResolutions`, not to `LensSwitcher`: the switcher renders what it is given, and what it is given today is terminal results only.

**D13. Provisional is said three ways, and the board is the same view settled or not.** The tab spins, the board header carries an `in progress` chip and says the board is still being written, and the last row is a ghost saying the next element lands there. When the lane settles, the tab stops spinning, the widget collapses to a one-line receipt, and the chip and ghost clear — nothing navigates, because the drafting view and the finished view are the same route.

Delta marks are withheld while a board drafts and appear at `finish`: a partial board would mark every element new, which is a lie the reviewer would act on. Retry becomes per-lens, offered from the widget's failure state; the generation-wide retry moves to the workspace header.

**D14. The drawer never displaces the dock, and the diff and the drawer share one slot.** The transcript opens as a right-aligned drawer INSIDE the main region. The chat dock keeps the session thread in every state — that is the whole of #823 — so `ui.lensThread`, `uiActions.openLensThread` and the dock's lens-thread arm and back button are deleted, and a new `ui.seatTranscript` drives the drawer. The diff view and the drawer occupy the same slot: opening one closes the other and the control says which. Below the shell's `MIN_SURFACE_WIDTH` the drawer takes the whole main region, still without touching the dock.

Recorded because it is a choice and not a finding: #823 says "right sidebar or something or a drawer or something like that" and specifies nothing about the diff view or narrow widths, and wireframe option 1's second variant draws the transcript as a drawer that pushes the board DOWN. A right-aligned drawer is chosen over the push-down because the board and the transcript are read together — the wireframe's own tie letters pair an element with the receipt that made it — and a push-down puts them one scroll apart.

**D15. The workspace scrolls.** The board region takes the repo's primary-scroller idiom (`min-h-0 flex-1 overflow-y-auto`), which the bench never got, and R44 says a screen may scroll rather than truncate a stage to one viewport.

## Risks / Trade-offs

- [The tool definitions are a new per-session cost the diff cannot show] → they travel once per session as the MCP tool list, where the output schema used to travel once per turn. Every pull request in this change records per-seat prompt bytes, output tokens, tool-call count and wall clock on the `drive/group5` fixture against the 0.7.0 baseline (6,293–6,962 bytes, 6,687,639 tokens across 11 turns, 9 min 32 s), and the change is not done if the totals moved the wrong way without a stated reason.
- [A chatty seat makes many small calls and spends more output tokens than one document did] → possible, and it is the measurement above that answers it rather than an argument. The offsetting facts are that a repair now costs one `update_*` instead of a whole board, and that a refused call costs a tool result instead of a turn.
- [`mcpServers` is fixed at `query()` construction, so a thread's first turn decides its servers] → the address is per seat per generation and a new generation is a new thread, so nothing needs to change mid-thread. The `outputSchema` mismatch machinery is copied for the case where something tries.
- [The vendored ledger grows again, and 12 rows are already `yes | pending` upstream] → the rows this change adds sit on the same files the `outputSchema` seam already touched, so the fold surface widens by very little; and this is the second seam that would have been unnecessary if the first had been filed upstream, which is an argument for filing both.
- [A seat's turn ends without `finish` and its partial board is on screen] → the partial board is kept, marked un-finished with its reason, and the repair turn resumes writing into it. Discarding it would throw away work the reviewer already watched arrive, and inventing a settlement over it is the silent-absence defect `lens-board-drafting` exists to forbid.
- [Two Flagged seats write one board concurrently] → ids are host-minted so they cannot collide, arrival order is the order, and reconciliation stamps agreement only when both have settled. The risk that survives is a reviewer reading an unreconciled finding as final; the board says the lane is still drafting until both voices are in.
- [Element-level reveal makes the existing generation timings mean something different] → `time-to-first-core-board` keeps its definition (the first core lane that SETTLED), and a new figure records the first element on screen. Two numbers, neither redefined.
- [Rewriting six prompt files loses instruction that was carrying weight] → each prompt's "your output is a draft board of typed blocks in the schema supplied with your task" is replaced by the tool vocabulary and nothing else moves in the same commit, so the diff shows exactly what changed about what the seat is told.
- [Deleting `preparation-bench.tsx` loses a surface people liked] → nothing in it is deleted, only rehomed, and the file is removed last, after each part has a home and a test.

## Migration Plan

1. **Tool schemas and boundary validation**, with no engine wiring: the tool-input module, the `LENS_RULES` partition, and the JSON-Schema control. Shippable and provable on its own; nothing calls it yet.
2. **The seam and the server**: the vendored `mcpServers` field with its `PATCHES.md` rows, the `hasConfiguredMcpServer` split, and Rennet's loopback board listener. Proof is a seat thread that calls one tool and gets an answer.
3. **Seats write with tools**: eager boards, `finish` / `settle_absent`, `outputFormat` off the seat path, the repair turn reduced to the verdict, the prompts rewritten. Measured against the 0.7.0 baseline. The persisted board shape does not change, so a board drafted here reads identically to one drafted before.
4. **Element-level publication and receipts**: the board's revision on the wire, the live line's board-tool arm, tool-call counts to the collector.
5. **Client, boards first**: the rail lists five, the review opens on the boards, the board renders as it is written with its three provisional signals, the workspace scrolls.
6. **Client, the widget and the drawer**: the seat widget, the transcript drawer as a second mount, the dock restored to the session thread, `preparation-bench.tsx` deleted.
7. **Proof**: one real drive.

Rollback is per wave by revert. No board data migration is written, because none is needed: the same `HostElement[]` is persisted either way, and a reverted build reads a tool-written board without knowing it was one.

## Open Questions

- Whether the round-report seat moves to tools in this change or keeps its narrow classification schema. It is not a lens, its schema has no union, and it works; one contract for every seat is the better end state, and it can land in a later wave without changing these specs.
- Whether the drawer and the diff view should be allowed open together above some width, rather than always sharing one slot.
- Whether `gist` stays authored at all once counts are derived, or whether the host can say the same thing from the section's own title and contents.
