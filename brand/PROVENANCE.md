# Brand asset provenance

The selected concept references are preserved under `sources/selected-mark-direction.png` and `sources/selected-wordmark-direction.png`. They are concept evidence only; no production export embeds either raster image.

The production mark is traced directly from the largest isolated mark in the selected dissolving cheese-wheel concept, then compressed horizontally to 80% to improve its balance beside the wordmark and inside an app-icon tile. `trace-reference-mark.png` preserves the exact thresholded input. The small-size mark is a trace of that same artwork reduced before applying the same 80% width, which naturally removes particles that cannot survive at favicon size.

The wordmark is traced directly from the largest option 3 lettering in the selected wordmark sheet. `trace-reference-wordmark.png` preserves the exact thresholded input. It is committed as paths in `sources/wordmark-outline.svg`; no substitute font was used and no font file is required at runtime.

The colour application icon uses the generated optical-gradient reference at `sources/gradient-reference.png`, cropped and composited deterministically with the exact vector mark in solid white. The monochrome variants contain no generated raster content.

Run `python3 scripts/build-brand-assets.py` to reproduce the export pack and `manifest.json` checksums from the committed sources.
