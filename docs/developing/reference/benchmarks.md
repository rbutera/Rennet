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
  `workspace`, `conventions`, `symbols`, `build`, `verify`, `store`, plus the
  end-to-end `total`. No model runs in any of them.
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

Failed and aborted runs are recorded and counted. A pipeline that archived only its
successes would report the fast half of its own latency.

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

The export is deterministic: the same archive and the same provenance stamp produce
byte-identical output, so re-exporting unchanged measurements is an empty diff.

The docs build **fails if `docs/data/benchmarks.json` is missing or corrupt**, because
a benchmarks page that rendered blanks would be indistinguishable from a very fast
pipeline. That check runs in an Astro integration at `astro:build:start`, not only in
the remark plugin that renders the tables: Astro caches rendered Markdown, so a page
whose bytes had not changed would not re-read the data, and a corrupted file once
completed a whole build while the page served the previous numbers.

Provenance is stated above the tables. Stale-but-labeled beats fresh-but-invented,
and re-exporting is one command.
