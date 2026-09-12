# Sidebar lockup prototypes

A throwaway spike answering one question: **where does a bigger Rennet mark go in the
sidebar, and how large is the floating orb when the sidebar is collapsed?**

Open `index.html` from disk. No build step, no network, no framework — the brand SVGs and
the Geist variable font are inlined.

## What is in the page

Four full-height 256px sidebar panels, in light and dark, with the real sidebar contents
reproduced from `packages/app-ui/src/shell/sidebar/sidebar.tsx`, `shell/corner-slot.tsx`,
`shell/sidebar/lockup.tsx` and `shell/top-bar.tsx`, and the palette, type ramp and radii
taken verbatim from `packages/theme/src/palette.css` + `theme.css`. The three macOS
traffic lights are drawn as coloured dots inside the real 81px reserve.

| | placement | mark | wordmark | rows |
|---|---|---|---|---|
| — | **Today (reference)** | 24 | 24 × 102.9 | 40px corner row only |
| 1 | **Own row** | 38 | 33.78 × 144.81 | 40px corner row + 56px lockup row |
| 2 | **Stacked header** | 52 | 26.12 × 112, centred | 40px corner row + 118px block |
| 3 | **Mark leads** | 40 | 18 × 77.17, beside | 40px corner row + 60px head row |

Below them, the collapsed state: the floating corner pill against the session top bar's
floating chip layer, in two options — orb 28px in today's 32px pill, and the pill grown to
36px for a 32px orb.

## Geometry

The authored horizontal lockup is mark `126×126` at the origin, a `24` gap, then the
wordmark `480.168×112` at `x=150, y=7`. So for a mark of height *M*: wordmark height
`M × 112/126`, wordmark width `height × 480.168/112`, gap `M × 24/126`. Placements 1–3 use
that authored ratio. **Today's row does not** — the app draws both halves at `size={24}`,
so the shipping wordmark is taller relative to the mark than the artwork is.

## Measured, not assumed

`PillToggle` overrides the kit `Toggle`'s `h-8` with `h-auto … px-2.5 py-1 text-xs`, so the
History / Map / Diff chips render **26px** tall, not 32px. Measured in the page:
`pill-chip 26, joined 26, icon-chip 32, floating pill 32`. The 32px neighbour in that layer
is the floating icon button (`size-8 rounded-full`), not the text chips.

## Not reproduced faithfully

- The mark is the **static** `brand/exports/logo/svg/mark-color.svg`, not the live
  `LiquidSphere` component. Same 100-unit disc geometry, no working/resting animation.
- Icons are hand-written lucide-shaped paths, close but not the real lucide geometry.
- Base UI behaviour (context menus, collapse, tooltips, roving focus) is absent; every
  control is inert.
- `UpdateControl` renders nothing until an update is ready, so the footer omits it.

## Files

- `index.html` — the deliverable, self-contained.
- `build.mjs` — regenerates `index.html`; inlines the SVGs and the font. It reads the brand
  SVGs from `/tmp/rennet-orb-lockup-assets/`, extracted from the `feat/liquid-sphere-live`
  branch with `git show`.
- `shot.mjs` — renders `preview-light.png` / `preview-dark.png` at 1600px via the repo's
  Playwright. Run from the repo root so `playwright` resolves.
