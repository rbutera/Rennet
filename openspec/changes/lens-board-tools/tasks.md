## 1. The tool surface and the two-tier validation (D2, D3, D4, D5)

Ships on its own: nothing calls it yet, and the controls prove it before anything does. Closes the #810 class.

- [ ] 1.1 Add the board tool-input schemas beside `HOST_KIND_SCHEMAS`, DERIVED by iterating `SHARED_KINDS ∪ LENS_TYPED_KINDS[lens]` over `HOST_KIND_SCHEMAS` and `AUTHORED_BOARD_SCHEMA`, the way `buildAppTools` iterates the command registry. Flat inputs only: scalars, string enums, arrays of scalars; a source reference becomes `source_path` / `source_candidate` / `source_line`; host-owned fields (author, patchset id, judge, draft status, concurrence, accord) appear on no input
- [ ] 1.2 Control, and the whole answer to #810: render every tool input to JSON Schema and assert each declares a top-level object type and contains no `anyOf` / `oneOf` / `allOf` at any depth; prove it can fail by giving one input a union-valued field and watching it redden
- [ ] 1.3 Assert the derivation: a test that adds a kind to a lens's typed-kind table and finds the verbs present with no per-lens list edited, and one that finds no verb for a kind the lens does not author
- [ ] 1.4 Implement the board writer: host-minted ids, parent-named-by-child structure, `children` maintained by the host, a reference argument refused when the board does not hold it. Controls: a dangling reference and a cycle are both unconstructible through the tools, each proven by attempting it
- [ ] 1.5 Partition `LENS_RULES` into the boundary tier and the finish tier per design D5's table, keeping one registry and one pure `lint`; assert the two partitions reunite to exactly `LENS_RULES`, so a new rule cannot land unassigned
- [ ] 1.6 Implement the boundary checks as refusals that name the field and say what would be admissible, and `finish` as the whole-board verdict returning pointers only; the Sequence reachability rule and the emptiness check move to `finish`
- [ ] 1.7 Implement the citing verb: resolve against the captured patchset in the call, return a reference on success, refuse with the nearest changed range on failure; controls for outside-the-change, no-changed-lines-on-that-side, inverted range, and a scaffold path on a non-Noise seat

## 2. The seam and the loopback board server (D7, D8)

Ships on its own: a seat thread can call one tool and get an answer, with no board behaviour changed yet.

- [ ] 2.1 Vendored: add optional `mcpServers` (`name → { url, bearerToken? }`) to `ThreadTurnStartCommand` and `ClientThreadTurnStartCommand` in `packages/contracts/src/orchestration.ts`, beside the `outputSchema` field that set the precedent; thread it through `decider.ts`, `ProviderCommandReactor.ts`, `packages/contracts/src/provider.ts` (`ProviderSessionStartInput` and `ProviderSendTurnInput` — `ProviderService` strips undeclared keys) and `ProviderService.ts`. `McpProviderSession` is not widened; the servers ride alongside and merge at the adapter
- [ ] 2.2 Vendored: merge at both adapters — Claude with the sidecar's own name last so it wins a collision, Codex as `-c mcp_servers.<name>.url=…` plus `-c mcp_servers.<name>.bearer_token_env_var="…"` with the token in the child environment and never on argv. Copy `ClaudeAdapter`'s existing output-schema mismatch machinery for the session-level fix at `query()` construction. Do not set `strictMcpConfig`
- [ ] 2.3 Vendored: split `hasConfiguredMcpServer` so a caller-supplied server still earns the tool-catalog reload but does NOT set `browserToolsAvailable` — today it substring-matches `mcp_servers.`, so a board server would make Codex's prompt claim browser tools it does not have. Test both halves
- [ ] 2.4 Vendored: a `PATCHES.md` row per touched file (path, reason, upstreamable, upstream PR), on the shape the twelve `outputSchema` rows already use; `pnpm t3:check-ledger` green
- [ ] 2.5 Daemon: the loopback HTTP MCP board server — bound to the local interface, one address per seat, credential minted per seat as random bytes with only its digest stored, liveness refreshed per turn, revoked eagerly when the lane settles. Its own listener, not mounted inside the sidecar's `/mcp`. Controls: a stale credential is refused, a revoked one stops working at once, and no credential appears on a child's argument list
- [ ] 2.6 `createThread` / the seat turn carries the seat's server through `packages/server/src/t3/{client,threads}.ts`; a Flagged lane gets two addresses onto one board and the ids they receive cannot collide
- [ ] 2.7 State in the PR the size of the tool surface each seat now receives, in bytes, beside the output schema it replaces

## 3. Seats write with tools (D1, D6)

Closes the #810 class in production; partially answers #785 on the return side, not the prompt side.

- [ ] 3.1 Create every lens board empty and `drafting` when its seat thread is created, before the first turn; a lane that writes nothing settles over that board with its reason
- [ ] 3.2 Stop setting `outputFormat` on board seat turns; remove `boardOutputSchema()` from the seat path; `draftOneLens` and `validateDraft` settle on `finish` / settle-absent instead of parsing a return. `StructuredOutput` stops appearing on a seat thread at all
- [ ] 3.3 Attempt accounting: a refusal and a `finish` verdict cost nothing; an attempt is spent only by a turn that ends unsettled. The partial board is kept and marked unsettled with its reason; `renderRepairTurn` carries the last verdict and nothing else and resumes the same board. Control: a turn with ten refusals and one verdict records one attempt
- [ ] 3.4 Flagged: two seats write one board, each element stamped with its voice; `reconcileFindings` stamps concurrence and accord at lane settle, not at write. Control with a two-voice fixture that the marks are absent until both voices settle
- [ ] 3.5 Host-derive `LensSection.counts` from what the seat actually added; the authored one-line gist stays on the section verb. Control: a board whose counts disagree with its contents is unconstructible
- [ ] 3.6 Rewrite `design.md`, `sequence.md`, `decisions.md`, `flagged.md`, `noise.md` and `investigate-before-you-draft.md`: "your output is a draft board of typed blocks in the schema supplied with your task" becomes the tool vocabulary, naming each verb by the job it does and no field list. Nothing else moves in the same commit
- [ ] 3.7 Measure and state in the PR, on `drive/group5`, against the 0.7.0 baseline (prompts 6,293–6,962 bytes and Design 12,441; 6,687,639 tokens across 11 turns; 9 min 32 s wall clock; first core board at 360 s): per-seat prompt bytes, output tokens, tool calls per turn, and wall clock. A total that moved the wrong way without a stated reason is not done

## 4. Element-level publication and honest receipts (D11)

Closes the JSON-as-speech half of #819. The client group depends on this.

- [ ] 4.1 Publish the board's element stream and its drafting/settled state on the wire, keyed so a client can render an element as it lands and cannot render a superseded generation's
- [ ] 4.2 Give `projectLatestEvent` a board-tool arm ahead of the unknown-tool fallback, so a board call reads as a receipt ("added step 3", "cited `src/foo.ts:41-58`", "finish returned 1 pointer") and never as `<toolName>: <raw JSON>`. Control: remove the arm and watch the no-raw-input assertion redden
- [ ] 4.3 Thread the per-turn tool-call count to the collector beside tokens and duration; control that dropping it on one seat path fails the assertion
- [ ] 4.4 Record time-to-first-element as its own durable figure; time-to-first-core-board keeps its meaning as the first core lane that settled

## 5. Client: boards first (D12, D13, D15)

Closes the scroll and the no-provisional-state halves of #819.

- [ ] 5.1 `lensBoardsFromResolutions` lists all five lenses for the generation from the first frame, each carrying its seat state; a running lens is selectable and is never a disabled segment; Flagged carries one indicator per voice
- [ ] 5.2 The review route opens on the board view; capture is reported in the workspace header with its two named beats and its cancel; no waiting stage stands in front of the boards
- [ ] 5.3 The board renders each element as it lands, with the three independent provisional signals — the rail indicator, the board header's in-progress mark and its "still being written" line, and the placeholder last row — all clearing together at settle. Control: remove one signal and watch the three-ways assertion fail
- [ ] 5.4 Withhold round-delta marks while a board is unsettled and show them at settle; move the retry to per-lens on a failed lane, with the generation-wide retry in the workspace header
- [ ] 5.5 Move the core-sample cut register onto the rail's existing per-lens stop, which `lens-switcher.tsx` already calls the same device at rail scale (#818)
- [ ] 5.6 Give the board region the repo's primary-scroller idiom (`min-h-0 flex-1 overflow-y-auto`); a settled board on a 95-file change is reachable end to end, widget included. Prove it by driving the app, not by reading the class list (R44)

## 6. Client: the widget, the drawer, and the dock restored (D14)

Closes #823 and the disabled-reader half of #819.

- [ ] 6.1 The seat widget above the selected board: lens, provider, model, elapsed, live line, what it has written so far; two voices side by side for Flagged; failure in place with that lens's retry; collapsing to a one-line receipt at settle, which still opens the transcript
- [ ] 6.2 The transcript drawer as a SECOND mount of the T3 thread view, right-aligned inside the board region, read-only, streaming, opened from the widget. Selecting a lens moves board, widget and transcript together
- [ ] 6.3 Delete `ui.lensThread`, `uiActions.openLensThread`, the dock's lens-thread arm and its back button; the chat dock shows the session's thread in every state. Control: a test that points the slot at a seat thread and finds no way to
- [ ] 6.4 The drawer and the diff view share one slot: opening either closes the other and the control says which; below the shell's minimum surface width the drawer takes the whole board region and still does not touch the dock
- [ ] 6.5 Delete `preparation-bench.tsx` once its slab, its capture rail, its readers and its core marks all have homes, and remove its route branch
- [ ] 6.6 Docs: `docs/developing/concepts/lens-pipeline.md` (the four sentences that say the seat's session is bound to the board schema, and the paragraph claiming Codex board seats get an explicit empty MCP-server table — which describes the deleted ephemeral legs, not the sidecar path), `t3code-sidecar.md` (the output-schema-as-contract section, the per-thread MCP servers, the loopback board server in the egress statement), `harness-adapters.md`, `architecture-contracts.md`, and the `docs/using` pages that describe waiting for boards

## 7. Proof

- [ ] 7.1 One real drive of the packaged app on `drive/group5` (95 files) and a one-file branch, observing all of: every lens present in the rail from the first frame; a board filling element by element with the in-progress mark, the rail indicator and the placeholder row all showing and all clearing together; no live line containing raw JSON on any of the six seats; a seat transcript open in the drawer WHILE the chat dock still shows the session thread; the whole board region scrolling end to end on the 95-file branch; and the Design lane settling — as a board on a branch with a spec and as `no-spec` on one without, having been refused by nothing
- [ ] 7.2 Record beside the 2026-09-04 numbers in `t3code-sidecar.md`: per-seat prompt bytes, tool-surface bytes, output tokens, tool calls per seat, wall clock, time-to-first-element and time-to-first-core-board, for both branches. State plainly which figures moved and why
