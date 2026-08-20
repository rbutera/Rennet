# Rennet brand assets

Rennet's mark is a shallow cheese wheel whose right edge breaks into smaller pieces. The shape represents a large body of code becoming readable parts.

This directory is the canonical brand package. Production sources live in `sources/`, generated assets live in `exports/`, and `manifest.json` records each file's byte size and SHA-256 checksum.

The main identity is monochrome. The gradient appears only in the color application icon.

## Choose an asset

- `exports/logo/svg/lockup-horizontal-*.svg` for product pages, sites, READMEs, and documents
- `exports/logo/svg/lockup-stacked-*.svg` for square or portrait placements
- `exports/logo/svg/mark-*.svg` for a large mark when the surrounding context already names Rennet
- `exports/logo/svg/mark-small-*.svg` below 48px
- `exports/app-icons/masters/` for the 1024px application-icon masters and SVG sources
- `exports/app-icons/macos/` for `.icns` files and source iconsets
- `exports/app-icons/windows/` for multi-resolution `.ico` files
- `exports/app-icons/linux/` for PNGs from 16px through 1024px
- `exports/web/` for favicons, the Apple touch icon, PWA icons, and the web manifest
- `exports/tray/` for desktop tray and menu-bar icons
- `exports/social/` for square color and monochrome avatars
- `preview/brand-pack-overview.png` for a visual index
- `preview/trace-fidelity.png` for the raster references beside their production traces

## Usage

Use a horizontal lockup when the name needs to be readable. Use the mark alone only when nearby copy already identifies Rennet.

Keep clear space around a lockup equal to the height of the lowercase `n`. Do not compress, rotate, redraw, frame, or change the fragment pattern.

Use `mark-small` from 16px through 47px and the full mark at 48px or larger. Do not use the horizontal lockup below 140px wide.

Use black artwork on light backgrounds and white artwork on dark backgrounds. The packaged application uses the white-on-black icon. The color and black-on-white icons are available alternatives.

## Rebuild exports

Run:

```sh
python3 scripts/build-brand-assets.py
```

The builder requires Python, Pillow, ImageMagick, and macOS `iconutil`. It rebuilds the export directories, previews, and `manifest.json` from the committed vector sources.

## Tray and menu-bar icons

Regenerate tray assets with:

```sh
node brand/scripts/gen-tray-icons.mjs
```

The script uses the workspace `sharp` dependency and the committed SVG exports.

- macOS template images use the wide small mark at 16px and 32px. macOS applies the menu-bar color.
- Windows `.ico` files contain the square white-on-black mark at several resolutions.
- Linux PNGs use the same square white-on-black mark at 32px and 64px.
- Update-ready variants add a dot to the normal asset. On macOS the dot remains monochrome.
