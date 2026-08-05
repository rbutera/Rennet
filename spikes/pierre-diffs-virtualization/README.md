# Spike: can `@pierre/diffs` render and scroll a 5,000-line diff at 120Hz?

Spike #1 for **Wingman** (working title), the Electron code review app. The
whole review surface bets on the answer, so this was built before anything
else.

Full write-up, verdict, and bead candidates:
`~/focused/vault/Wingman Spike – Pierre Diff Virtualization.md`

## What it measures

Five render paths over the *same* synthetic diff bytes:

| mode | what it is |
|---|---|
| `idle` | a scroller with no diff renderer at all — the machine's frame ceiling |
| `pierre-codeview` | `<CodeView items={…} />` — **the winner**, and the path Pierre's docs recommend for an all-code scroll region |
| `pierre-virtual` | `<Virtualizer>` + one `<PatchDiff>` per file (the lower-level API) |
| `pierre-plain` | same, with **no** `<Virtualizer>` — renders everything |
| `tanstack` | the fallback: `@tanstack/react-virtual` + Shiki in a Web Worker |

…at four sizes: `small` ≈500 / 6 files, `medium` ≈2,000 / 18 files,
`large` ≈5,000 / 34 files, and `mono` ≈5,000 changed lines in **one file** —
the size that distinguishes line-level windowing inside a file from mere
file-level composition. Plus a `stall=<ms>` parameter that busy-waits the main
thread once per frame.

**Answer:** Pierre virtualizes, at both file and line level, but only when
`<CodeView>` or `<Virtualizer>` is in the tree. `CodeView` at 5,000 changed
lines: 81ms render, 899 DOM nodes, 120fps, worst frame 15.4ms. The same diff
with virtualization off: 97,139 nodes and a 493ms frozen frame.

## Run it

```bash
npm install
npm run build
npx vite preview --port 5199    # measure the PRODUCTION build, not the dev
                                # server: HMR and the module waterfall both
                                # pollute the numbers
```

Then, in another shell:

```bash
npm run measure                  # full matrix, 3 repeats, headed Chromium
SPIKE_REPEATS=1 npm run measure  # quick pass
npm run measure -- --headless    # compare against headless
node bench/report.mjs            # the grouped tables used in the write-up

# subset + separate output file
SPIKE_ONLY=pierre-codeview SPIKE_OUT=results-codeview npm run measure
```

Results land in `results/results.json` (everything, including per-run raw) and
`results/results.md`. `bench/report.mjs` also merges
`results/results-codeview.json` if present.

`npm run dev` still works for poking at a cell by hand:

```
http://localhost:5199/?mode=pierre-codeview&size=mono&stall=0
http://localhost:5199/?mode=pierre-virtual&size=large&stall=0
http://localhost:5199/?mode=pierre-plain&size=mono&stall=0
http://localhost:5199/?mode=tanstack&size=large&stall=0
http://localhost:5199/?mode=idle&size=small&stall=50
```

## How to trust the numbers

**The instrument is calibrated before it is believed.** The matrix runs its
calibration cells *first*:

- `FLOOR-idle-scroller` — no renderer. Establishes what perfect looks like on
  this machine. If this is not ~8.3ms, the display is not 120Hz and every
  frame-interval number below must be read as capped, not clean.
- `FLOOR-idle+50ms-stall` and `calibration-stall-8ms` / `-50ms` — a deliberate
  synchronous main-thread stall per frame. **The reported frame times must
  move.** A harness that reports 8.3ms under a 50ms stall is broken, and any
  clean result it ever produced is worthless.

Two more controls are built into the design rather than into a cell:

- `pierre-plain` vs `pierre-virtual` over identical bytes is the positive
  control for the virtualization question itself. If the mounted-row counts do
  not diverge, the counter is not measuring what it claims. They diverge
  7,412 vs 100.
- `countRenderedLines` counts `[data-line]`, **not** `[data-line-index]`. The
  latter also matches Pierre's line-number gutter cell and double-counts. The
  first version of this harness got that wrong.

Two measurement bugs were caught rather than reported as findings, both worth
remembering:

- Reusing one browser across all cells crashed the tab on the 5k cell. That
  would have read as *"the library falls over at 5k"*. It does not — the cell
  passes in isolation. `runCell` now launches a fresh browser per run.
- Editing a source file mid-run triggered Vite HMR during measurement. That run
  was discarded. Measure a static build, and do not touch `src/` while the
  matrix is running.

If you re-run the CodeView cells on a rebuilt bundle, keep the anchor cells
(`calibration-baseline`, the `pierre-virtual` crux cell) in the subset so you
can show the two datasets are comparable instead of assuming it.

## Layout

```
src/fixtures/generate.js   seeded synthetic patch generator (deterministic)
src/harness.js             frame timing, longtasks, shadow-DOM-aware counters
src/main.jsx               the four modes
src/fallback/              @tanstack/react-virtual + shiki worker prototype
bench/measure.mjs          Playwright driver, writes results/
```

The generator builds patches from an explicit op list, so `@@` hunk headers are
correct by construction rather than by a diff algorithm we would have to trust.
Same seed → byte-identical patch → comparable numbers across runs.

## Pinned versions and one deviation

`~/.npmrc` sets a rolling 7-day `before` cooldown (supply-chain hygiene). That
window excluded `@pierre/diffs` 1.3.2. **This spike measures 1.3.0-rc.1**
(2026-07-24), the newest 1.3.x inside the window. The cooldown was respected,
not bypassed. Re-run after it expires to confirm on 1.3.2.

Installed: `@pierre/diffs` 1.3.0-rc.1 · `shiki` 4.3.1 · `react` 19.2.0 ·
`@tanstack/react-virtual` 3.14.8 · `vite` 8.1.5 · `playwright` 1.62.0.

**`@pierre/theme` must be installed explicitly at the top level.**
`@pierre/theming@1.0.0` declares a `peerOptional` on `@pierre/theme@^1.1.0`
while `@pierre/diffs` pins `2.0.0`, so npm nests the copy under
`@pierre/diffs/node_modules` where hoisted `@pierre/theming` cannot resolve it.
The failure mode is a runtime `Could not resolve "@pierre/theme/pierre-dark"`,
not an install error.

Measured on: Apple M5 Pro, 15 cores, macOS 26.5.2, Chromium 1234 (headed),
120Hz display.
