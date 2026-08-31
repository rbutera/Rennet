---
title: The Context Map
description: Inspect project structure, assess stored claims, and ask questions using repository evidence.
---

The Context Map shows a project's scopes, files, dependency edges, and stored
claims about what each part does. A generated claim begins as a hypothesis, and
a model verification seat confirms or rejects it against the cited code. You can
override a verdict, or discuss a claim with the orchestrator; nothing waits for
your confirmation.

Reach the map from **View Context Map** on the ready summary shown when a new
project finishes indexing, or from the **Map** control in a project's New Chat
header. It opens as a full view, and the back arrow in its header or Escape leaves
it for that project's New Chat.

**Map** in a session's top bar opens the same map for that session's project,
without leaving the session: it renders inside the session's own chrome, so the
map's structure and claims appear under the top bar you were already using rather
than under a second header of their own. In a workspace with several repositories,
the session opens the map for the exact repository under review. The standalone
project map first lists the member repositories so you can choose one; it never
silently substitutes the workspace's first repository. Leaving a session map with
the top bar's back arrow returns to the board rather than to New Chat. A review
opened by a direct link rather than through one of its
sessions has no project to map, and the view says so instead of showing the
board again.

The map starts generating in the background as soon as you add a project, even
if you leave the indexing screen or start a review immediately. Opening **Map**
before the structural snapshot is ready shows the current generation stage and
rereads the same durable run. **Retry** resumes interrupted work; if a completed
run left no readable snapshot, it rebuilds that project's map under a fresh run
identity rather than treating the broken artifact as current. The scout
runs first and saves its detected and guessed facts; only then does the prefilled
questionnaire appear while structural and knowledge generation continue. The
questionnaire is never a gate: the map completes and its exits appear whether or
not you answer it. Its provenance and evidence come from the saved scout record;
changes you want to keep as project policy belong in **Settings → Projects**. See
[Getting started](./getting-started.md#what-happens-after-you-add-it) for that
flow.

## What the view contains

The left pane contains the project tree. It starts with scopes, then shows
directories and files with their rolled-up file counts.

The center pane contains two related views. The neighborhood graph shows direct
manifest and import relationships around the selected scope, with its nodes
clickable and keyboard-activatable to re-center. The detail view shows the
selected node's stored claims with their evidence, their confidence, and whether
you have confirmed or rejected them.

The standalone map has no ask rail of its own: you read structure and assess
claims here, and questioning a claim carries it into the project's session
conversation. A freshness badge identifies the snapshot used to build the map.

## Assess a claim

A verification seat re-reads each hypothesis's cited spans and records
`confirmed` or `rejected` on its own. Your assessment is an optional override,
never a required step:

- **Confirm** records that you accept the claim.
- **Reject** records that the claim is wrong and excludes it from context sent to
  the orchestrator.
- **Discuss** raises the claim in the project's session conversation so you can
  question it.

Your confirmations and rejections persist. During later enrichment, Rennet
re-evaluates claims whose cited paths changed and carries your verdict on
untouched claims forward.

## Ask about the project

Within a session, the chat column beside the surface answers from the stored
snapshot and knowledge claims. Each answer includes the files and claims used as
evidence. When the available evidence does not support an answer, the result is
`unanswered` and includes a reason.

## Build the map

The deterministic layer contains scopes, files, and dependency edges read from
the repository. The knowledge layer contains model-generated claims with
evidence.

Generation runs as a partitioned swarm. Rennet slices the repository into
modules — groups of files that import each other, found from the import graph
rather than from the folder tree — and hands each worker its slice's declared
symbols, its resolved imports, and the imports that cross into other slices. A
worker starts from that and reads whatever else it needs. A deterministic pass
then merges the workers' claims, collapsing duplicates and checking every
import-shaped claim against the repository's own import index; the verification
seat sees only what that pass could not settle, and adds the cross-cutting claims
that span slices. The slices are invisible plumbing: the map shows scopes and
claims, not worker slices. The Model Council picks the models for both seats. On
a baseline advance, only workers whose slice contains changed paths re-run;
untouched claims carry forward.

A run that is interrupted does not start over. The project-run journal checkpoints
the scout and structural snapshot, while the knowledge journal saves each batch as
it completes. Reattaching or restarting resumes the first incomplete checkpoint.
If a scout, map, or knowledge worker exits with an error, the journal records that
phase as failed and **Map** offers **Retry** under the same run identity. Completed
checkpoints remain complete; the retry starts at the failed phase.
The stored knowledge layer is only replaced when a run finishes whole, and the
processing view reports ready only after that verified set is readable. A
half-finished run never presents itself as a complete map.

Review boards record the exact structural snapshot and knowledge set they consumed.
If a review starts while project processing is still running, its first draft can
appear immediately with the context available at that moment. When processing
finishes, Rennet queues a fresh draft for the same patchset; it never keeps the
earlier degraded boards as the settled result. Reopening the app resumes the same
project run and preserves this relationship between the map and its boards.

There is no file cap, but there is a policy exclusion. Lockfiles, vendored trees,
build output, generated files, and binaries are not sent to a worker: reading them
costs a turn and teaches nothing. Excluded files stay in the map's file inventory
with the reason they were excluded, so the map never quietly pretends a file does
not exist.

Build either layer from the CLI without starting the daemon:

```sh
rennet map .
rennet map . --enrich
```

The first command stores the deterministic map. `--enrich` creates or updates
the knowledge layer. Later enrichment runs process paths changed since the
previous snapshot and carry the remaining claims forward. If no knowledge layer
has been stored, the view reports that state.

## Related guides

- [Review a GitHub pull request](./reviewing-a-github-pr.md) explains the review path that uses project context.
- [Product and vision](../concepts/product-and-vision.md) explains why Rennet keeps evidence attached to claims.
