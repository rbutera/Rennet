---
title: Collation and signing
description: How dispositions from every lens become one editable draft and then one exact outbound artifact.
---

The collation draft is the missing middle between reviewing code and sending a
result. It gathers every disposition into one editable account; signing turns
that account into the paper that is pushed or posted.

## The three-part spine

```mermaid
flowchart LR
  lenses["Lens canvases<br/>judge code at its anchors"]
  draft["Collation draft<br/>edit the whole account"]
  paper["Paper<br/>exact outbound preview"]
  review["Batched GitHub review"]
  agent["Coding-agent handoff<br/>then delta re-review"]
  pr["Push branch and open PR"]

  lenses -->|dispose| draft
  draft -->|sign| paper
  paper -->|someone else's PR| review
  paper -->|your branch needs work| agent
  paper -->|your branch is ready| pr
  draft -->|jump to anchor| lenses
```

The lens canvases are where judgments begin. The collation draft is where those
judgments become a coherent document. The paper is a preview of the exact result,
with editing kept on the draft.

## Why the draft is its own canvas

A review lens projects one angle over code. The collation draft projects the
complete L2 disposition set across all angles. Here the dispositions themselves
are the main object and code is one click away as supporting context.

The draft is an ordered list, not a map keyed only by file path. That choice makes
three important actions representable:

- **Reorder:** output order is part of how the review reads.
- **Merge:** two related notes can become one instruction or comment.
- **Split:** one note can become two items at the same anchor.

Each item has a stable ID, anchor, disposition type, raw body, optional refined
body, and staging lane. `collationItems()` turns the current ordered list into the
outbound disposition sequence, and `collationPayload()` serialises it in that
same order.

## Editing belongs on the draft

The current draft supports:

| Action | Effect |
|---|---|
| Reword | Changes the original body and clears any now-stale refinement |
| Retype | Switches approve, request-change, comment, or question |
| Move | Changes output order |
| Merge | Joins two raw notes and removes the second item |
| Split | Adds a new empty sibling at the same path |
| Withdraw | Removes the item from the draft |
| Refine | Adds a model-cleaned candidate body |

The renderer ingests a disposition into the draft in the same act that records it
on a lens. There is no separate staging ritual between “I made this judgment” and
“it appeared in my draft.”

## One draft, two destinations

The machinery stays the same in both review modes; only the outbound shape
changes.

| | Your branch | Someone else's pull request |
|---|---|---|
| Draft emphasis | Compose change requests and the PR account | Refine and order review comments |
| Paper previews | PR title, body, base, head, and draft state | Review verdict and anchored comments |
| Sign does | Push the branch and create or reuse the PR | Post one batched GitHub review |
| Needs another coding pass | Intended: hand the same asks to a coding harness, then recapture | Not applicable |

On your branch, the title and body can be drafted by a Model Council seat and
then edited directly. On another person's PR, the paper derives one GitHub review
event from the collated comments.

## The payload follows the preview

All outbound paths derive from the same draft projection the paper renders:

```mermaid
sequenceDiagram
  participant D as Collation draft
  participant P as Paper
  participant M as Electron main
  participant G as GitHub

  D->>P: Ordered effective bodies
  P->>P: Render exact destination shape
  P->>M: Sign with canonical payload
  M->>M: Rebuild and compare outbound form
  M->>G: Post review or push + create PR
  G-->>P: Outcome and URL
```

The sign is the product's external act: the reviewer sees the whole artifact, then
sends that artifact. Internal review state, orchestrator chatter, and refinement
history are not part of the outbound shape unless the reviewer has turned them
into a disposition on the draft.

## What is live

The destination frame, editable collation canvas, comment refinement, paper,
batched review post, and own-branch push-plus-PR submission are wired through the
renderer. The paper has a back action; edits happen on the draft.

The write-enabled handoff and delta-recapture machinery is wired behind typed
main-process commands, and the renderer now invokes it: an own-branch review
composes, previews, and runs the handoff bundle. The composer's exact output is
what the acting run executes, bound by its digest. Consuming the successor
patchset into a delta re-review is the next seam.

The deeper orchestrator-on-draft experience is still incomplete. The UI explains
the proposal model, and `canvasOps@2` can raise proposals, but free-form
orchestrator editing of the whole collation draft is not yet the main live path.

## Code map

| Concern | Source |
|---|---|
| Ordered draft model and transforms | `packages/ui/src/canvas/collation.ts` |
| Destination staging lanes | `packages/ui/src/canvas/staging.ts` |
| Destination-specific payloads | `packages/ui/src/canvas/publish.ts` |
| Draft canvas | `packages/ui/src/components/collation-draft-canvas.tsx` |
| Paper | `packages/ui/src/components/publish-sheet.tsx` |
| Live sign wiring | `packages/ui/src/app.tsx` and `apps/desktop/src/main/dispatch.ts` |

See [comment refinement](/developing/concepts/comment-refinement/) for how rough
notes become effective bodies and [the canvas model](/developing/concepts/canvas-model/)
for the wider L0–L3 architecture.
