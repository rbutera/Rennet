# Brand asset provenance

## The mark

The mark originates in `sources/liquid-sphere/index.html`, a WebGL master that renders the sphere and its ripple. Everything else is derived from it, so the identity has one author.

- `brand/scripts/gen-mark-svgs.py` writes the three static marks — `sources/mark-sphere.svg` (colour), `sources/mark-ridged.svg` and `sources/mark-ridged-small.svg` (monochrome). It evaluates the master's own `ring()` ridge function, so the silhouette is the shader's outline rather than a redraw of it. The colour mark's gradient stops are the master's resting `LOOK` palette.
- `brand/scripts/render-sphere.mjs` drives the master headlessly and writes every file in `exports/sphere/`: the `mark-resting-1024.png` and `mark-working-1024.png` stills and the animated loops. Each sequence renders one extra frame at `t = loop` and proves it matches frame 0, with the frame 0 to frame 1 difference printed as a control.
- The colour application icon composites `exports/sphere/mark-resting-1024.png` — the shader's own frame, not an approximation of it — on the `#ecdfcf` ground squircle. The monochrome application icons contain no raster artwork.

No font file and no traced raster is involved in the mark.

## The wordmark

The production wordmark comes from option 3 in `sources/selected-wordmark-direction.png`. `sources/trace-reference-wordmark.png` is its thresholded raster, and `sources/wordmark-outline.svg` contains the production paths, traced with potrace. No font file is required at runtime.

## Regenerating

Run the four scripts in the order given in `README.md`. `scripts/build-brand-assets.py` rebuilds every export directory except `exports/sphere/`, which belongs to `render-sphere.mjs`, and rewrites `manifest.json` with the byte size and SHA-256 of every file in this package.
