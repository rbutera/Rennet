---
title: Hand off and the exits
description: The decided design for gathering asks, the living drafts, and the three exits — posting a review, running work-order rounds, and opening the pull request.
status: planned
tracking: https://github.com/rbutera/rennet/issues/452
---

This page records the decided design for the redesigned hand-off surfaces,
grilled to agreement on 2026-08-25 (ruling log on
[#458](https://github.com/rbutera/rennet/issues/458)). It is not live on
`main`: [collation and publishing](./collation-and-publishing.md) and
[agent handoff](./agent-handoff.md) describe the shipped code this replaces
at cutover.

## Asks

Everything gathers as **asks**: typed messages carrying an anchor, text, an
intent, and an exit lane, minted from findings, code-line comments, quote
threads, or plain conversation, each with provenance back to its source.
Dispositions do not exist in this model.

The orchestrator stages asks as they arise. When the reviewer stated the
conclusion or pressed a shortcut, it stages directly; when it inferred one, it
drops a one-tap offer pill instead. Every staging act leaves an undecorated
receipt at its source — a transcript line or a chip on the thread — and the
receipt is also the undo. Findings never auto-stage; staging records the
reviewer's judgment, not the lens output. The stage-versus-offer boundary
lives in a versioned orchestrator prompt beside the lens prompts.

The **Hand off button is the live basket**: its count ticks as asks land, and
it carries a derived working state while a draft rework runs.

## Selection is the steering wheel

Board prose selection offers **Comment / Request changes / Explain**. Draft
prose selection offers **Revise / Drop / Explain** — revise takes a free-text
instruction anchored to the span, drop retires it, explain answers with
provenance (which comment or finding produced the sentence). Same highlight
mechanics and thread tooltips everywhere; steering instructions become the
span's inspectable history.

## The Hand off view

Hand off toggles a view over the main surface. The toggle itself is
target-aware and carries the staged-ask count: on a teammate PR it reads
**Write Review** (the review concludes, under the reviewer's name); on one's
own branch or PR it reads **Continue** (the rounds loop keeps going). Its
lanes depend on the entry mode:

- **Teammate PR** — one lane: *Post review*. Work orders are own-branch only.
- **Own branch** — two lanes: *This round* (the work order now gathering) and
  *The pull request* (the destination, always visible, its description
  ripening across rounds).
- **Retrospective** — no exits.

## Living drafts

The orchestrator continuously redrafts every outbound document — the review
text, the work order, the PR description — as the review progresses. Each
comment, dismissal, or thread conclusion queues a rework. The reviewer never
types into a draft; steering happens by talking or by highlighting a span.

- Folding a staged ask into a draft is near-instant assembly; its only
  visibility is the affected block streaming in place. The **drafting
  activity feed** — a collapsed line expanding into full turn anatomy with
  the trigger queue — belongs to the long-running regeneration after a
  work-order round returns, and appears only there. The surface never locks.
- Stale content is removed and ledgered, never left and never silently
  dropped: a **Retired** drawer holds every retired block with its reason and
  round receipt, restorable with a click; a **Detached** list holds threads
  whose anchoring prose no longer exists.

## The review's two strata

A GitHub review is one **review body** plus **line comments** pinned to diff
positions, and the draft mirrors that shape rather than flattening it. An ask
whose provenance carries a diff position — a finding's anchor, a code-line
comment — becomes a line comment, grouped by file with its citation. An ask
without one (a quote of board prose has no diff line to pin to) travels in
the review body, woven in by the orchestrator — its placement under the body
header is the whole statement, never an explanatory label. The preview
renders exactly this structure, because it is exactly what posts.

## Verdict and the approving review

The orchestrator proposes the verdict from the reviewer's acts and asks in
chat when those acts are ambiguous; the reviewer can always flip it. An
approving review is a first-class flow, not an empty state: a drafted Approve
whose body is grounded in what the reviewer actually walked, raised, and
cleared. Publication keeps the accepted contract: an exact-payload preview
and one direct Post — no holds, no consent ceremony.

## Rounds: the own-branch loop

1. Gather asks into *This round*.
2. Dispatch — one round at a time, one worker in a detached worktree; asks
   gathered mid-run queue for the next round.
3. Watch the run live.
4. On completion the reviewer is greeted by the **summary of what changed**
   (the successor account: addressed / partial / untouched / beyond the
   asks), with one action back to the lenses and Hand off.
5. Each round mints a **new generation** of lens boards, drafted delta-aware:
   drafters receive the successor account, unchanged sections carry forward,
   and changes are marked natively. The prior generation freezes as
   drill-down. Asks, threads, and highlights re-anchor by quote match;
   casualties land in the Detached list.
6. Repeat until nothing is left to ask. The PR lane has ripened the whole
   time — one action pushes the branch and opens the pull request,
   idempotently. After the PR exists, rounds continue identically; there is
   no self-review lane on one's own pull request.
