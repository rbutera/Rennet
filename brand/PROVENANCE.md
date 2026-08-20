# Brand asset provenance

The production mark comes from `sources/selected-mark-direction.png`. `sources/trace-reference-mark.png` is the thresholded raster used for the vector trace. The production geometry lives in `sources/mark-master.svg`; the small-size geometry lives in `sources/mark-small.svg`.

The production wordmark comes from option 3 in `sources/selected-wordmark-direction.png`. `sources/trace-reference-wordmark.png` is its thresholded raster, and `sources/wordmark-outline.svg` contains the production paths. No font file is required at runtime.

The color application icon uses `sources/gradient-reference.png` behind the white vector mark. Monochrome application icons contain no generated raster artwork.

Run `python3 scripts/build-brand-assets.py` to regenerate exports and `manifest.json` from these committed sources.
