## Why

The first real coding round on v0.7.0 failed at a step Rennet had no business running. The worker did its job — it committed `fe2520976` on the bound branch in the bound worktree — and then Rennet ran the repository's own configured check (`npm run check`, 14 projects, six and a half minutes) in that worktree, got exit 1, and stored the exit code and nothing else. No stdout, no stderr, no failing project name, nowhere a reader could look. A reviewer waiting for a round got a six-minute pause and the word "failed". Rai's ruling, 2026-09-04: *"rennet shouldn't be running the gate anyway, lets remove that feature. just tell the round worker / orchestrator to run that feature. also… we should hand off the round to a subagent not to the main orchestrator."*

Two more things that round exposed. The worker receipt carried `diff: ""` and `changedPaths: []` while the commit plainly existed, because the sidecar checkpoint diffs the WORKING TREE and a worker that commits leaves it clean — so the coordinator's own agreement check was one step from calling a correctly-committing round "changed 0 files". And the round ran as a turn on the session's chat thread, the same transcript the reviewer talks to Rennet in, so a coding agent's tool calls and a reviewer's conversation share one scroll.

## What Changes

- **BREAKING: Rennet no longer runs a gate.** The `gate-running` and `gate-settled` phases, the gate ports on the round execution coordinator, the durable gate receipt, the ledger's gate facts, the client's gate row and the `gate` failure arm are deleted. The round's durable store version is bumped; rows written by the old machine are DROPPED as legacy with a logged reason, exactly as the previous bump did, rather than read as corruption that wedges the session.
- **The check becomes an instruction, not an action.** The project scout's `gateCommand` offer survives as an INPUT to the work order: when a command is known, the round's prompt and `work-order.md` tell the worker to run it before committing, commit only when it passes, and say why in its final message if it does not. When no command is known the sentence is omitted, never templated empty.
- **BREAKING: a round is its own subagent thread.** Each dispatch binds a NEW sidecar thread keyed on the round — `(session, operation)`, never the session key — titled for its branch and round number, created with the session's bound workspace as its worktree and the same model selection the handoff uses. The round's work order is one turn on that thread, its checkpoint is read straight off it, and the thread id is recorded on the round account and shown in the greeting so the reviewer can open the transcript. The session's chat and handoff thread is never sent a round turn again. Archiving the session deletes the round threads with the rest.
- **The receipt is honest after a commit.** When the checkpoint's working-tree diff is empty and the bound root's `sourceHead..HEAD` carries commits, the worker receipt's `diff` and `changedPaths` are re-derived from that commit range. A turn that edited without committing keeps the checkpoint diff and still fails, with the reason it already had.
- Documentation that says Rennet runs a gate — `handoff-and-exits.md`, `t3code-sidecar.md`, `architecture-contracts.md`, the rounds material in `docs/using/guides/getting-started.md` — is rewritten to say the worker runs it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `review-round-loop`: a round's steps are prepare, turn, observe commits, regenerate — there is no gate step, and the loop's depth guarantee is restated without one.
- `round-harness-dispatch`: the round's harness provenance carries the thread the round ran on; the dispatch scenarios no longer name a gate step.
- `session-bound-workspace`: the coding round is a turn on its OWN thread in the bound workspace, and Rennet SHALL NOT execute the repository's configured check on the reviewer's behalf.
- `t3code-sidecar`: a round thread is a distinct thread kind bound to `(session, operation)`; the session's chat thread receives no round turn; the round's checkpoint is read from its own thread.
- `handoff-bundle-composition`: the round's work order carries the check instruction when a command is known.

## Impact

- `packages/protocol/src/session/model.ts`: the gate schemas, `gatePlan`, the gate phases and failure arm, the gate progress projection, the `gate` round event, `RoundRunReceipt.gate`; `RoundCheckpoint`/round account gain nothing new — the thread id is already on the checkpoint.
- `packages/server/src/runtime/round-execution.ts`: the gate ports, `runGate`, the two gate phases and the `gate` retry/failure arms.
- `packages/server/src/create-server.ts`: the gate port wiring, the gate plan built at dispatch, the ledger's gate receipt; the round worker binds a round thread; the worker receipt's commit-range re-derivation.
- `packages/server/src/t3/{handoff,threads}.ts`: the round thread kind and its binding; a round turn and a round checkpoint read.
- `packages/adapters/src/round-execution-effects.ts`: `runConfiguredRoundGate`, `RoundGateExecution` and the Nx project-count parser are deleted; `packages/adapters/src/round-operation-store.ts` bumps its version and drops the gate transitions.
- `packages/core/src/handoff-compose.ts`: the round's rule block takes an optional check command, bounded.
- `packages/app-ui/src/rounds/{round-machine,round-greeting}.tsx`: the gate row and gate summary go; the greeting names the round thread.
- `packages/server/src/session/round-transcript.ts`: the return row's gate clause.
- Docs: `docs/developing/concepts/{handoff-and-exits,t3code-sidecar,architecture-contracts}.md`, `docs/using/guides/getting-started.md`.
- Data: round-operation rows written before this change are dropped on read; the rounds ledger keeps its rows, and a legacy row's stored gate facts are simply no longer read.
