---
title: User journey
description: The intended path from adding a project to signing a review, with honest notes about what is live today.
---

This is the road through Rennet: add a project, enter through your branch or a
team pull request, understand the change, shape the outbound artifact, and sign
it. A team change can become a GitHub review, while your branch can be pushed and
opened as a pull request. The coding-agent loop in the journey is still missing
its renderer join.

## The journey at a glance

```mermaid
flowchart TD
  projects[Projects] --> add[Add a project]
  add --> process[Process repository context]
  process --> detail[Project smart list]
  detail -->|Local row| local[Capture local patchset]
  detail -->|Pull request row| pr[Pin PR patchset]
  local --> review[Review through lenses]
  pr --> review
  review --> draft[Collation draft]
  draft --> paper[Paper preview]
  paper -->|Pull request| post[Post GitHub review]
  paper -->|Own branch| handoff[Handoff to coding agent]
  handoff --> delta[Review only what moved]
  delta --> review
```

## 1. Projects is home

First run is the empty Projects list, not a separate onboarding wizard. The main
action is **Add a project**. Harness discovery stays in the background and can
show a short status such as “Claude and Codex detected.”

## 2. Add a project

Choose a workspace or one repository, pick its path, then confirm the discovered
repositories and worktrees. Detection supplies editable defaults rather than a
questionnaire.

## 3. Process the repository

Rennet builds the Repo Map used by later reviews: deterministic structure plus
evidence-backed project knowledge. The intended experience narrates the work in
plain language and ends by becoming the project screen.

The live UI is simpler than that destination. The underlying project-context
lifecycle is real; the richer narrated animation remains polish work.

## 4. Choose from one smart list

The project screen mixes local work and pull requests in one list. Rows remain
visually distinct: local branch, your pull request, teammate pull request, or a
read-only closed/merged pull request. Use **Needs you**, **Mine**, **Local**, or
**PRs** to narrow it; the default Hot sort combines recent activity with work
that needs attention.

Your review request and a failing check on your own open pull request can float a
row into **Needs you**. A read-only row can offer **Clean up** when its worktree is
still checked out locally.

Once a local branch has a pull request, the pull-request row wins and the local
checkout becomes a **checked out locally** annotation. One thing should not
appear twice.

## 5. Capture one immutable patchset

For a local branch, Rennet captures committed changes, the index, unstaged
changes, and relevant untracked files without mutating the checkout. For a team
PR, it pins the forge-reported base and head commits.

Every review surface refers to that immutable patchset. A push, rebase, or new
local capture creates a successor instead of rewriting the thing under review.

## 6. Read the sequence

The tall sequence canvas is the review heart. It orders the whole change for
comprehension, keeps the diff column stable, and lets you open related tests,
definitions, or the source file in your editor without losing your place. The
current index and its deliberately honest confidence tiers are explained in
[code intelligence](/developing/concepts/code-intelligence/).

When both sides changed, the code header says **View test** or **View
implementation** instead of making you hunt through a file tree. That jump only
speaks for files in this review; no button is not a claim that no test exists.

## 7. Rotate the lenses

Use Spec, Sequence, Decisions, Flagged, and Noise over the same anchors. They do
different jobs:

- Spec turns known OpenSpec artifacts into addressable requirements and scenarios,
  with coverage chips only when a real mapping exists.
- Decisions groups implementer choices with evidence, reconstructed reasoning,
  and discernible alternatives.
- Flagged indexes automated findings by severity, agreement, verification, the
  cross-harness adjudication verdict on a contested row, and code anchor without
  pretending they are the reviewer's verdict.
  - When your changeset touches UI (a component, a stylesheet, a renderer file),
    a **verify-ui** pass renders the change with whatever your project affords —
    its own tests, storybook, a dev server, any browser automation it has —
    screenshots it, runs an accessibility check, and compares what rendered against
    the change's stated intent. Its observations arrive as ordinary flags you
    disposition like any other, and a strip on Flagged shows the captured
    screenshots inline. If it could not mount the change with anything your project
    affords, it says so plainly — that is "could not check," never an all-clear —
    and a backend-only changeset skips it entirely. Rennet bundles no browser or
    accessibility tooling of its own, and verify-ui never blocks signing or
    publishing.
- Noise groups low-signal churn, names whether a rule or model judged it, and lets
  you pull anything back with **not noise?**

Blast radius paints those surfaces rather than changing their order. Read
coverage is equally literal: an action marks material read, scrolling can only
mark it skimmed, and collapsed or unseen work remains unread. The whole-change
mosaic keeps that residue visible. [Review lenses](/developing/concepts/review-lenses/)
has the deeper model.

## 8. Ask and annotate in place

Comments, change requests, questions, and discussion stay attached to a line,
range, chunk, requirement, or draft item. Threads open in the margin so the diff
does not reflow.

The orchestrator is the normal conversational model. A per-message “ask both”
option can show two labelled answers. Rennet does not auto-synthesize them into
a third supposedly authoritative answer.

## 9. Build the collation draft

Every disposition is staged when you make it. The private draft collects items
from every lens and lets you reword, reorder, merge, split, discuss, or withdraw
them. Background refinement can clean up rough notes, but the draft remains
editable and yours.

## 10. Preview and sign the paper

The paper is a read-only preview of exactly what will leave Rennet. For a team
PR it contains the batched GitHub review and its verdict. For your own branch it
will contain the handoff or PR submission.

If the preview is wrong, go back to the draft. Signing publishes the exact
paper, idempotently, in the reviewer's name.

## 11. Re-steer your own branch

The intended own-branch loop sends requested changes to a capable coding
harness, then captures a successor patchset, carries only exact unaffected
review state, and focuses the next pass on what moved.

The backend builds and runs the bundle, brackets the turn with Git checkpoints,
and captures the successor, and a model-backed composer shapes the notes. The
renderer now composes, previews, and runs the bundle from the own-branch
destination, and the acting command executes the composer's exact output bound by
its digest, so this loop is end to end in the shipped surface.

Signing the finished own-branch paper pushes the named branch and opens the
previewed pull request. The next precision work is narrower: richer sub-file
lineage without carrying old decisions onto merely similar code.

## Where to go next

- [Getting started](/using/guide/getting-started/) is the shortest hands-on tour.
- [Reviewing a GitHub PR](/using/guide/reviewing-a-github-pr/) follows the live team path.
- [Agent handoff](/developing/concepts/agent-handoff/) explains the own-branch loop under the hood.
- [Canvas model](/developing/concepts/canvas-model/) explains how the review surfaces share state.
