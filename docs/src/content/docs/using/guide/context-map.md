---
title: The Context Map
description: Explore a project's structure and what Rennet has learned about it, confirm or reject each claim, and ask the orchestrator questions grounded in the map.
---

The Context Map is where you see how Rennet understands a project: its scopes and
files, how they depend on each other, and the plain-language claims Rennet has
learned about what each part is for. Every claim is a *labelled hypothesis* until
you say otherwise — you confirm the ones that are right, reject the ones that are
wrong, and ask about anything unclear. The map is the ground truth a review reads
from, so keeping it honest makes every later review sharper.

Open it from a project's detail view with the **Context Map** button in the
header.

## What it shows

The view has three panes that stay in step with each other.

- **The tree** (left) is the structural spine: scopes at the top, then
  directories, then files, each row carrying a rolled-up file count. Selecting a
  row drives the other two panes.
- **The neighbourhood graph** (centre) re-centres on the selected scope and draws
  its direct dependency edges — the manifest and import relationships Rennet read
  from the deterministic snapshot. It is the "who does this talk to" view, kept
  small on purpose.
- **The knowledge panel** (right) lists the claims that belong to the current
  selection, each with its evidence, confidence, and disposition.

A freshness badge tells you which snapshot the map was built against, so you know
whether you are looking at current understanding or a view that predates recent
changes.

## Confirm, reject, or discuss a claim

Each claim starts as a **hypothesis**. Three verbs move it:

- **Confirm** — you agree; the claim becomes confirmed and is treated as settled
  understanding.
- **Reject** — the claim is wrong; it becomes rejected and is **excluded from the
  context Rennet feeds the orchestrator**. A rejected claim never gets cited back
  at you.
- **Discuss** — you are unsure; this prefills the ask rail with the claim so you
  can put the question to the orchestrator.

Your disposition is recorded and persists. When Rennet later re-derives the map
after code changes, it only re-adjudicates claims whose cited code actually
changed — a confirmed or rejected claim in an untouched part of the project keeps
your disposition verbatim. Your judgement is a recorded state, not something a
later pass silently resets.

## Ask the orchestrator

The ask rail puts a question to the project's orchestrator, grounded in the map
and the knowledge layer. An answer comes back with its evidence — the specific
files and claims it drew on — so you can check the reasoning rather than take it
on faith. Rennet answers only from what the snapshot and knowledge actually
support: a question it cannot ground returns an honest "unanswered" with a
reason, never a confident guess.

## How the map gets built

The map has two layers. The **deterministic layer** — scopes, files, edges — is
built directly from the repository and needs no model. The **knowledge layer** —
the plain-language claims — comes from a model-backed enrichment pass.

You can build and enrich a project's map from the CLI without a running daemon:

```sh
rennet map .                          # build & store the deterministic repo map
rennet map . --enrich                 # also run the model-backed knowledge pass
rennet map . --enrich --model claude-sonnet-5   # pick the harness model for that turn
```

The first `--enrich` run mints the initial knowledge set; later runs do a delta
pass, re-learning only the parts of the project whose code changed and carrying
everything else forward. The Context Map view reads whatever is stored — if a
project has not been enriched yet, the view says so plainly rather than inventing
a knowledge layer that does not exist.

## Related

- [Review a GitHub pull request](/using/guide/reviewing-a-github-pr/) — the
  reviews that read from this map.
- [Product and vision](/using/concepts/product-and-vision/) — why grounded,
  evidence-backed understanding is the point.
