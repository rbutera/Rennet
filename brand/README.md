# Rennet brand pack

Rennet’s identity is a compact, shallow cheese wheel whose right edge breaks into smaller, readable pieces. The mark carries the product idea directly: a large body of code becomes something a person can digest.

This root-level directory is the canonical brand home for the monorepo. Agents should start here and treat `sources/` plus `exports/` as authoritative.

The primary identity is monochrome. The colour gradient is application-icon artwork, not a product-interface colour system.

## Use the right asset

- `exports/logo/svg/lockup-horizontal-*.svg` — default product, site, README, and document lockup.
- `exports/logo/svg/lockup-stacked-*.svg` — square or portrait placements.
- `exports/logo/svg/mark-*.svg` — large standalone mark.
- `exports/logo/svg/mark-small-*.svg` — simplified mark below 48 px.
- `exports/app-icons/masters/` — 1024 px master app icons and SVG sources.
- `exports/app-icons/macos/` — `.icns` files and source iconsets for all three variants.
- `exports/app-icons/windows/` — multi-resolution `.ico` files for all three variants.
- `exports/app-icons/linux/` — PNGs from 16 px through 1024 px.
- `exports/web/` — SVG/PNG/ICO favicons, Apple touch icon, PWA icons, and manifest.
- `exports/social/` — square colour and monochrome avatars.
- `preview/brand-pack-overview.png` — quick visual index.
- `preview/trace-fidelity.png` — selected raster artwork beside the production traces.
- `manifest.json` — dimensions, byte sizes, and SHA-256 checksums for every file.

## Usage rules

Use the horizontal lockup whenever the name must be readable. Use the standalone mark only when the surrounding context already says Rennet.

Keep clear space around a lockup equal to at least the height of the lowercase `n`. Do not compress, rotate, redraw, add a container, or alter the fragment pattern.

Use `mark-small` at 16–47 px. Use the full mark from 48 px upward. Do not use the horizontal lockup below 140 px wide.

Use black artwork on light backgrounds and white artwork on dark backgrounds. The colour app icon uses the white mark and is the default packaged application icon; the two monochrome icons are first-class alternates.

## Regeneration

The committed mark and wordmark are exact monochrome traces of the selected concept artwork. They require no font at runtime.

To rebuild every export from the committed vector sources:

```sh
python3 scripts/build-brand-assets.py
```

The builder requires Python with Pillow, ImageMagick, and macOS `iconutil`.
