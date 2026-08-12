---
title: Architecture overview
description: The Rennet packages, the dependency arrows between them, and the shape of a review — at a glance.
---

Rennet is a pnpm + Nx monorepo. The product is split into small packages under
`packages/*` with a single desktop application under `apps/desktop`. The
dependency arrows between packages are enforced by a boundary check
(`scripts/check-boundaries.mjs`) that runs as part of `pnpm check`, so the graph
below is not aspirational — a violation fails the build.

## Package dependency graph

```mermaid
flowchart TD
  types["@rennet/types"]
  protocol["@rennet/protocol"]
  instructions["@rennet/instructions"]
  core["@rennet/core"]
  adapters["@rennet/adapters"]
  ui["@rennet/ui"]
  desktop["apps/desktop"]

  protocol --> types
  instructions --> types
  core --> types
  core --> protocol
  core --> instructions
  adapters --> types
  adapters --> protocol
  adapters --> instructions
  adapters --> core
  ui --> types
  ui --> protocol
  desktop --> core
  desktop --> adapters
  desktop --> ui
  desktop --> protocol
  desktop --> types
```

Read the arrows as "depends on". `@rennet/types` sits at the bottom and depends
on nothing; everything is allowed to depend on it. `@rennet/core` is the review
engine; `@rennet/adapters` wraps the model harnesses; `@rennet/ui` renders the
review surface; `apps/desktop` composes them into the Electron app.

## The shape of a review

A review moves through a small number of stages, each with a clear boundary
between "what the model produced" and "what Rennet recorded".

```mermaid
flowchart LR
  diff[Diff or PR] --> patchset[Patchset]
  patchset --> route{Route to models}
  route --> findings[Findings]
  findings --> paper[Review paper]
  paper --> sign[Sign / dispositions]
```

- **Patchset** — the diff, digested into a structure Rennet can read and anchor
  threads against.
- **Route** — the patchset is planned across the configured set of model
  invocations.
- **Findings** — what the models reported, grouped by the file and flow they
  touch.
- **Paper** — the durable record of the review.
- **Sign** — your dispositions, recorded; nothing the model authored is treated
  as a decision until you make it one.

## Where to go next

- [Architecture contracts](/developing/concepts/architecture-contracts/) — the
  boundaries in detail.
- [Design doctrine](/developing/concepts/design-doctrine/) — the principles the
  code is written against.
- [Delivery order](/developing/reference/delivery-order/) — the sequence the
  product is built in.
