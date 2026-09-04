## 1. Delete the round gate (D1, D2)

- [x] 1.1 `packages/protocol/src/session/model.ts`: delete `RoundGateAttemptSchema`, the passed/failed/skipped/settled gate receipts, `RoundGatePlanSchema`, the `gatePlan` field on `RoundOperationSchema`, the `gate-running`/`gate-settled` phases and the `gate` field from every later phase, the `at: "gate"` failure arm and the `gate` field on the later failure arms, the gate arms of the progress schemas and `settledGateProgress`, the `{ type: "gate" }` round event, and `RoundRunGateReceiptSchema` with the `gate` field on `RoundRunReceiptSchema`
- [x] 1.2 `packages/server/src/runtime/round-execution.ts`: delete `planGate`/`runGate`/`observeGate` from `RoundExecutionPorts`, the private `runGate`, `gateFailureReason`, the `gate-running` and `gate-settled` drive arms and the `worker-settled` gate branch (so `worker-settled` plans the commit directly), the `gate` arm of `retryState` and `roundRetryMode`
- [x] 1.3 `packages/adapters/src/round-execution-effects.ts`: delete `runConfiguredRoundGate`, `RoundGateExecution`, `observedNxProjectCount`, and the now-unused `RoundProcessExec`/`execaRoundProcess`/`errorMessage` if nothing else uses them; drop the export from `index.ts`
- [x] 1.4 `packages/adapters/src/round-operation-store.ts`: bump `ROUND_OPERATION_STORE_VERSION` to 3 with the reason in its comment; delete `sameGateAttempt` and the gate transition arms; control: a version-2 row reads as `RoundOperationStoreLegacyError` and is dropped, not reported corrupt, and `listActive` keeps driving the other sessions
- [x] 1.5 `packages/server/src/create-server.ts`: delete `runRoundGate`, the gate ports on the coordinator, `gatePlan` from `createRoundOperation`, and the ledger's `gate` receipt; `planCommit` reads `worker-settled`
- [x] 1.6 `packages/app-ui/src/rounds/round-machine.ts`: delete `gateCommand`, `gateRow`, `settledGateRow`, the two gate phases and the `gate` failure arm and the `gate` event arm; `packages/app-ui/src/rounds/round-greeting.tsx`: delete `gateSummary` and its line; `packages/server/src/session/round-transcript.ts`: delete `gateLabel` and its clause from the Return row
- [x] 1.7 Control: delete the commit-observation call in the composition root and watch the round e2e redden, restore — proving the suite still sees a round that never observes its commits now that the phase before it is gone

## 2. The check becomes an instruction the worker follows (D3)

- [x] 2.1 `packages/core/src/handoff-compose.ts`: replace the `ROUND_COMMIT_RULE` constant with `roundCommitRule(checkCommand?: string)` returning the existing two lines plus, when a command is given, one line naming it — run it before committing, commit only when it passes, say why in the final message when it does not; truncate the command at a named byte bound with an honest marker; widen `HandoffGitRule` to `readonly string[]` and leave `HANDOFF_NO_GIT_RULE` and the review handoff untouched
- [x] 2.2 `create-server.ts`: pass the scout's `gateCommand` (the same read that built `gatePlan`) into `renderWorkOrder` and `renderComposedPrompt` for the round; nothing new is discovered or persisted
- [x] 2.3 Tests with controls: a work order for a repo with a known command carries the command once in the prompt and once in the file; a repo with none carries no check sentence and no placeholder; an over-long command is truncated with the marker; the review handoff's bundle is byte-identical to before
- [x] 2.4 Record the round prompt's size before and after for the PR description

## 3. A round is its own subagent thread (D4, D5)

- [x] 3.1 `packages/server/src/t3/threads.ts`: add `{ kind: "round"; sessionId; operationId }` to `ThreadBindingKey`, `"round"` to the row's `kind` enum with an `operationId` field, the `round` arm to `matches`, and a `roundThreadTitle(branch, roundNumber)` beside `seatThreadTitle`; the row carries `sessionId` so `findBindingsForSessions` already sweeps it
- [x] 3.2 `packages/server/src/t3/handoff.ts`: add `runRoundTurn` and `readRoundTurnCheckpoint` taking the round key, the bound `worktreePath`/`branch` and the title; the checkpoint read takes the last checkpoint at or after the attempt's start on that thread, with no prompt-text matching, because the thread holds only this round's turns
- [x] 3.3 `create-server.ts`: the round worker port binds the round thread with the bound root as `worktreePath`, the bound branch, the handoff's model selection, and the title `<branch> — round <n>`; the recovery port reads that thread's checkpoint; the round never reaches the session key
- [x] 3.4 `round-greeting.tsx`: the workspace-provenance line names the round's thread id beside the checkpoint, so the reviewer can open the transcript (found on the 2026-09-04 drive: the greeting rendered root, turn id and turn count and never the thread)
- [x] 3.5 Tests with controls: a round turn binds a `round` key with the bound `worktreePath` and never the `session` key, and the session thread is sent no turn; two rounds on one session bind two threads; archiving a session with two landed rounds deletes both round threads; a dom test asserts the greeting names the thread id

## 4. The receipt is honest after a commit (D6, issue #811)

- [x] 4.1 `t3/handoff.ts`: the checkpoint handle no longer depends on the diff read succeeding. T3 writes a turn's checkpoint on its own reactor after the turn's lifecycle settles, so the diff read is given a bounded wait for the checkpoint to appear, and a settled turn records `{ threadId, turnId, turnCount }` from the checkpoint the wait found. A turn that genuinely left none still records none
- [x] 4.2 `create-server.ts`: one helper reconciles a worker receipt against the bound root's `sourceHead..HEAD` — when the receipt's diff is blank and the range is non-empty, its `diff` and `changedPaths` come from that range; applied to both the live worker outcome and the recovery read. A turn that edited without committing keeps its checkpoint diff and still fails
- [x] 4.3 Tests with controls: a committing worker whose checkpoint diff is empty yields a receipt naming the committed files and a round that completes; an editing-but-not-committing worker keeps the working-tree diff and fails with the uncommitted-work reason; a settled turn whose checkpoint appears only after the lifecycle settles still records its checkpoint; positive control — make the reconciliation a no-op and watch the first test redden
- [x] 4.4 Close issue #811 with the change

## 5. The owner-loop proof is rebuilt for the new shape

- [x] 5.1 `packages/server/src/owner-loop-proof.integration.test.ts`: the fake round worker runs on its own fake thread — it receives the round's thread identity and records it — and the proof asserts the round's thread is a `round` key, that the session's thread received no round turn, and that the ledger rows carry no gate facts
- [x] 5.2 The proof's round-one and round-two assertions drop `run.gate` and gain the round thread and the committed-file receipt
- [x] 5.3 Run the proof with `ASDF_DATA_DIR=/Users/rai/.asdf`

## 6. Docs, in the same change

- [x] 6.1 `docs/developing/concepts/handoff-and-exits.md`: the round's steps, the restart story, the durable receipt and the run receipt lose the gate; the round's own thread is named
- [x] 6.2 `docs/developing/concepts/t3code-sidecar.md`: the round thread kind beside the session and seat kinds
- [x] 6.3 `docs/developing/concepts/architecture-contracts.md`: a round advances the patchset from the bound root and Rennet runs no check of its own
- [x] 6.4 `docs/using/guides/getting-started.md`: the round narration and the run receipt say the worker runs the project's check
