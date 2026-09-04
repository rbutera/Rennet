## Context

See `proposal.md` for why. This change follows `session-bound-workspace`, which is still open; it takes that change's world as its starting state and does not archive it.

The state this design starts from, measured on 2026-09-04 against `origin/main` at `65730876f`:

- The round's durable state machine is `packages/server/src/runtime/round-execution.ts`: `claimed → prepared → worker-running → worker-settled → gate-running → gate-settled → committing → commits-settled → round-recording → round-recorded → report-drafting → report-verifying → completed`. Two of those phases and three of the ten effect ports (`planGate`, `runGate`, `observeGate`) exist only to run the repository's own check command.
- `runConfiguredRoundGate` in `packages/adapters/src/round-execution-effects.ts` shells `sh -lc <command>` in the bound root, parses an Nx project count out of the output, and returns pass/fail. Its stdout and stderr reach `RoundGateExecution` and are then dropped: the durable `RoundGateReceipt` carries only `exitCode`/`termination`. That is why the failing round of 2026-09-04 left no readable evidence.
- `RoundGatePlanSchema` rides every durable operation (`gatePlan`), built at dispatch from `scoutSettingsOffers(...).gateCommand`. `RoundRunReceipt.gate` is a required field on every rounds-ledger row. `RoundOperationProgressSnapshot` carries the plan and a gate lane, and `round-machine.ts` renders a gate row from it.
- The round's turn is `createRoundWorkerPort` → `runHandoffTurn` (`packages/server/src/t3/handoff.ts`), which binds `{ kind: "session", sessionId: reviewId }` on the bound root. The chat dock and `review.handoff.run` bind the same key on the same root, so all three land on one thread. `readHandoffTurnCheckpoint` compensates with prompt-text matching plus a `since` guard, and its own comment names the window that pair does not close.
- `bindThread` (`packages/server/src/t3/threads.ts`) already takes `worktreePath`, `branch`, `modelSelection` and an optional owning `sessionId`, single-flights per key, retires a superseded row, and refuses a bound workspace that is gone. `findBindingsForSessions` sweeps every row carrying a session id, and `session.archive` calls it with `[sessionId, reviewId]`.
- `observeRoundCommits` already resolves `sourceHead`, `HEAD` and the count of `sourceHead..HEAD` in the bound root.
- `ROUND_OPERATION_STORE_VERSION` is 2, bumped by `session-bound-workspace`, with `RoundOperationStoreLegacyError` dropping strictly-older rows with a logged reason instead of wedging the session.
- Constraints: Rule Zero; token discipline (a change that grows what a turn sends states its size); `effect`/`@t3tools` stay behind `t3/client.ts`; the documentation obligation is part of done.

## Goals / Non-Goals

**Goals**

- Rennet starts no process of its own between a round's turn and its commit observation.
- A round's transcript is its own, openable, and swept with the session.
- A worker that commits is described by its receipt as having committed.
- The round's prompt grows by at most one sentence, and only when there is a command to name.

**Non-Goals**

- Changing the scout's discovery of the check command, its settings surface, or the wording of the offer. It stays exactly as it is; only its consumer changes.
- Changing how the successor patchset is captured, or the immutable-patchset contract.
- Changing the review handoff's own turn, thread or rule block.
- Adding any retry, verification or reporting of the worker's check. The worker's final message is the report.
- Editing the vendored sidecar. Everything needed already exists on `bindThread`.

## Decisions

**D1. The gate is deleted, not disabled.** The phases, ports, schemas, receipts, rows and failure arm go. A feature flag or a "gate: none" plan would leave the machine and the reader's confusion in place; the ruling was to remove the feature. `worker-settled` transitions straight to `committing`, so the state machine loses two phases and the failure union loses one arm. Alternative considered: keep the plan field and always render `absent`; rejected because the durable shape is what the next reader believes.

**D2. Old rows are dropped, as legacy.** `ROUND_OPERATION_STORE_VERSION` goes to 3. A version-2 row describes a machine with gate phases that this build cannot decode or resume, so `RoundOperationStoreLegacyError` drops it with a logged reason and the session dispatches fresh. The visible cost, accepted and identical to the last bump: a retained completed round from before the change disappears from the client's live account; the rounds-ledger row, a separate store, stays. The ledger's `RoundRunReceipt.gate` field is removed from the schema, and Zod's default object behaviour strips the key from a row that still carries it — an old ledger row keeps reading, minus a fact nothing displays.

**D3. The check is a sentence in the work order, bounded at its call site.** `ROUND_COMMIT_RULE` becomes `roundCommitRule(checkCommand?: string)`, returning the existing two lines plus, when a command is given, one more naming it. The command is truncated at 200 bytes with a `…` marker — an unbounded interpolation is a bug, and a scout-discovered command is user data. Absent command ⇒ the extra line is not emitted at all, so a repository with no check reads exactly as it does today. `HandoffGitRule` widens from a two-literal union to `readonly string[]`; the review handoff keeps `HANDOFF_NO_GIT_RULE` verbatim and is untouched. The command reaches `createRoundOperation` from the same `scoutSettingsOffers(...).gateCommand` read that built `gatePlan`, so nothing new is discovered or stored.

**D4. A round thread is a third binding kind.** `ThreadBindingKey` gains `{ kind: "round"; sessionId; operationId }`. The key is the OPERATION, not the dispatch or the round number: the operation id is what survives a restart, what the coordinator resumes, and what a rerun replaces — so a resumed round rebinds to its own thread and a re-dispatch gets a new one. The row carries `sessionId` in the same field seat rows use, so `findBindingsForSessions` sweeps it with no change to the archive path. Title: `<branch> — round <n>`, in the shape `seatThreadTitle` already uses. `worktreePath` is the bound root and `branch` the bound branch, exactly as the handoff passes them.

Alternative considered: key on the dispatch id. Rejected because a dispatch can be coalesced into a rerun of a live operation and would then name a thread nothing runs on.

**D5. The round turn and the round checkpoint read are their own functions.** `runHandoffTurn` keeps the session key and stays the review handoff's. `runRoundTurn` and `readRoundTurnCheckpoint` take the round key. They are near-identical to the handoff pair by construction, and the checkpoint read is SIMPLER: on a thread that only ever holds this round's turns, the last checkpoint at or after the attempt's `startedAt` is this round's, and the prompt-text matching that guarded a shared thread is deleted with the sharing. The `since` guard stays, because a rerun of the same operation reuses the thread.

**D6. The receipt is reconciled at the worker boundary, in one place.** After the turn settles — and after a recovery read — if the receipt's diff is blank and `sourceHead..HEAD` in the bound root is non-empty, the receipt's `diff` and `changedPaths` are replaced by that range's `git diff` and name-only list. One helper, applied to both the live port's outcome and the recovery port's, in the composition root where `gitForRepo` already lives. No new coordinator port: the coordinator's agreement check then sees two consistent facts and the `uncommittedWorkReason` family narrows to the case it was written for — a turn that edited and did not commit.

Alternative considered: do it in the coordinator at `committing`, where the commit receipt already exists. Rejected because the worker receipt is persisted at `worker-settled` and a reader of that durable row would see the empty diff until the next phase, which is exactly the lie.

**D7. The greeting names the thread.** `RoundCheckpoint` already carries `threadId`; the greeting's workspace-provenance line adds it. Nothing new is stored.

## Risks / Trade-offs

- [The worker skips the check and commits anyway] → accepted, and it is the point. A capable agent is the product; the instruction is an instruction. The reviewer sees the commits and the final message and judges.
- [A round's transcript is no longer in the chat thread the reviewer was reading] → the greeting names the round's thread and the checkpoint reference opens it. The previous arrangement mixed a coding agent's tool calls into the reviewer's conversation, which is worse.
- [Round threads accumulate, one per round, per session] → they are swept by the archive path that already sweeps seat threads, which are also one per seat per generation. A session with five rounds holds five more rows than before; a session with none holds the same as before.
- [A version-2 round row is dropped and a live round disappears from the client] → the same accepted cost as the previous bump, and the same reason: nothing can decode the row, so keeping it only makes the next dispatch collide with something unreadable.
- [The commit-range re-derivation makes a receipt that disagrees with the checkpoint] → it is applied ONLY when the checkpoint diff is blank, which is precisely the case where the checkpoint has nothing to disagree with. A turn that edited without committing keeps its checkpoint diff untouched and still fails.
- [The check sentence grows every round prompt] → one line, bounded, and only when a command exists. Measured before and after in the pull request.

## Migration Plan

1. Land the gate deletion, the check sentence and the receipt reconciliation together — they are one behaviour, and the receipt fix is what makes a gate-free round settle honestly. On first start, version-2 round rows drop with a logged reason.
2. Land the round thread. Sessions with a live round at upgrade have already had their row dropped by step 1, so nothing resumes onto a session thread.
3. Rollback is per wave by revert; no data migration is written that a revert cannot ignore.

## Open Questions

- Whether the round's thread should be offered directly in the client's round surface as a link rather than as a checkpoint reference the reviewer resolves. Either answer fits the specs; the surface work is not blocked by them.
