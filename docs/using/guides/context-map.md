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
header. It opens as a full view; leaving it lands on that project's New Chat.

The map generates the first time you add a project. A prefilled questionnaire
about the project runs alongside that generation and is never a gate: the map
completes and its exits appear whether or not you answer it, and every answer
stays editable later in **Settings → Projects**. See
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

Generation runs as a partitioned swarm. Rennet slices the repository along its
detected scopes, light-tier workers read each slice and emit anchored claims,
and the verification seat confirms hypotheses and adds cross-cutting claims that
span slices. The partitions are invisible plumbing: the map shows scopes and
claims, not worker slices. Every in-scope file is read — there is no file cap —
and the Model Council picks the models for both seats. On a baseline advance,
only workers whose slice contains changed paths re-run; untouched claims carry
forward.

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
