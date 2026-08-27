# Tasks — b03-protocol-contracts (B3, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: #462 (all five comments — the ripples are schema), #465, #466, #457, #461, engine asset §2 (#489 comment 5431046330), client asset risks 1–2 (#489 comment 5431046569). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

## 1. board/ — the host schema on the authoring kit

- [x] 1.1 Add `@wboard/core@0.1.0-alpha.2` (exact pin) to `packages/protocol/package.json`; `sh -c 'pnpm install'`; confirm the `licenses` target accepts it (MIT) and notices regenerate through the normal gate.
- [x] 1.2 Author `src/board/` — the #462 schema on the kit's host-schema authoring surface, 13 kinds: Tier A `finding` (`severity high|medium|low` — reuse the shipped `FindingSeverity` scale, do not fork; `concern` md; `code → code_ref[]`; `concurrence {model, agree, total}[]`; `status open|addressed|dismissed`), `decision`, `requirement`, `noise_verdict`, `order_step`, `round_outcome` (`status addressed|partial|untouched|beyond`, ask ref + display text, note, `code_ref?`); Tier B `section` (with the R58 `delta: new|reworked` stamp, absent = carried), `prose`, `callout`, `annotation`, `message` (role; `reply_to`; quote anchor `{target, quote, offsetHint?}`; the ask lifecycle `staged|dispatched|addressed|retired|detached`), `code_ref` (`patchset_id, path, side base|head, start_line, end_line, symbol?`), `review_comment`. Shared envelope on every kind: `author {kind: human|lens-agent|orchestrator, id}`. Closed palette — no `custom`; references only via `element`-typed attributes; extras pass through. Export `HostBoardSchema`.
- [x] 1.3 `DraftBoardSchema` **derived** from `HostBoardSchema` by `omit` of the curation-side kinds (the human/thread family — `message`, `review_comment`; settle the exact set against #462's tiers and record it in a comment) — never hand-written. Seam `parseDraft(unknown) → Result<DraftBoard, ZodIssue[]>`; export `Blemish` (a lint violation the retry ladder exhausted on — board ships flagged) and `Violation` (one lint-rule hit: rule id, element ref, message) shapes for B8's `lint(draft) → Violation[]`. Append-extension by B8 is allowed; hand-editing the derivation is not.
- [x] 1.4 `src/board/index.ts` is the folder's only public seam; root `src/index.ts` re-exports it.
- [x] 1.5 Tests: a fixture board exercising every kind parses through `HostBoardSchema`; a draft fixture through `parseDraft`; **drift test 1** — fails if `DraftBoardSchema` stops being the derivation (e.g. kind-set comparison: Draft kinds === Host kinds minus the recorded omit set, computed from the schemas, not from a hand-kept list); **drift test 2** — Zod → whiteboard wire: compile the host schema through the kit and validate against the kit's wire shape, failing on any silent divergence.
- [x] 1.6 Cluster gate green. Commit.

## 2. manifests/ — ids as data; the temporary lens unions die

- [x] 2.1 Author `src/manifests/`: `LENS_KINDS`/`LensKind` moved verbatim from `packages/prompts/src/index.ts` (`design, sequence, decisions, flagged, noise` — display order, Design first; JSDoc intact); prompt ids as data (the five lens prompts + `report`, `post-process`, `review-draft-voice` — file paths/bytes stay in `prompts`); `CouncilJobId`/`CouncilJob` moved from `src/domain.ts`; the plan's job-id vocabulary added as data: `lens-draft`, `lens-draft-flagged`, `lens-draft-noise`, `board-post-process`, `round-report`, `partition-worker`, `map-verify`, `project-scout`, `related-context-retrieval` (council routing tables stay in `core` — B6/B7/B8 bind these).
- [x] 2.2 Re-point `packages/prompts` to the protocol `LensKind` (it already has the `protocol` edge); `LENS_PROMPT_FILES` keys off it; delete the local union.
- [ ] 2.3 Close the B2 drift note: delete the temporary unions in `packages/app-ui/src/canvas/counterpart.ts` (`CanvasAngle`/`CANVAS_ANGLES`) and re-point it and `packages/app-ui/src/app/shared.tsx` to protocol `LensKind` — the stale `"spec"` value becomes `"design"` (reconciliation 4); update `counterpart.test.ts` fixtures. No behavior change beyond the id rename.
- [ ] 2.4 Cluster gate green. Commit.

## 3. board/ — the LensBoard projection shape

- [ ] 3.1 Author the `LensBoard` Zod shape in `src/board/` (client asset risk 1 — the client must not invent it): lens identity (`LensKind`), generation stamp, board id, section list carrying fold grammar, gist, and the `delta: new|reworked` mark, element tree in the 13-kind vocabulary with stable element ids, skipped-hunk data. Compose it FROM the cluster-1 kind schemas and `manifests/` ids — re-modeling any kind inline is a defect. The command that returns it is B4/B10's business; B3 freezes the shape.
- [ ] 3.2 Test: a full fixture projection parses; a type/schema-level assertion that `LensBoard`'s element vocabulary is exactly the host kind set (drifts with cluster 1's drift test, not independently).
- [ ] 3.3 Cluster gate green. Commit.

## 4. commands/ — one registry table

- [ ] 4.1 Move the command surface out of `src/index.ts` into `src/commands/` (mechanical: the 64 `commandDefinitions` input/output schema blocks with their JSDoc, `parseCommandInput`/`parseCommandOutput`, `commandIdSchema`/`isCommandName`).
- [ ] 4.2 Rebuild the table as the #465 registry: `commands`, keyed by stable id, each row `{args, output, label, exposure: {ui, commandMenu, agent}, locus: "host" | "client"}`. Initialize: `args`/`output` = today's schemas; `label` = the command id (#465: tool name = command id = menu label); `exposure.agent = true` only for the v1 inventory ids that exist today (project add/list, session list/open, review open-target/start, settings read/write — map by inspection, do not invent missing commands); `exposure.ui = true`, `commandMenu = false` elsewhere; `locus: "host"` throughout. Delete the `commandDefinitions` export and migrate its consumers (`session/wire` `isCommandName`, `packages/server/src/projection.test.ts` iteration, any grep straggler) — no legacy alias.
- [ ] 4.3 Registry invariants test in `src/commands/`: ids unique; every row round-trips `parseCommandInput`/`parseCommandOutput`; every row carries `label`/`exposure`/`locus`; the absorbed id set matches a recorded snapshot of the 64 (a dropped command fails loudly).
- [ ] 4.4 Cluster gate green. Commit.

## 5. session/ — the durable-session shapes

- [ ] 5.1 Move `src/session.ts` → `src/session/wire.ts` (+ `session.test.ts` alongside), unchanged — the #376 transport layer is the session's wire contract (reconciliation 6). `src/session/index.ts` is the seam; root re-exports.
- [ ] 5.2 Author the #466/#457 shapes in `src/session/`: `Session` (durable root: owns harness cursor, threads, claim; a review attaches 1:0..1; no-target sessions upgrade in place), `Claim` (the underlying target — branch + its PR are one claimed thing; archive-only release), `Generation` (the boards for one review of one patchset; append-then-freeze), `RoundRecord` (`{asksDispatched, workerCommitRange, mintedPatchsetGeneration, boardGeneration, reportBoard}` — the rounds-ledger row, #462's #486 ripple), `HarnessCursor` (`{harnessSessionId, lastAssistantMessageAnchor, turnCount}` — the T3 cursor-resume shape), thread/anchor (`threadId`; anchor = code-ref or prose quote `{target, quote, offsetHint?}`; the ask specialization: intent, exit lane, provenance ref, lifecycle `staged|dispatched|addressed|retired|detached` — detached is visible, never dropped). Shapes only; the state machine, locks, and rework queue are B9.
- [ ] 5.3 Fixture-parse tests for each shape. Cluster gate green. Commit.

## 6. delta/ — patchset citations, dossier, span-read

- [ ] 6.1 Move into `src/delta/` from `src/domain.ts` (mechanical, JSDoc intact): the patchset/capture family (incl. `PatchsetSource`), the anchor family (`AnchorSide`, `AnchorSpan`, `ParsedAnchor`, `RenderedHunkOccurrence`), the knowledge family (`KnowledgeStatement` + its support types). Move `src/rsp.ts` and `src/bodies.ts` (+ tests) under `src/delta/` — they validate decomposition documents over the offered hunk set.
- [ ] 6.2 Declare the stable `HunkId` shape and the canonical `CodeRef` (`{patchsetId, path, side: base|head, startLine, endLine, symbol?}`) here; re-point `board/`'s `code_ref` kind and `session/`'s anchors to this one definition (intra-package import; each folder's seam still re-exports what it names).
- [ ] 6.3 Author `DossierItem` per #461 §8: `{id, tracker, title, state, body (bounded), acceptanceCriteria?, url, provenance, fetchedAt}` — deterministically serializable, freshness attached; drafters cite items by `id`.
- [ ] 6.4 Register the **patchset span-read command** in the `commands/` table (client asset risk 2): input = a `CodeRef`-shaped citation (patchset id, path, side, span), output = the cited lines with minimal context — hydrated from the captured patchset, never a working tree. The row ships unbound (dispatch binds in B4/B10; unknown-command on the wire until then — reconciliation 8). Classify its path fields as repo-relative in `packages/server/src/projection.test.ts`'s `PATH_FIELD_CLASSIFICATIONS` so the coverage guard stays green.
- [ ] 6.5 Fixture tests (dossier item round-trip; span-read input/output parse). Cluster gate green. Commit.

## 7. Root seam + docs (definition of done)

- [ ] 7.1 Reduce `src/index.ts` to the re-export seam: the five folder seams plus the explicitly parked residue (`domain.ts` remainder — project/settings/handoff/locus families awaiting B4–B11, with a header comment saying so; `public-schema.ts`; `sha256.ts`). No export the workspace consumes may vanish: `sh -c 'pnpm nx run-many -t typecheck -p rennet-server rennet-core rennet-adapters rennet-app-ui rennet-client'` is the proof.
- [ ] 7.2 Docs: `docs/developing/reference/protocol-compatibility.md` — the registry (`commands`) replaces `commandDefinitions` as the named single validation authority; name the five contract-folder seams. `docs/developing/reference/monorepo-map.md` — protocol row gains `@wboard/core`, description updated. `docs/developing/concepts/review-lenses.md` — lens vocabulary aligned to `LensKind` (Spec → Design, matching `lens-pipeline.md`/#474; reconciliation 4).
- [ ] 7.3 Re-grep `docs/` (excluding `docs/dist` and the plan doc) for `commandDefinitions`, `CanvasAngle`, lens-name vocabulary, and protocol-structure claims a reader would now find wrong; fix stragglers.
- [ ] 7.4 Cluster gate green. Commit.

## 8. Verification (packet)

- [ ] 8.1 `sh -c 'pnpm check'` green — exit 0 from the real target run, not a masked pipe status.
- [ ] 8.2 Positive control 1 (derivation drift): hand-edit the draft schema (or add a 14th kind to Host without the omit-set ripple) — drift test 1 MUST fail. Show the failure, revert, re-run green.
- [ ] 8.3 Positive control 2 (wire drift): change one kind attribute's type — drift test 2 MUST fail. Show the failure, revert, re-run green.
- [ ] 8.4 Track C gate evidence: `LensBoard`, the span-read command row, `parseDraft`, `commands`, and `LensKind` are all importable from `@rennet/protocol`'s root export (grep/typecheck evidence shown).
- [ ] 8.5 Drift-closure sweep: zero grep hits for `CanvasAngle`, `CANVAS_ANGLES`, and `commandDefinitions` in `packages/ apps/ scripts/ docs/` (excluding `docs/dist` and the archived/openspec record). Show the grep output.
- [ ] 8.6 Flip `b03` in `BUILD-STATUS.json` and output the completion sigil `<promise>B03-COMPLETE</promise>`.
