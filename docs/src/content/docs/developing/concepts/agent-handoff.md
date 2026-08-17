---
title: Agent handoff
description: How review requests become one coding-agent work order, a new patchset, and a focused delta review.
---

Agent handoff is the author-side loop: collect the changes you want, hand them to
the coding harness, capture what it edits, then review only the resulting delta.
The whole loop is reachable in the app as of
[#72](https://github.com/rbutera/rennet/issues/72);
[#73](https://github.com/rbutera/rennet/issues/73) added the hunk-grain delta
account.

Read [delta re-review and lineage](/developing/concepts/delta-rereview-and-lineage/)
and [the canvas model](/developing/concepts/canvas-model/) first.

An own-branch review with an actionable disposition offers a "Hand off to agent"
path alongside the PR-submission sign path. It opens a handoff paper that composes
the bundle, previews it, and runs it. Signing your own-branch paper still pushes
the branch and opens the pull request; the handoff is the other action off the
same own-branch destination.

## The loop

```mermaid
flowchart TD
  review["Review the current patchset"] --> dispose["Stage comments and requested changes"]
  dispose --> compose["Compose one handoff bundle"]
  compose --> checkpoint["Checkpoint the working tree"]
  checkpoint --> agent["Run one capable coding-agent turn"]
  agent --> diff["Capture the turn diff"]
  diff --> successor["Create a successor patchset"]
  successor --> account["Build the delta account"]
  account --> rereview["Re-review what changed"]
  rereview --> paper["Sign the PR submission"]
```

The machinery lives behind typed main-process commands: the mechanical bundle,
write-enabled runner, workspace checkpoints, successor capture, exact carry, delta
account, optional digest, and PR submission. `review.handoff.run` accepts and
executes the exact composed bundle `review.handoff.compose` produced, bound by its
digest; it does not rebuild a mechanical bundle from the raw dispositions. A pure
stage-6 preview view-model (`handoffPreview`) and paper component render that
composed bundle before it runs. The own-branch destination composes on surface
entry, previews via `HandoffPaper`, and runs the exact previewed bundle from one
action.

## From dispositions to a work order

The source material is the draft the reviewer already shaped. `request-change`
and actionable `comment` [dispositions](/developing/concepts/canvas-model/) become
tasks. Approvals mean “leave this
alone,” while questions stay in the review conversation, so neither becomes an
edit instruction. A `comment` with a blank effective body is not actionable
either — a neutral mark-read carries no instruction, so it never becomes a task
and never lights the handoff affordance.

The mechanical bundle contains:

- the active review and patchset identities;
- one task per addressed disposition;
- the file and line range, when there is one;
- bounded diff context around that anchor;
- the exact instruction body;
- a stable digest of the ordered tasks.

`buildHandoffBundle()` in `packages/core/src/handoff-loop.ts` owns this plain,
deterministic shape. The separate `review.handoff.compose` command merges related
asks, chooses a useful order, and adds a short narrative without changing which
asks are in the bundle. Its output IS the input to the acting turn: `review.handoff.run`
runs the composed bundle's ordered, verbatim prompt.

```mermaid
flowchart LR
  dispositions["Staged dispositions"] --> filter{"Actionable edit?"}
  filter -->|request change or comment| task["Anchored task"]
  filter -->|approve or question| local["Keep in review"]
  task --> bundle["Mechanical bundle"]
  bundle --> composer["Composed work order command"]
  composer --> turn["Acting turn<br/>runs the composed bundle"]
```

The mechanical partition remains the authority. Composition may make the work
order easier to follow, but it may not invent a task or lose one.

## The acting turn

When invoked, `review.handoff.run` first checks the composed bundle's integrity.
It refuses to run unless the bundle's digest and prompt recompute from its tasks
and it was composed against the active patchset. Once that holds, it checkpoints
the working tree and starts one Claude Code session in the repository root running
the composed prompt. The session has the harness's full default tool surface,
including shell access. That lets the agent edit, inspect, format, and test the
work it just changed.

Rennet's prompt asks the agent to stay on the listed work and leave commit and
push to the later PR-submission step. This is instruction, not a reduced
capability profile. The product does not add its own tool denylist.

```mermaid
sequenceDiagram
  participant Main as Desktop main
  participant Store as Checkpoint store
  participant Claude as Claude Code
  participant Review as Review service

  Main->>Store: Save pre-turn checkpoint
  Main->>Claude: Send mechanical work order
  Claude->>Claude: Edit files and run checks
  Claude-->>Main: Final text and usage
  Main->>Store: Capture post-turn state and turn diff
  Main->>Review: Capture a new immutable patchset
  Review-->>Main: Successor review plus carry results
```

A failed turn stays a failed turn. If it changed files before failing, those
files are reported instead of being hidden behind the error.

Repositories containing submodules are currently refused on this path. An edit
inside a child repository can leave the superproject gitlink unchanged, which
would make the checkpoint diff incomplete. Recursive submodule checkpoints are
the missing implementation; the refusal is an honest visibility limit, not a
reduced coding-agent capability.

## How checkpoints isolate one turn

`GitCheckpointStore` snapshots tracked, deleted, and non-ignored untracked files
with a temporary Git index. It writes each snapshot to a hidden
`refs/rennet/checkpoints/*` ref without moving `HEAD`, changing a branch, touching
the user's real index, or creating a reflog entry. The two trees bracket the
agent turn.

```mermaid
sequenceDiagram
  participant Tree as Working tree
  participant Temp as Temporary Git index
  participant Ref as Hidden checkpoint refs
  participant Agent as Coding agent

  Tree->>Temp: add -A before the turn
  Temp->>Ref: write pre-turn tree
  Agent->>Tree: edit files and run checks
  Tree->>Temp: add -A after success or failure
  Temp->>Ref: write post-turn tree
  Ref-->>Tree: tree diff plus name-only -z paths
  Ref->>Ref: best-effort delete both refs
```

The display diff and the authoritative path list are deliberately separate.
`git diff --name-only -z` supplies `filesTouched`, so spaces, quotes, and tabs in
a path are not lost by parsing human-oriented patch headers. An unrelated edit
and a partial edit made before a failed turn are both included.

## Capturing the result

The handoff never edits the old patchset. It captures the working tree again and
activates a new immutable patchset. The previous one remains available as the
baseline for the delta.

The successor gets a deterministic account of:

- which asks were addressed, partially addressed, or untouched;
- which files the turn touched beyond the asks;
- which dispositions carried cleanly;
- which anchors became orphaned;
- any rename information from Git.

A light model turn may turn that account into a one-line digest, but the facts
remain model-free. If the digest cannot run, the account still renders.

## Signing opens the pull request

After the delta is reviewed, the own-branch paper previews a pull request rather
than review comments. Its title and body start from the drafted values and remain
editable. Signing sends those exact edited values through `publish.submitPr`.

Desktop main resolves the named branch from the captured patchset, verifies that
it is the branch shown on the paper, and pushes `refs/heads/<branch>` to the
resolved github.com remote. It prefers `origin` and otherwise uses the first
matching GitHub remote. `GitHubPrSubmissionAdapter` then opens the pull request.
A detached HEAD cannot be submitted because there is no branch to name.

```mermaid
sequenceDiagram
  actor You
  participant Paper
  participant Main as Desktop main
  participant Git
  participant GitHub

  You->>Paper: Edit title and body, then sign
  Paper->>Main: publish.submitPr
  Main->>Main: Re-resolve review and named head branch
  Main->>Git: Push branch to origin
  Main->>GitHub: Find open PR for head + base
  alt Open PR already exists
    GitHub-->>Paper: Reuse its URL and number
  else No open PR
    Main->>GitHub: Create draft or ready PR
    GitHub-->>Paper: New URL and number
  end
```

The adapter checks for an open PR from the same head and base before creating
one. It also resolves GitHub's duplicate-PR response back to the existing PR, so
a retry or a double sign does not open a second one. The successful URL appears
on the paper.

## Carry is deliberately conservative

The live handoff carry uses deterministic file and span evidence. A byte-identical
span can carry at the same path, and it can carry through a Git-proven rename when
the bytes still match. Edited spans reopen. Whole-file dispositions reopen across
a rename because the patch headers change.

The fuzzy occurrence matcher is a separate mechanism. It exists and is measured,
but it does not currently drive disposition carry in the handoff loop. This
separation avoids turning “looks similar” into “the reviewer already approved
this.” See [delta re-review and lineage](/developing/concepts/delta-rereview-and-lineage/).

## What the delta account narrates (hunk grain)

The successor's delta account is deterministic and model-free. Per staged ask it
reports addressed / partially-addressed / untouched from the byte-verified carry,
and it partitions the successor's changes into "covered by an ask" and "beyond the
asks." As of [#73](https://github.com/rbutera/rennet/issues/73) the beyond-asks
half is computed at **hunk grain**, not just path grain.

A successor hunk is _new_ when its changed-line content (added plus deleted line
bytes, context and header line numbers excluded) matches no hunk in the prior
patch for that file or its rename source — so pure line-number drift is not a
change. The same raw-hunk parser the decomposition floor uses does the parsing;
there is no second diff parser. Each new hunk that no ask covers (an ask targets
the file path-grained, or its anchored span intersects the hunk's range) is
reported in one of two named buckets:

- **unasked-file** — a hunk in a file no ask targeted (the loud scope-creep).
- **asked-file** — a hunk inside a file an ask _did_ target, but outside every
  asked span. Path grain cannot see this: the file is "covered", so the extra
  change vanishes into "partially addressed." Hunk grain surfaces it.

Both buckets are honest narration of work the agent was allowed to do. The
account never presents a beyond-ask hunk as a violation, a warning to
acknowledge, or a reason to block anything — it gates nothing (Rule Zero). A
file whose patch is truncated degrades honestly to path grain for that file, and
a review persisted before hunk grain existed validates and renders as the
path-grain account it is.

### The traceMap names which task ran

Because of the traceMap, the account can say "ran as task 2 — 'Tighten the
parser'" instead of naming a bare anchor. The composed bundle's `traceMap` maps
every ask id to the task it landed in. When `review.handoff.run` captures the
successor, it hands the verified bundle's ask trace — the id-stamped anchors, the
`traceMap`, and each task's preview title, a small projection with **no prompts or
instruction bodies** — to the capture. The delta account matches each staged ask
to its bundle ask by anchor identity and stamps the composed task's index and
title.

The traceMap attributes _asks_, never hunks. The write turn is one opaque agent
session with no per-task execution telemetry, so claiming "task 2 caused this
hunk" would be a guess, and the account carries only verifiable facts. A plain
regenerate carries no trace and computes identically.

## The commands and owners

| Concern | Owner |
|---|---|
| Bundle filtering, anchored context, deterministic prompt | `packages/core/src/handoff-loop.ts` |
| Agent-friendly ordering, narration, and the compose→run integrity check | `packages/core/src/handoff-compose.ts` |
| Stage-6 composed-bundle preview view-model | `packages/ui/src/canvas/publish.ts` (`handoffPreview`, `handoffDispositions`) |
| Write-enabled harness turn behind the main-process command | `packages/adapters/src/handoff-run-live.ts` |
| Checkpoint and turn diff | `packages/adapters/src/checkpoint-store.ts` |
| Command routing and successor capture | `apps/desktop/src/main/dispatch.ts` |
| Delta facts | `packages/core/src/delta-account.ts` |
| Draft, handoff paper, run action, and sign interaction | `packages/ui/src/app.tsx`, `packages/ui/src/components/handoff-paper.tsx` |

The renderer never gets direct process authority. The own-branch destination
composes the bundle on handoff-surface entry (`review.handoff.compose`), previews
it on the stage-6 paper, and calls `review.handoff.run` with that exact bundle
from one action. The desktop main process resolves the current review, verifies
and runs the composed bundle, captures the result, and returns a validated output
the paper renders truthfully.

## Current edge

The main precision seam is sub-file lineage across a changed patchset. The fuzzy
matcher can classify it, but handoff carry
still stays on the deterministic floor. That means Rennet can reopen more work
than strictly necessary; it does not silently carry uncertain review state.
