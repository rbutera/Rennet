# Handoff loop (#18) — build STATE

Branch: `feat/handoff-loop` (worktree `rennet-wt-handoff`). Owner: handoff agent.
Coordination note for the `feat/lineage-matcher` agent (#16) and the lead.

## What #18 is

The review→agent handoff loop (Contracts §2.1, destination B "your own branch"):
**bundle → run → capture → delta re-review.** Batch the open dispositions into a
task bundle, hand it to a coding harness in a WRITE-enabled session, capture the
result as a NEW immutable patchset, and re-review only the delta.

## The four parts and how they map onto existing machinery

| Part | Where | Status |
|---|---|---|
| **Bundle** | `packages/core/src/handoff-loop.ts` `buildHandoffBundle` (pure) | building |
| **Run** (write-enabled turn) | core `HandoffRunPort` (injected) + adapters live port over `ClaudeAdapter` `readOnly:false` | building |
| **Checkpoint** (bracket + turn diff) | `packages/adapters/src/checkpoint-store.ts` (hidden `refs/rennet/checkpoints/*`, vendored from T3 Code) | building |
| **Capture** (new patchset) | REUSES `ReviewService.capture`/`PatchsetActivated` fold + `GitCaptureAdapter` — a new patchset is appended, the prior stays byte-identical (R28) | reuse |
| **Delta carry (floor)** | REUSES `carryDispositions` in `foldReview(PatchsetActivated)` — byte-identical anchors keep their dispositions | reuse |
| **Delta carry (move/split/merge)** | **#16 SEAM** — `LineageCarryPort` in `handoff-loop.ts`, explicitly UNIMPLEMENTED | seam |

## The #16 seam — where the lineage matcher drops in

The delta re-review works TODAY at the **floor**: `foldReview(PatchsetActivated)` runs
`carryDispositions`, which carries a disposition only where the successor file is
byte-identical (path- or span-grained). Moved/renamed/split code fails closed and is
re-reviewed. Totality still holds — the new patchset captures the WHOLE working-tree
diff, so every changed file appears.

The #16 calibrated matcher UPGRADES that floor to carry approvals through moves. I have
defined a typed boundary and left it explicitly unimplemented, NOT a plausible stub:

- `core/src/handoff-loop.ts` exports `LineageCarryPort` (interface) + `LINEAGE_MATCHER_NOT_WIRED` +
  `notWiredLineageCarry()` (returns `{ status: "matcher-not-wired" }`, never a fabricated carry).
- `runHandoff` accepts an optional `lineageCarry?: LineageCarryPort`. Absent ⇒ the floor
  carry (existing, real) is what runs; the delta is honest and complete, just conservative.
- When #16 lands, wire its matcher as a `LineageCarryPort` here. It maps prior-patchset
  occurrence ids forward (`LineageEntry[]`, already in `@rennet/types`) and returns the
  additional dispositions to carry beyond the byte-identical floor.

**What the seam needs from #16:** given `(previousDispositions, previousPatchset, nextPatchset)`,
return the extra dispositions to carry where lineage is `exact`/`one-to-one`/`move` and
NOT `ambiguous` (ambiguity fails closed, R8/§3.3). I did NOT invent the matcher or touch
`partitionCarry`/`DispositionRelevanceJudge` (your carry seam). If the shapes need to
differ, message me — the boundary is one small interface, changed additively.

## Overlap with `feat/lineage-matcher`

You touch `packages/types`, `packages/protocol`, the carry seam. I ADD, additively:
- `types`: a handoff section appended at END of `index.ts` (wire shapes only) — trivial merge.
- `protocol`: 3 new command defs (`review.handoff.prepare/requestConsent/run`) appended.
- I did NOT modify `partitionCarry`, `carryDispositions`, `DispositionRelevanceJudge`,
  `LineageEntry`, or any existing lineage type. My seam is a NEW interface in core.

## Invariants (asserted by test)

- ⛔ Startable ONLY by an explicit user act — `run` refuses without a single-use consent
  token minted by `requestConsent` (main-owned `HandoffConsentAuthority`). No scheduler/
  reactor path calls `runHandoff`. Test: run without token ⇒ refused.
- ⛔ Spend disclosed before the write session — `prepare` returns a `HandoffDisclosure`
  (harness, model, task count, write-enabled, will-edit-working-tree); `run` binds the
  consent token to the exact bundle digest, so the session cannot run on an undisclosed
  bundle. Test: token bound to bundle A cannot run bundle B.
- ⛔ Active patchset byte-identical before/after — the pre-handoff patchset object is
  unchanged in `review.patchsets` after capture (event-sourced append, never rewrite).
- ⛔ Nothing pushed — the write session's tool set is Read/Grep/Glob/LS/Write/Edit/
  MultiEdit, **NO Bash/exec**, so `git push` is structurally unreachable (R33). Capture
  never pushes. (Follow-up: a sandboxed exec policy for tests/formatters.)
- **Totality** — an agent edit unrelated to any disposition still appears in the new
  patchset (whole-tree capture) and the turn diff. Test asserts it.

## Files (planned)

- `packages/types/src/index.ts` (append): HandoffDisposition, HandoffTask, HandoffBundle,
  HandoffDisclosure, HandoffRunResult.
- `packages/core/src/handoff-loop.ts` (new): buildHandoffBundle, disclosureFor,
  HandoffRunPort, LineageCarryPort seam, runHandoff.
- `packages/adapters/src/checkpoint-store.ts` (new): CheckpointStore (hidden git refs).
- `packages/adapters/src/handoff-run-live.ts` (new): write-enabled ClaudeAdapter run port.
- `packages/protocol/src/index.ts` (append): 3 command defs + schemas.
- `apps/desktop/src/main/handoff-consent-authority.ts` (new) + `dispatch.ts` (3 cases).

## What shipped (all committed on `feat/handoff-loop`)

- **Bundle** — `core/src/handoff-loop.ts` `buildHandoffBundle` + `renderHandoffPrompt` +
  `disclosureFor`. Filters to request-change/comment, resolves anchors to hunk/file
  context, deterministic digest. 18 tests.
- **Checkpoint** — `adapters/src/checkpoint-store.ts` `GitCheckpointStore` (hidden
  `refs/rennet/checkpoints/*`, temp-index snapshot, tree-to-tree turn diff). Vendored
  T3 pattern, attributed. 6 real-git tests incl. "real index untouched" + "hidden refs".
- **Run** — `core` `runHandoffTurn` (pure bracket over injected `CheckpointPort` +
  `HandoffRunPort`) + `adapters/src/handoff-run-live.ts` `claudeHandoffRunPort`
  (readOnly:false, exec DENIED so `git push` is unreachable). 5 tests.
- **Capture + delta** — reuses `ReviewService.capture`/`PatchsetActivated` (floor carry).
- **Seam (#16)** — `LineageCarryPort` + `notWiredLineageCarry` (honest `matcher-not-wired`).
- **Protocol** — `review.handoff.prepare` / `requestConsent` / `run` + schemas.
- **Consent** — `apps/desktop/src/main/handoff-consent-authority.ts` (single-use token
  bound to reviewId+bundleDigest); `dispatch.ts` 3 cases; composed in `index.ts`.
- **Adapter change** — `SessionSpec.disallowedTools` (additive) threaded through
  `claude-adapter.ts` so a write session can deny exec.

Invariants asserted (6 dispatch tests): explicit-act (refuse w/o token), spend-disclosed
(refuse on digest drift), R28 immutability (prior patchset preserved), totality
(unrelated edit in filesTouched), unavailable (no harness), single-use token.

## Wiring #16 when it merges

Replace `lineageCarry: "matcher-not-wired"` in `dispatch.ts` run case + pass a real
`LineageCarryPort` (over #16's matcher) into a delta-carry step after `service.capture`.
The matcher is DONE on `feat/lineage-matcher` (their tasks #15-17 complete) but not on
this branch's base — so the seam stays honestly unwired here.

## Gate

Full `NX_DAEMON=false pnpm check` — see the run report; new tests reconcile against the
2031/7 baseline.
