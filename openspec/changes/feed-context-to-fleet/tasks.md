# Tasks — feed-context-to-fleet

Gate for every wave: `NX_DAEMON=false pnpm check` (format, architecture, licenses, lint, typecheck, test, build). Every wave starts with a RED proof — a failing test that pins the behaviour — before the code that turns it green. Any field crossing IPC MUST be declared in `@rennet/protocol` Zod (the strict command outputs silently strip undeclared fields).

## 1. types + protocol — the send-record shape crosses IPC intact

- [ ] 1.1 RED: protocol test proving a `ContextManifest` with a `sends` array round-trips through `contextManifestSchema` unstripped (fails today: field unknown) and that a manifest WITHOUT `sends` still parses (back-compat pin).
- [ ] 1.2 `packages/types`: add `ContextSendRecord` (`seat`, `harness`, `channel: "prompt" | "system-append"`, `attempt`, `promptBytes`, `promptDigest`, `contextIncluded`, `contextDigest?`, `sentAt`) and optional `ContextManifest.sends`.
- [ ] 1.3 `packages/protocol`: `contextSendRecordSchema` + optional `sends` on `contextManifestSchema`. Green 1.1.

## 2. core — the context layer is fed, and the wire records the send

- [ ] 2.1 RED: per-runner golden tests — with `assembledContext` supplied the assembled prompt contains the labelled `<<<rennet:layer context>>>` block byte-identical to the supplied text; with it absent the prompt is BYTE-IDENTICAL to today's golden (the no-gate invariant). Cover: `angle-generation`, `ordering-pass`, `finding-generation`, `noise-generation`, `decision-generation`, `hypothesis-generation`, `rollup-narration`.
- [ ] 2.2 Add optional `assembledContext?: string` to each runner input; map to the `context` layer at each existing `assemblePrompt` call site. Green 2.1.
- [ ] 2.3 RED: `pipeline.test.ts` — `buildReviewCanvases({ assembledContext })` threads the same text to the hypothesis, decomposition, ordering, and narration turns (assert via a capturing mock `runTurn`); absent → prompts unchanged. `dual-finding-review.test.ts` — both seats receive the identical layer.
- [ ] 2.4 `pipeline.ts`: `ReviewPipelineInput.assembledContext` threaded to the four seats; `dual-finding-review.ts` threads to both seats (same shape as `guidance`). Green 2.3.
- [ ] 2.5 RED: `harness-run-turn.test.ts` — `recordSeatSend(runTurn, meta, sink)` stamps `{promptBytes, promptDigest}` over the exact sent string; parse-back extracts the labelled context block and stamps `contextIncluded`/`contextDigest` from the SENT bytes (a prompt without the block → `contextIncluded: false` even when the caller supplied context); each attempt stamps its own record; a throwing inner turn still records before propagating to `guardSeatTurn`.
- [ ] 2.6 Implement `recordSeatSend` (+ the exact-delimiter context-block extractor) in `packages/core/src/harness-run-turn.ts`; document composition order `guardSeatTurn(recordSeatSend(...))`. Green 2.5.

## 3. adapters — the captured text feeds the send; the manifest becomes the transcript

- [ ] 3.1 RED: `context-manifest-store.test.ts` — text persisted beside the JSON (`<baseOid>.context.txt`); load verifies `sha256(text) === manifest.assembledPromptDigest`; mismatch/missing reads as absence; `appendSends` appends atomically, tolerates a pre-`sends` manifest, and a malformed file reads as absence (never a throw).
- [ ] 3.2 `ContextManifestStore`: `saveText`/`loadVerified`/`appendSends`; `captureReviewContextManifest` writes text in the same capture. Green 3.1.
- [ ] 3.3 RED: `live-review-backend.test.ts` — `ensureReviewContextAssembly` serves persisted `{manifest, text}` when digest-verified; rebuilds AND re-persists both on mismatch/missing text; returns `undefined` on honest absence (no snapshot) without throwing.
- [ ] 3.4 Implement `ensureReviewContextAssembly` in `live-review-backend.ts` over the one producer `buildReviewContextManifest` (no re-implementation of assembly or manifest). Green 3.3.
- [ ] 3.5 RED: `orchestrator-turn.test.ts` — with `assembledContext` supplied the SDK `systemPrompt.append` is primer + labelled context block (assert via injected fake `query`); a `channel: "system-append"` send record is stamped over the exact append string; absent → append is primer-only, byte-identical to today.
- [ ] 3.6 `orchestrator-turn.ts`: `OrchestratorTurnDeps.assembledContext?` + `onSend?` sink; compose the append; stamp the record. Green 3.5.

## 4. apps/desktop — the composition root closes the loop

- [ ] 4.1 RED: desktop main test — `buildCanvasesForReview` feeds the ensured assembly text into the pipeline input, and the finding (both seats), noise, decisions, and hypothesis call sites; with the store empty/failed every turn runs with today's byte-identical prompt (no gate); after a run, `sends` records for each executed seat are appended to the persisted manifest and a persistence failure only hits the error sink.
- [ ] 4.2 Wire it: call `ensureReviewContextAssembly` once per run; thread `assembledContext`; wrap each seat's turn as `guardSeatTurn(recordSeatSend(...))` with an in-memory sink; `appendSends` once per completed run. Thread `assembledContext` + sink into `createOrchestratorTurnRunner` (`orchestrator.ts`). Green 4.1.

## 5. ui — the label follows the evidence

- [ ] 5.1 RED: `context-manifest-panel.dom.test.tsx` — a manifest with a proven send (`contextIncluded && contextDigest === assembledPromptDigest`) renders "Context sent to the fleet" plus the per-agent send list (seat, harness, attempt, bytes, inclusion, digest match); no records (or none proving inclusion) renders "Context Rennet assembled" unchanged; `exhaustive: false` + `unmanagedSources` render in BOTH states.
- [ ] 5.2 Implement the panel's send-transcript section + evidence-scoped label. Green 5.1.

## 6. Full gate + positive control

- [ ] 6.1 `NX_DAEMON=false pnpm check` clean across the workspace.
- [ ] 6.2 Positive control (a clean check must be able to fail): temporarily flip one send-record assertion (e.g. expect `contextIncluded: false` where a fed prompt is asserted) and watch the suite fail; revert.
- [ ] 6.3 Live dogfood on a Rennet-repo review (never a client repo): open a review, run the fleet, verify in the panel that the sent digests match `assembledPromptDigest` per seat and that the transcript reloads after an app restart.
