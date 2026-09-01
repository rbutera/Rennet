---
title: Benchmarks
description: Recorded stage timings for the Repo Map build, lens drafting, and the round report, rendered from committed measurement data.
---

Rennet measures itself. Every Repo Map build and every lens generation records a
timing for each stage it actually ran, and each stage record names the harness and
model that executed it. This page renders the exported data — no number on it was
typed by hand.

## What is measured

Three pipelines carry stage records:

- **The Repo Map build.** Deterministic end to end: `scout`, `resolve`, `tree`,
  `workspace`, `conventions`, `symbols`, `build`, `verify`, `store`, plus `total`.
  No model runs in any of them, and the schema forbids one from claiming it.

  Which of those a run *could* record depends on who ran it, so every run says.
  The daemon scouts a repository before it maps it; `rennet map` has **no scout
  pass at all**, by design. Each group of runs below names its producer, because
  a `resolve` row with no `scout` row beside it otherwise reads as a lost
  measurement rather than as a stage that was never going to run.

  `total` is the **sum of that repository's own stage durations**, not the wall
  clock from its first stage to its last. A project scouts every repository in
  one pass and maps them in a later one, so a wall-clock span would charge each
  repository for every sibling scouted or mapped in between — a repo's `total`
  would grow with the size of the project rather than with its own work. Within a
  pass no stage closes until the next opens, so the sum hides no waiting; the only
  thing it excludes is other repositories.
- **Lens drafting.** Per lens: the drafting turn (`lens-draft`), the repair ladder
  (`lens-repair`), and the deterministic work between the ladder and the accepted
  write (`lens-post-process`). A lane with two seats records one `lens-draft` per
  seat, so a dual review names both providers rather than averaging them into one.
- **The round report.** `report` is the whole gate — building and measuring the
  evidence manifest, resolving the seat, the turn, deterministic verification —
  and `report-classification` is the provider turn inside it.

Beside those sit the generation-wide records: `coverage`, `reveal`, and
`first-core-board`, the last measured from the reviewer's own wait origin.

## How the modes are derived

The Model Council routes per job, so one run can legitimately span providers. A
run's configuration label is therefore **derived from its stage records**, never
read off a setting:

| Derived mode | What it means |
| --- | --- |
| Dual model (council) | Stages of this run named both Claude and Codex. |
| Claude only | Every attributed stage named Claude. |
| Codex only | Every attributed stage named Codex. |
| No provider stage | No stage named a provider — every Repo Map build, and a generation that failed before a seat resolved. |

No table below merges two modes. Averaging a Claude-only run with a council run
would state a number describing no configuration that exists.

Failed and aborted runs are recorded and counted — a pipeline that archived only
its successes would report the fast half of its own latency — and they are never
mixed into a latency figure. Every stage row states the **outcome** of the run it
came from, and each group's median run time is over its **complete runs only**. A
run that fell over halfway measured half a pipeline, and averaging it with one
that finished describes neither. A group where nothing completed states no median
at all rather than a `0` that would read as an instantaneous pipeline.

Medians are the middle value, or the midpoint of the two middle values on an even
sample, truncated to whole milliseconds.

## Measurements

Each section below is rendered from `docs/data/benchmarks.json`. A run kind with no
exported rows says so rather than showing an empty table — lens and report timings
need a dogfood run against a real coding harness, and only measurements that have
actually been recorded and committed appear here.

```rennet-benchmarks
```

## Where the numbers come from

Recording is on by default and controlled from **Settings → Benchmarks**, which
also renders the local history with the same per-stage breakdown. Records live in
`~/.rennet/benchmarks.jsonl` and never leave the machine.

The data on this page is written by the export command:

```sh
rennet benchmarks export --out docs/data/benchmarks.json
```

The export is deterministic, including its own timestamp: `exportedAt` is derived
from the end of the newest recorded run, not from the wall clock, so re-exporting an
unchanged archive is a genuinely empty diff. Pass `--timestamp <iso>` to state the
stamp explicitly. A fresh clock reading is the last fallback and the only part of
this path that is not reproducible.

The docs build **fails if `docs/data/benchmarks.json` is missing or corrupt**, because
a benchmarks page that rendered blanks would be indistinguishable from a very fast
pipeline. That check runs in an Astro integration, not only in the remark plugin that
renders the tables, so it runs on every build regardless of what any cache holds.

Validation cannot catch the opposite case, a **valid** edit to the data: there is nothing
wrong to throw about. The page's Markdown carries no number — the fence is empty and the
plugin reads the file at render time — so its digest does not move when the measurements
do, and Astro's content layer reuses the render it already has. That is not hypothetical:
a valid edit once completed a build whose page still carried the previous export's
provenance.

So the same integration does two more things. It **drops Astro's stored renders** when the
data's hash changes, so the page is rebuilt; and after the pages are emitted it **checks
the built HTML**, failing the build if any rendered page states an older provenance — or
if no page rendered the data at all. The check is what makes the invalidation trustworthy:
it reads what was actually written, so a stale page cannot ship whatever the cause.

Provenance is stated above the tables. Stale-but-labeled beats fresh-but-invented,
and re-exporting is one command.
