---
tags: [rennet, spikes, performance]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

> 📜 **Historical evidence, not current authority.** Superseded wherever it conflicts with **RULE ZERO** (`CLAUDE.md`): no consent gates, no gates, no robustness for robustness' sake. Read for rationale and provenance only.

# Rennet Spike – Pierre Diff Virtualization

Spike #1 for [[Code Review Harness App]], the highest-information-value item on
that note's "what to prototype first" list. The question, verbatim from the
plan: *can `@pierre/diffs` render and scroll a large diff at 120Hz feel, or do
we need our own virtualization via `@tanstack/react-virtual`?*

Code: `spikes/pierre-diffs-virtualization/` (buildable, with a README
that reproduces every number below).

## Verdict

**Use Pierre as-is. Specifically `CodeView`, never the bare `FileDiff` /
`PatchDiff`.**

Not "wrap Pierre with our virtualization", and not "fork or replace". Pierre
already ships two levels of virtualization, its own Shiki worker pool, and a
component (`CodeView`) that is explicitly built for the exact surface Wingman
needs. Our `@tanstack/react-virtual` fallback was prototyped and measured, and
it should be retired as plan B: it only looks competitive because it does far
less.

At 5,000 changed lines, `CodeView` renders in **81ms**, holds **120fps** with a
worst frame of **15.4ms**, and keeps **899 DOM nodes** mounted. The same diff
through Pierre with virtualization switched off mounts **97,139 nodes** and
produces a **493ms** frozen frame. That is the whole spike in two numbers.

This also closes three "unverified" items on
[[References/Desktop and Mobile Stack 2026]] — see *Corrections* below.

## What was built

A Vite + React 19 app rendering the same synthetic diff bytes through five
paths, driven by Playwright against a production build:

| mode | what it is |
|---|---|
| `idle` | scroller with no diff renderer — the machine's frame ceiling |
| `pierre-codeview` | `<CodeView items={…} />` |
| `pierre-virtual` | `<Virtualizer>` + one `<PatchDiff>` per file |
| `pierre-plain` | same, **no** `<Virtualizer>` — renders everything |
| `tanstack` | the fallback: `@tanstack/react-virtual` + Shiki in a Worker |

Sizes: ~500 / 6 files, ~2,000 / 18 files, ~5,000 / 34 files, plus a **single
file with 5,000 changed lines** — the cell that actually answers the question,
because a 34-file diff cannot distinguish line-level windowing from
file-level composition.

Diffs are generated from a seeded op list (context / delete / add), so `@@`
headers are correct by construction and the same size label always produces
byte-identical patches. Content is plausible TypeScript with long lines mixed
in, so Shiki has real tokenizing work.

Measured on Apple M5 Pro (15 cores), macOS 26.5.2, headed Chromium 1234,
**120Hz display**, production build, 3 repeats per cell, medians reported.

## Calibration: proving the instrument before believing it

A check that cannot fail has not passed. The calibration cells run **first**,
so a broken instrument fails loudly before it can produce a clean-looking number:

| cell | what it is | fps | p50 ms | p95 ms | p99 ms | max ms | frames >16.7ms | longtasks n / max ms |
|---|---|---|---|---|---|---|---|---|
| `FLOOR-idle-scroller` | empty scroller, no renderer | 120.29 | 8.3 | 9.9 | 10.3 | 10.3 | 0 | 0 / 0 |
| `FLOOR-idle+50ms-stall` | same, 50ms stall per frame | 19.96 | 50 | 50.5 | 57.3 | 58.4 | **391** | **316 / 50** |
| `calibration-baseline` | Pierre virtualized, 2k, no stall | 120.21 | 8.3 | 9.68 | 10.2 | 10.4 | 0 | 0 / 0 |
| `calibration-stall-8ms` | same + **8ms** stall per frame | 106.99 | 8.3 | **16.7** | 17.07 | 18.2 | **30** | 0 / 0 |
| `calibration-stall-50ms` | same + **50ms** stall per frame | 19.22 | **50** | 58.4 | 59.94 | 66.7 | **665** | **665 / 64** |
| `calibration-codeview-stall-50ms` | CodeView, 2k, + 50ms stall | 18.93 | **50.1** | 58.4 | 59.75 | 60.3 | **664** | **664 / 57** |

**The instrument moves.** An idle scroller sits at 8.3ms — exactly 1/120s, so
this machine genuinely runs at 120Hz and p50 = 8.3ms means "hitting the
ceiling", not "unmeasured". A deliberate 50ms main-thread stall per frame drags
p50 to 50ms and produces hundreds of long tasks. Even an **8ms** stall is
caught: p95 goes 9.68 → 16.7ms.

Two further controls are structural rather than cells:

- **Positive control for the virtualization question itself.** `pierre-plain`
  and `pierre-virtual` consume identical bytes. Mounted code rows: **7,412 vs
  100**. If those had not diverged, the counter was not measuring windowing.
- **Selector calibration.** The first version of the harness counted
  `[data-line-index]`, which also matches Pierre's line-number gutter cell and
  double-counted every row. Corrected to `[data-line]` after reading the actual
  shadow DOM.

Two measurement bugs were caught and fixed rather than reported:

- The first full run reused one browser across all cells and crashed the tab on
  the 5k cell. That would have read as *"the library falls over at 5k"*. It
  does not — the cell passes cleanly in isolation. Each run now gets a fresh
  browser.
- A mid-run edit to the fixture generator triggered Vite HMR during
  measurement. That run was discarded and everything re-run against a static
  production build.

And once, `results.md` already existed from a killed run while the new one was
still going — "the file exists" is not "this run wrote it". Checked the
timestamp and the process, deleted the stale file.

## Results

### The headline: `CodeView`, the recommended path

| diff size | render ms | code rows mounted | token spans | DOM nodes | heap MB | fps | p50 ms | p95 ms | max ms | longtasks |
|---|---|---|---|---|---|---|---|---|---|---|
| ~500 / 6 files | 66.3 | 56 | 465 | 744 | 9.74 | 120.67 | 8.3 | 9.5 | 17 | 0 |
| ~2,000 / 18 files | 73 | 58 | 559 | 828 | 27.11 | 120.1 | 8.3 | 9.8 | 17.1 | 0 |
| ~5,000 / 34 files | **80.8** | 58 | 622 | **899** | 31.48 | **120.05** | **8.3** | 9.7 | **15.4** | **0** |
| **1 file × 5,000** | 75.2 | 57 | 646 | 912 | 35.17 | 119.8 | 8.3 | 9.8 | 33.3 | 0 |

Render time is near-flat from 500 to 5,000 changed lines (66 → 81ms) and
mounted rows stay at ~58 regardless of diff size. Worst frame never exceeds
17.1ms, and at the largest multi-file size it is 15.4ms — i.e. the tail does
not grow with the diff. That is what "it scales" looks like.

### The crux: ONE file with 5,000 changed lines

The cell that actually distinguishes line-level windowing *inside* a file from
mere file-level composition. A 34-file diff cannot.

| path | render ms | code rows mounted | DOM nodes | heap MB | fps | p50 ms | max ms | longtasks n / max ms |
|---|---|---|---|---|---|---|---|---|
| **CodeView** | **75.2** | 57 | **912** | 35.17 | 119.8 | 8.3 | **33.3** | 0 / 0 |
| Virtualizer + PatchDiff | 89.4 | 100 | 1,956 | 31.11 | 119.67 | 8.3 | 43.1 | 0 / 0 |
| **no virtualization** | 129.5 | **7,274** | **94,375** | 37.14 | 113.95 | 8.3 | **493** | **5 / 362** |
| react-virtual fallback | 20.3 | 87 | 1,240 | 17.41 | 120.05 | 8.3 | 17 | 0 / 0 |

**103x fewer DOM nodes and a 15x lower worst frame** than the unvirtualized
path, on identical bytes. The 493ms frame is a visible half-second freeze.

### Scroll performance by size (all paths)

| path | diff size | fps | p50 ms | p95 ms | p99 ms | max ms | frames >16.7ms | longtasks |
|---|---|---|---|---|---|---|---|---|
| Pierre + `<Virtualizer>` | ~500 | 120.6 | 8.3 | 10 | 10.2 | 16 | 0 | 0 |
| Pierre + `<Virtualizer>` | ~2,000 | 120.21 | 8.3 | 9.68 | 10.2 | 10.4 | 0 | 0 |
| Pierre + `<Virtualizer>` | ~5,000 | 119.93 | 8.3 | 9.7 | 10.2 | 16.7 | 1 | 0 |
| Pierre, no Virtualizer | ~500 | 120.72 | 8.3 | 9.5 | 10.2 | 10.3 | 0 | 0 |
| Pierre, no Virtualizer | ~2,000 | 120.18 | 8.3 | 9.68 | 10.2 | 10.4 | 0 | 0 |
| Pierre, no Virtualizer | ~5,000 | 119.85 | 8.3 | 9.7 | 10.3 | 25.3 | 2 | 0 |
| react-virtual + worker | ~500 | 120.47 | 8.3 | 9.38 | 10.3 | 17 | 1 | 0 |
| react-virtual + worker | ~2,000 | 120.15 | 8.3 | 9.6 | 10.2 | 16.8 | 1 | 0 |
| react-virtual + worker | ~5,000 | 120.05 | 8.3 | 9.8 | 10.2 | 15.7 | 0 | 0 |

**Read this table honestly: on an M5 Pro, everything holds 120Hz at p50** —
including the 97,139-node unvirtualized path. Median frame rate does not
discriminate here, and a spike that only reported p50 would have concluded
"virtualization is unnecessary". The discriminators are mounted DOM, memory,
and the tail (max frame, long tasks), which is where the multi-file cells stay
quiet and the single-file cell breaks.

### Cost: render time, mounted DOM, memory

| path | diff size | render ms | code rows mounted | token spans | DOM nodes | heap MB (render) | heap MB (after scroll) |
|---|---|---|---|---|---|---|---|
| Pierre + `<Virtualizer>` | ~500 | 107.1 | 100 | 956 | 1,398 | 11 | 12.92 |
| Pierre + `<Virtualizer>` | ~2,000 | 185 | 100 | 1,188 | 1,650 | 29.26 | 17.67 |
| Pierre + `<Virtualizer>` | ~5,000 | 364.4 | 100 | 1,015 | 1,525 | 22.74 | 51.96 |
| Pierre, no Virtualizer | ~500 | 69.3 | 764 | 6,873 | 9,819 | 10.41 | 11.89 |
| Pierre, no Virtualizer | ~2,000 | 115.8 | 3,036 | 29,672 | 40,822 | 28.75 | 18.87 |
| Pierre, no Virtualizer | ~5,000 | 179.6 | **7,412** | **70,405** | **97,139** | 37.04 | 43.61 |
| react-virtual + worker | ~500 | 11.3 | 81 | 1,247 | 1,351 | 5.82 | 11.22 |
| react-virtual + worker | ~2,000 | 13.9 | 90 | 1,263 | 1,375 | 6.27 | 15.49 |
| react-virtual + worker | ~5,000 | 19.7 | 89 | 1,159 | 1,269 | 6.49 | 20.03 |

`code rows mounted` stays flat at 100 for the Virtualizer path and ~58 for
CodeView while the unvirtualized path grows linearly to 7,412. That flatness is
the proof of windowing.

Note the Virtualizer path's render time *scales* (107 → 185 → 364ms) while
CodeView's does not (66 → 73 → 81ms). This matches Pierre's own documented
caveat: with the lower-level API "every top-level file or diff container stays
mounted". CodeView owns the whole surface and has no per-file containers.

### Cross-build anchors

The CodeView cells were measured on a later build than the main matrix, so two
anchor cells were re-run on the new build to prove the datasets are comparable
rather than assuming it:

| anchor cell | dataset | render ms | DOM nodes | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|
| `calibration-baseline` | main matrix | 185 | 1,650 | 8.3 | 9.68 | 10.4 |
| `calibration-baseline` | CodeView pass | 181.1 | 1,650 | 8.3 | 9.58 | 10.4 |
| crux `pierre-virtual` 1×5k | main matrix | 89.4 | 1,956 | 8.3 | 9.6 | 43.1 |
| crux `pierre-virtual` 1×5k | CodeView pass | 88.8 | 1,956 | 8.3 | 9.65 | 49.6 |

Node counts identical, timings within noise. Comparable.

Zero page errors and zero console errors across all **24 cell runs** (17 main +
7 CodeView pass, 3 browser runs each). The error channel is not dead: earlier
dev-server runs did surface a React `createRoot` warning and a favicon 404
through the same path, so an empty list here means clean, not unwired.

## What `@pierre/diffs` actually does

Read out of `dist/` and confirmed against the public source repo.

- **Virtualization is real and it is two-level.** File-level via an
  `IntersectionObserver` over file containers, and **line-level inside a
  file** via `RenderRange { startingLine, totalLines, bufferBefore,
  bufferAfter }`, rendered in hunk-sized batches (`hunkLineCount: 50` by
  default; `CodeView` uses 1).
- **It is off by default.** With no virtualizer in the tree,
  `DEFAULT_RENDER_RANGE.totalLines = Infinity`. The React layer swaps
  `FileDiff` → `VirtualizedFileDiff` purely on the presence of the
  `Virtualizer` context (`useFileDiffInstance`). Miss that, and you ship the
  97,139-node path without any error telling you so.
- **`CodeView` is the recommended surface**, and its docs describe Wingman
  almost word for word: "Built-in per-line virtualization that should scale to
  nearly any file or diff that can fit in memory", non-virtualized header and
  footer regions "ideal for PR summary cards and approval bars", and
  `loadDiffFiles` for "large patch-driven review UIs where full file contents
  should be fetched only when users expand unchanged". It also carries
  annotations, gutter utilities, cross-item selection, and `scrollTo` by item
  or line — most of the review surface's primitives.
- **It ships its own Shiki worker pool** (`WorkerPoolContextProvider` +
  `workerFactory`), so "highlight in a worker, transfer tokens not HTML" is
  already done. Tokens arrive as spans carrying `--diffs-token-dark` /
  `--diffs-token-light` custom properties, which is how one DOM serves both
  themes without re-tokenizing.
- **Scroll-anchor correction is implemented** (`scrollFix`,
  `reconcileHeights`) — the genuinely hard part of variable-height
  virtualization, which is what a diff with wrapped lines and inline comment
  threads is.

## Corrections to [[References/Desktop and Mobile Stack 2026]]

Three items in that note's "Unverified" section are now settled:

1. **"Virtualization is not documented… Unverified. Prototype this first."**
   Resolved: it virtualizes, at both file and line level. It *is* documented,
   at diffs.com under Virtualization and CodeView — but not in the shipped
   package README, which is why it read as absent. The published README never
   mentions it.
2. **"I could not find a public source repository… the obvious GitHub org
   guesses 404."** Resolved: `pierrecomputer/pierre`, Apache-2.0, 5,659 stars,
   64 open issues, pushed 2026-08-04, not archived, with `packages/diffs`
   containing `src`, `test`, and `benchmarks`.
3. **"Treat the licence as good and the ability to fork as unverified."**
   Fork is viable. Beyond the public repo, the published tarball's sourcemaps
   carry `sourcesContent` for **197 of Pierre's own source files, ~52,900 lines
   of original TypeScript**. The Apache-2.0 licence text is real (189 lines,
   the genuine Apache 2.0).

One item in the note stands and is worth restating: the vendor coupling to
`@pierre/theme` / `@pierre/theming` is real, and it currently bites (below).

## Risks

- **Measured 1.3.0-rc.1, not 1.3.2.** `~/.npmrc` carries a rolling 7-day
  `before` cooldown (supply-chain hygiene), which excluded 1.3.2. The cooldown
  was respected rather than bypassed. Mitigating evidence: the dependency and
  peer graphs are **identical** across 1.3.0-rc.1 → 1.3.2, and the whole line
  is +67KB unpacked / +8 files over three patch releases. Re-run to confirm.
- **`@pierre/theme` will not resolve out of the box.** `@pierre/theming@1.0.0`
  declares `peerOptional @pierre/theme@^1.1.0` while `@pierre/diffs` pins
  `2.0.0`, so npm nests the copy where hoisted `@pierre/theming` cannot find
  it. It fails at *runtime* with `Could not resolve "@pierre/theme/pierre-dark"`,
  not at install. Fix: depend on `@pierre/theme` directly.
- **The whole Shiki grammar set gets packaged.** Pierre imports from `"shiki"`
  (the full bundle) in 10 places, so the build emits **314 lazy chunks** and a
  12MB `dist`. Lazy at runtime, but all of it ships in the app bundle.
- **Debug globals in the production build.** `Virtualizer.setup()` assigns
  `window.__INSTANCE` and `window.__TOGGLE`, gated on a **static**
  `Virtualizer.__STOP` that halts *all* instances. Verified present in our
  minified production bundle. In an Electron renderer this is a global any
  page script can reach, and multiple virtualizers clobber each other.
- **Annotations get recycled.** Pierre's own docs: "A virtualized surface may
  recreate rendered annotation content as it leaves and re-enters the rendered
  window, so keep interactive annotation state outside that content." Our
  comment threads *are* annotations, so this is a design constraint on the
  review surface, not a footnote.
- **Memory grows during scroll.** The virtualized 5k cell goes 22.7MB after
  render → 52.0MB after scrolling. Pierre keeps an AST LRU cache defaulting to
  100 entries (`totalASTLRUCacheSize`). Bounded, but worth pinning deliberately.
- **All numbers are from an M5 Pro.** Even the *unvirtualized* 97k-node path
  held 120Hz p50 on this machine; the tail is where it broke (493ms). On weaker
  hardware, and inside Electron with git plumbing and a harness running, the
  margin is much thinner. The headroom argument, not the p50, is what justifies
  the choice.
- **Release cadence.** ~95 releases since 2025-12-10, currently rc/patch churn.
  Pin exactly and let an adapter absorb the churn.
- **Our fallback flatters itself.** The `react-virtual` path posts the best raw
  numbers, but it has fixed-height rows, no intraline diff, no split view, no
  annotations, no context expansion, no sticky headers, no selection. It is not
  a like-for-like comparison and must not be read as one.

## Bead candidates

| # | Title | Description | Priority | Depends on |
|---|---|---|---|---|
| 1 | Adopt `@pierre/diffs` `CodeView` as the Rennet review surface | Build the review surface on `CodeView` with `WorkerPoolContextProvider`. Do not use bare `FileDiff`/`PatchDiff`: virtualization is opt-in and silently absent. Spike: `spikes/pierre-diffs-virtualization/` | P1 | — |
| 2 | Pin `@pierre/diffs` exactly and add `@pierre/theme` as a direct dependency | Peer conflict between `@pierre/theming@1.0.0` (wants `^1.1.0`) and `@pierre/diffs` (pins `2.0.0`) makes the theme unresolvable at runtime unless installed top-level. Pin exactly given the rc/patch cadence. | P1 | 1 |
| 3 | Prototype comment threads as Pierre annotations under virtualization | Annotation content is recreated as items leave/re-enter the window. Verify thread state, focus, and in-progress composer text survive recycling. This is the review surface's core interaction. | P1 | 1 |
| 4 | Re-measure the spike on `@pierre/diffs` 1.3.2 | The npm 7-day cooldown forced 1.3.0-rc.1. Deps are identical across the line, but confirm. `npm run measure` reproduces everything. | P2 | — |
| 5 | Measure the review surface under CPU throttling and on low-end hardware | Every number is from an M5 Pro at 120Hz. Re-run with CDP `Emulation.setCPUThrottlingRate` 4x/6x and inside Electron with the git and harness processes live. | P1 | 1 |
| 6 | Trim the packaged Shiki grammar set | Pierre imports the full `shiki` bundle; the build emits 314 chunks / 12MB. Decide a supported-language list and whether custom language registration can replace the bundle. | P2 | 1 |
| 7 | Decide the context-expansion strategy via `loadDiffFiles` | Pierre supports lazily fetching full file contents when a reviewer expands unchanged context. This is exactly the "context reach" feature on [[Code Review Harness App]]. Wire it to the git plumbing layer. | P2 | 1 |
| 8 | Pin `totalASTLRUCacheSize` deliberately and watch renderer memory | Heap goes 22.7MB → 52.0MB across one scroll of a 5k diff. Default cache is 100 entries. Choose a value against an Electron memory budget. | P2 | 1 |
| 9 | Report the `window.__INSTANCE` / `window.__TOGGLE` / static `__STOP` debug hooks upstream | Present in the shipped production build. Multiple virtualizer instances clobber each other and `__STOP` is global. `pierrecomputer/pierre` is a live Apache-2.0 repo taking issues. | P3 | — |
| 10 | Retire `@tanstack/react-virtual` as the rendering plan B | Keep the spike as a comparison artifact, drop it from the dependency plan in [[References/Desktop and Mobile Stack 2026]]. It only wins on numbers because it implements far less. | P3 | 1 |

## Reproducing

```bash
cd ~/dev/rennet/spikes/pierre-diffs-virtualization
npm install
npm run build && npx vite preview --port 5199   # production build, no HMR
npm run measure                                  # full matrix -> results/
node bench/report.mjs                            # the tables above
```

Calibration cells run first on purpose: if the instrument cannot see a
deliberate stall, nothing downstream of it is worth reading.
