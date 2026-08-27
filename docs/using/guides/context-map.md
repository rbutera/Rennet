---
title: The Context Map
description: Inspect project structure, assess stored claims, and ask questions using repository evidence.
---

The Context Map shows a project's scopes, files, dependency edges, and stored
claims about what each part does. A generated claim begins as a hypothesis. You
can confirm it, reject it, or discuss it with the orchestrator.

Open the map from the **Context Map** button in a project's header.

## What the view contains

The left pane contains the project tree. It starts with scopes, then shows
directories and files with their rolled-up file counts.

The center pane contains two related views. The neighborhood graph shows direct
manifest and import relationships around the selected scope. The detail view
shows the selected node's stored claims with their evidence, their confidence,
and whether you have confirmed or rejected them.

The right pane contains the orchestrator ask rail, titled **Orchestrator**.
Selecting an item in the tree updates the graph, details, and evidence available
to that conversation.

A freshness badge identifies the snapshot used to build the map.

## Assess a claim

Each hypothesis has three actions:

- **Confirm** records that you accept the claim.
- **Reject** records that the claim is wrong and excludes it from context sent to
  the orchestrator.
- **Discuss** places the claim in the ask rail so you can question it.

Your confirmations and rejections persist. During later enrichment, Rennet
re-evaluates claims whose cited paths changed and carries your verdict on
untouched claims forward.

## Ask about the project

The ask rail answers from the stored snapshot and knowledge claims. Each answer
includes the files and claims used as evidence. When the available evidence does
not support an answer, the result is `unanswered` and includes a reason.

## Build the map

The deterministic layer contains scopes, files, and dependency edges read from
the repository. The knowledge layer contains model-generated claims with
evidence.

Build either layer from the CLI without starting the daemon:

```sh
rennet map .
rennet map . --enrich
rennet map . --enrich --model claude-sonnet-5
```

The first command stores the deterministic map. `--enrich` creates or updates
the knowledge layer. Later enrichment runs process paths changed since the
previous snapshot and carry the remaining claims forward. If no knowledge layer
has been stored, the view reports that state.

## Related guides

- [Review a GitHub pull request](./reviewing-a-github-pr.md) explains the review path that uses project context.
- [Product and vision](../concepts/product-and-vision.md) explains why Rennet keeps evidence attached to claims.
