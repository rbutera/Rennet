---
title: Product and vision
description: What Rennet is for, how a review should feel, and which parts of the full loop are live today.
---

Rennet is a local-first desktop review harness. It helps you understand and take
responsibility for changes written by coding agents without turning the review
into another autonomous rubber stamp.

> You stopped writing the code. You still have to answer for it.

## The problem

Coding agents can produce a changeset faster than a person can build a mental
model of it. A flat list of changed files makes that gap worse: it tells you
where bytes moved, not how the change hangs together.

The first user is the engineer reviewing work produced on their own branch before
asking a teammate to absorb it. Rennet removes the mechanical overhead around
that self-review. It does not outsource the judgment or turn a model's finding
into a human verdict.

Rennet does the structural work around the review. It groups related changes,
orders them for comprehension, surfaces decisions and disagreements, remembers
what you acted on, and turns your dispositions into one editable outbound
artifact.

The models assist. The human reviews and signs.

## The whole loop

```mermaid
flowchart LR
  source{Change source}
  source -->|Your branch| local[Immutable local patchset]
  source -->|Team PR| remote[Pinned GitHub patchset]
  local --> digest[Digest and lenses]
  remote --> digest
  digest --> decide[Read, discuss, dispose]
  decide --> draft[Editable collation draft]
  draft --> sign[Signed paper]
  sign -->|Team PR| github[Normal GitHub review]
  sign -->|Your branch| agent[Coding-agent handoff]
  agent --> delta[Successor patchset and delta review]
  delta --> digest
```

The two entry doors share one review engine. The destination changes with the
mode: a teammate's PR gets a GitHub review; your own branch gets a handoff to a
coding agent and eventually a PR submission.

## Four product principles

### Roll up aggressively

Related files and hunks should read as one logical cohort. Grouping is a product
opinion, not a per-project tuning exercise.

### Let the reviewer choose the altitude

You can act on a whole cohort or one anchored item. Decisions are collapsed for
calm, never capped or silently discarded.

### Make zoom reversible

Move from the whole change to a decision, hunk, line, test, or definition and
back without losing your place.

### Keep the user effort for judgment

Rennet can clean up wording, assemble context, run models, and maintain the
bookkeeping. It should not add ceremony that merely makes the machinery feel
important.

## Ordering is the product

The baseline order comes from deterministic dependency information. An agent
may improve it into the clearest story: high-level intent first, then the
foundations needed to understand the implementation.

Risk is an overlay, not the table of contents. A high-blast-radius change can be
painted amber without forcing every review to begin at the scariest line.

## The review lenses

| Lens | The question it answers |
|---|---|
| Spec | What was this change supposed to do, and which requirements have evidence? |
| Sequence | In what order should I read the implementation? |
| Decisions | Which calls did the implementer make that I need to understand? |
| Flagged | Where did automated review find a problem or disagreement? |
| Noise | What remains, and why does it probably not need close attention? |

Blast radius paints the other lenses instead of owning a separate surface. The
same patchset and anchors sit underneath every view, so rotating a lens does not
move the code under you.

Models surface findings, reconstruct possible reasoning, and propose useful
grouping. The reviewer reads, judges, and signs. Product copy should preserve
that distinction: Rennet can say a model **flagged** something, not that the
machine **reviewed**, **approved**, or **found a bug** on the reviewer's behalf.

## Local-first, honestly stated

Rennet has no Rennet backend and no Rennet telemetry service. Review state and
project context live locally. Material sent through a selected harness may go to
that harness's model provider. Rennet feeds its deterministic assembled context
as a labelled layer and records the exact prompt or system-append bytes handed
to each fleet seat. The inspector says **Context sent to the fleet** only when a
send record's context digest matches the assembly digest; ambient harness reads
remain separately disclosed.

The intended zero-config path uses harnesses already installed and authenticated
on your computer. Rennet does not need to become a credential vault to drive
Claude Code or Codex.

## What is live and what is still closing

The team-PR loop works end to end on `main`: ingest, decomposition, the review
lenses, dual-model analysis, refinement, signing, and a real GitHub post.

The own-branch submission path is live: Rennet drafts the pull request, signs,
pushes the named branch, and opens the previewed pull request. The coding-agent
handoff is not yet live through the renderer, but the composed bundle is now
threaded all the way through: its mechanical bundle, capable runner, checkpoint
capture, successor patchset, deterministic carry, and model composer exist behind
main-process commands, and the acting command now executes the exact composed
bundle (bound by its digest, refusing a tampered or stale one) with a stage-6
preview rendering it before it runs. What remains is the renderer's in-app
trigger that invokes the acting command. Richer sub-file lineage,
project-processing narration, and parts of the code-intelligence experience are
also intended destinations rather than finished surfaces.

These docs mark those seams explicitly. A designed flow is useful context, but
it is not reported as shipped merely because a schema or mockup exists.

## The human sign

The collation draft is private working material. The paper previews the exact
outbound review or submission. Signing is the moment it becomes the user's
artifact.

That is not a generic consent gate. It is the authorship model: the review goes
out in the reviewer's name, voice, and verdict.

## Where to go next

- [User journey](/using/guide/user-journey/) follows the intended experience from project to signed paper.
- [Reviewing a GitHub PR](/using/guide/reviewing-a-github-pr/) covers the live team-review path.
- [Common questions](/using/concepts/common-questions/) answers the usual objections.
- [Architecture overview](/developing/concepts/architecture-overview/) explains how the system supports the loop.
