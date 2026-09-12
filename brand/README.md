# Rennet brand assets

Rennet's mark is a liquid sphere: a warm gradient body — yellow at the top (`#f3b437`), orange through the middle (`#e8641f`), red at the bottom (`#d42c3b`) — resting on a warm ground (`#ecdfcf`). It ripples while the app is working and settles when it is done. The shape is a whole body of change that Rennet is turning over, not a diagram of one.

This directory is the canonical brand package. Production sources live in `sources/`, generated assets live in `exports/`, and `manifest.json` records each file's byte size and SHA-256 checksum.

## Colour and monochrome

The identity is **colour first**. The sphere is the mark wherever colour is available: app icons, the favicon, the lockups, the marketing and documentation sites.

Where a surface is monochrome by contract — a macOS menu-bar template image, a stencil, a one-ink print — use the **ridged mark** instead. It is the same sphere seen as a silhouette, with the ripple creases cut through it, drawn in a single ink so it recolours cleanly. `mark-small-*` carries three deep ridges for 16-32 px; `mark-*` carries six for 48 px and up.

Do not recolour the colour sphere, and do not simulate it with a filter over the monochrome mark. Use the monochrome mark when you need one ink.

## Choose an asset

- `exports/logo/svg/lockup-horizontal-black.svg` / `-white.svg` for product pages, sites, READMEs, and documents. Both carry the **colour** sphere; `black`/`white` names the wordmark ink — black for light backgrounds, white for dark ones
- `exports/logo/svg/lockup-stacked-black.svg` / `-white.svg` for square or portrait placements
- `exports/logo/svg/lockup-horizontal-mono-*.svg` and `lockup-stacked-mono-*.svg` when the whole lockup has to be one ink
- `exports/logo/svg/mark-color.svg` for the mark alone wherever colour is available
- `exports/logo/svg/mark-black.svg` / `mark-white.svg` for the monochrome mark at 48 px and up
- `exports/logo/svg/mark-small-black.svg` / `mark-small-white.svg` for the monochrome mark from 16 px to 47 px
- `exports/sphere/mark-resting-1024.png` and `mark-working-1024.png` for the shader's own still frames, and the `*-loop-*.webp` / `.webm` files for the animated ripple — produced by `node brand/scripts/render-sphere.mjs`, not by the asset builder
- `exports/app-icons/masters/` for the 1024 px application-icon masters and their SVG sources
- `exports/app-icons/macos/` for `.icns` files and source iconsets
- `exports/app-icons/windows/` for multi-resolution `.ico` files
- `exports/app-icons/linux/` for PNGs from 16 px through 1024 px
- `exports/app-icons/platform/` for the packaged application's three icon files
- `exports/web/` for favicons, the Apple touch icon, PWA icons, and the web manifest
- `exports/tray/` for desktop tray and menu-bar icons
- `exports/social/` for square colour and monochrome avatars
- `preview/brand-pack-overview.png` for a visual index

## Usage

Use a horizontal lockup when the name needs to be readable. Use the mark alone only when nearby copy already identifies Rennet.

Keep clear space around a lockup equal to the height of the lowercase `n`. Do not compress, rotate, redraw, or reframe the sphere, and do not change its gradient.

The colour mark reads down to 16 px. Use `mark-small` for the monochrome mark from 16 px through 47 px and the full monochrome mark at 48 px or larger. Do not use the horizontal lockup below 140 px wide.

The packaged application uses the colour icon. The black-on-white and white-on-black icons are available alternatives for monochrome contexts.

## Rebuild

The four scripts run in this order. Each one reads what the previous one wrote.

```sh
python3 brand/scripts/gen-mark-svgs.py     # sources/mark-sphere.svg, mark-ridged.svg, mark-ridged-small.svg
node brand/scripts/render-sphere.mjs       # exports/sphere/ (stills and animated loops)
python3 scripts/build-brand-assets.py      # exports/logo, app-icons, web, social; preview; manifest.json
node brand/scripts/gen-tray-icons.mjs      # exports/tray/
```

`gen-mark-svgs.py` authors the static marks from the same ridge function the animated master uses, so the silhouette is the shader's outline rather than a drawing of it. `render-sphere.mjs` is the only writer of `exports/sphere/`; `build-brand-assets.py` rebuilds every other export directory and deliberately leaves `exports/sphere/` alone.

`build-brand-assets.py` clears `exports/` first, which removes `exports/tray/` as well, so it runs the tray generator itself before hashing the package — otherwise `manifest.json` would permanently omit ten shipped files. The generator is deterministic, so running it again by hand reproduces exactly what the manifest recorded.

Both mark SVGs depend on gradients, clip paths, and a mask. ImageMagick's internal SVG renderer silently drops all three, so every SVG rasterisation goes through `brand/scripts/rasterise-svg.mjs`, which renders through Chromium:

```sh
node brand/scripts/rasterise-svg.mjs <in.svg> <out.png> <size> [background|transparent]
```

### Toolchain

- **Python 3** with **Pillow** — `gen-mark-svgs.py` and `build-brand-assets.py`
- **Node** with the workspace's Playwright Chromium — `rasterise-svg.mjs`, `render-sphere.mjs`, `gen-tray-icons.mjs` (which uses the workspace `sharp`)
- **ImageMagick** (`magick`) — `.ico` packing and the loop-seam proof
- **`iconutil`** (macOS) — `.icns` assembly
- **ffmpeg** — the animated WebP and WebM loops

`render-sphere.mjs` pulls three.js over the network and prefers the GPU; see its header for the `--software` and `--only` flags.

## Tray and menu-bar icons

Regenerate tray assets with:

```sh
node brand/scripts/gen-tray-icons.mjs
```

The script uses the workspace `sharp` dependency and the committed SVG exports, so it runs after `build-brand-assets.py`.

- macOS template images use the square small monochrome mark at 16 px and 32 px. macOS applies the menu-bar colour.
- Windows `.ico` files contain the square white-on-black icon at several resolutions.
- Linux PNGs use the same square white-on-black icon at 32 px and 64 px.
- Update-ready variants add a dot to the normal asset. The round mark fills its box in every direction, so the template variants shrink the mark toward the bottom-left to clear space for the dot; without that the dot merges with the silhouette and reads as a bump. On macOS the dot stays monochrome.
