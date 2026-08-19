---
title: Review a GitHub pull request
description: Open a teammate's pull request, work through it in Rennet, and post one normal GitHub review.
---

This is the shortest path from “there is a pull request” to a review that lands
on GitHub under your name. Rennet does the sorting and checking; you decide what
the review says.

## Before you start

Rennet connects to GitHub with a one-time device sign-in — no GitHub CLI
required. On first run (or any time later, from Settings), choose **Connect
GitHub**: Rennet shows a short one-time code, you enter it at
[github.com/login/device](https://github.com/login/device), and GitHub hands
Rennet a token scoped to `repo` and `workflow`. The sign-in is skippable —
working-tree review needs no GitHub at all — and any surface that does need
GitHub asks again at its point of need.

The token is stored in a private file (owner-only permissions) under Rennet's
own data directory, never in project files, and it never reaches the renderer.
If the OAuth app is configured with expiring user tokens, Rennet renews the
token automatically before it expires — the one-time sign-in stays one-time.
The side door is pasting a personal access token in Settings; it feeds the same
store and is validated before it is kept. The current forge adapter targets
github.com; GitHub Enterprise hosts are not wired yet.

You also need a supported coding harness installed. Claude Code is the primary
adapter, and Rennet discovers it automatically rather than asking you for an API
key. When Codex is also installed it runs as a co-equal second review seat, and
divergent findings can get a third-opinion adjudication — an additive pass that
never blocks a row.

## The review flow

```mermaid
sequenceDiagram
  actor You
  participant Rennet
  participant GitHub
  participant Git as Local Git
  participant Harness as Review harness

  You->>Rennet: Open a PR row from the project list
  Rennet->>GitHub: Read PR identity, title, body, and SHAs
  Rennet->>Git: Read the pinned diff and repository context
  Git-->>Rennet: Immutable patchset
  Rennet->>Harness: Send the selected review material
  Harness-->>Rennet: Findings and explanations
  You->>Rennet: Approve, question, comment, or request a change
  Rennet-->>You: Show the exact review preview
  You->>Rennet: Post
  Rennet->>GitHub: Post one SHA-bound review
```

1. Open the project, use **PRs** or **Needs you** to narrow the unified list, then
   choose the pull request.
2. Read the change through the available views. Rennet keeps the sequence,
   decisions, flags, and remaining noise connected to the same underlying diff.
3. Leave dispositions where you have a judgment: approve, question, comment, or
   request a change.
4. Open the draft and tidy the wording. The preview shows the actual outbound
   review, not a summary of it.
5. Post the review. Rennet sends it to GitHub as one review event rather
   than a burst of unrelated comments.

The review path for someone else's PR is live end to end on the current main
branch: GitHub ingest, review, refinement, the preview, and the final post.

## Where the diff comes from

GitHub tells Rennet *which* base and head commits make up the pull request. When
the repository is available locally, Git supplies the actual diff and nearby
code. That gives Rennet the same repository context your local tools have,
without trying to rebuild a diff from GitHub's file list.

```mermaid
flowchart LR
  github["GitHub: base SHA + head SHA"] --> match{"Local checkout available?"}
  match -->|yes| local["Read content from local Git"]
  match -->|no| blocked["Ask for a matching local checkout"]
  local --> patchset["Pinned, immutable patchset"]
  patchset --> review["Review surfaces"]
```

The live deep-review path requires a matching local checkout. If none is
available, Rennet reports that REST-only review is unavailable instead of
pretending it captured the repository from GitHub.

### CI checks

After review, Rennet reads that commit's GitHub checks and shows them in Flagged;
a failure it can tie to your changed code becomes a real finding.

- An attributable failure without a real code anchor stays visible in the panel
  rather than becoming a finding.
- Only known infrastructure signatures get the infrastructure label.
- Model refinement can only attribute a failure to the change or leave it
  unclassified.
- Missing, truncated, or timed-out CI never blocks review or publishing,
  and is never reported as passing.

## What reaches GitHub

GitHub understands line comments, file comments, replies, and one review body.
It does not understand Rennet's cohorts, lenses, multi-file threads, or private
read state. Rennet translates the review at the boundary:

- a normal contiguous code note becomes a GitHub review thread;
- a file-wide note becomes a file comment;
- a multi-file thought is split across useful anchors, with the full thought
  kept together locally;
- structure that has no GitHub equivalent goes into the review body;
- private chat, dismissed findings, reading progress, and model traces stay
  local.

The preview shows what will travel and what will remain in Rennet. The posted
review is pinned to the commit you reviewed.

## When the pull request changes

A push, rebase, or force-push creates a new patchset. Rennet does not rewrite the
review you were already reading.

```mermaid
stateDiagram-v2
  [*] --> ReadingOldPatchset
  ReadingOldPatchset --> NewPatchsetAvailable: head SHA changes
  NewPatchsetAvailable --> DeltaReview: open the successor
  DeltaReview --> Carried: byte-identical, unambiguous work
  DeltaReview --> Reopened: changed or uncertain work
  Carried --> ReadyToSign
  Reopened --> ReadyToSign: reviewed again
```

Only byte-identical, unambiguous work carries automatically. Changed or uncertain
work reopens, so the next pass focuses on what actually moved. See
[delta re-review and lineage](/developing/concepts/delta-rereview-and-lineage/)
for the engineering model behind that behaviour.

## What stays on this Mac

Rennet has no hosted backend — no server of ours holds your work. Review state,
reading progress, local discussion, and the full Rennet structure stay in local
application storage. Material selected for a model turn can leave the machine
through the harness and provider you use. Rennet records the exact text it handed
to each model, and only labels context **sent** when that record matches what it
assembled — it never claims a model saw nothing extra. If you
[review from another device](/using/guide/remote-access/), it reaches the daemon
on this Mac directly over your own private network, not through any Rennet
server.

GitHub naturally receives the review only when you post it. If GitHub is
unavailable, local reading still works for material already on disk, but posting
waits until the connection is back.

## GitHub edge cases

If the network path to GitHub drops (VPN flap, sleep/wake, WSL DNS), Rennet
retries the connection once and then says plainly that GitHub is unreachable
and nothing was sent — reconnect the network and try again; no state is lost.

An organization can require SAML SSO for Rennet's token. GitHub may
then return `X-GitHub-SSO: partial-results`: a valid-looking but incomplete pull
request list. Rennet keeps that state distinct from a complete or empty list;
GitHub includes an authorization URL with the state, though the current project
screen only shows the generic incomplete-list banner. Authorize the token
for the named organization through GitHub, then refresh the project.

GitHub can also apply a secondary rate limit while the review is posting. Rennet
keeps the artifact as one batched review and surfaces the backoff instead of
splitting it into independently retrying comments. Retry after GitHub's stated
window; the review marker and read-back reconciliation protect the one-review
shape when the network outcome was uncertain.

## Next

- [User journey](/using/guide/user-journey/) for the whole flow, including your
  own branch.
- [Product and vision](/using/concepts/product-and-vision/) for why Rennet uses
  roll-up, zoom, and several views of the same change.
