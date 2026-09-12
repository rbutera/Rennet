#!/usr/bin/env python3
"""Build every Rennet brand export from the committed vector and raster sources.

Sources in, exports + manifest out. The identity is the liquid sphere:

  sources/mark-sphere.svg        the COLOUR mark (gradients on a wobbly disc)
  sources/mark-ridged.svg        the MONOCHROME mark (one fill, creases cut by a mask)
  sources/mark-ridged-small.svg  the mono mark with three ridges, for 16-32 px
  sources/wordmark-outline.svg   the wordmark paths
  exports/sphere/mark-resting-1024.png  the shader's own resting frame (colour raster master)

`exports/sphere/` is written by `brand/scripts/render-sphere.mjs`, not by this
script, so it is the one export directory this script never deletes.

Every SVG rasterisation goes through `brand/scripts/rasterise-svg.mjs` (Chromium):
ImageMagick's internal MSVG renderer silently drops gradients, masks and clip
paths, and both marks depend on all three. `magick` is still used to pack PNGs
into `.ico` containers, which is a container format job, not a rendering one.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand"
SOURCES = BRAND / "sources"
EXPORTS = BRAND / "exports"
LOGOS = EXPORTS / "logo" / "svg"
APP_ICONS = EXPORTS / "app-icons"
SPHERE = EXPORTS / "sphere"
WEB = EXPORTS / "web"
SOCIAL = EXPORTS / "social"
PREVIEW = BRAND / "preview"
RASTERISE = BRAND / "scripts" / "rasterise-svg.mjs"

INK = "#0B0D10"
PAPER = "#F7F4EE"
GROUND = "#ecdfcf"
SPHERE_MID = "#e8641f"

# Lockup geometry. The mark is square now, so its width is its height.
MARK_HEIGHT = 126.0
WORDMARK_HEIGHT = 112.0
LOCKUP_GAP = 24.0
STACKED_MARK = 200.0
STACKED_WORDMARK_WIDTH = 420.0
STACKED_GAP = 38.0

# App-icon tile: a 960 px squircle inset in a 1024 px canvas, as every platform expects.
TILE = 1024
TILE_INSET = 32
TILE_SIZE = TILE - TILE_INSET * 2
TILE_RADIUS = 214
# Every icon size below is the size of the DRAWN ARTWORK, not of the box it is nested in.
# The marks do not fill their own 100x100 viewBox — the sphere's wobble leaves a few units
# of slack on each side — so nesting a mark in a 560-high box draws a 521-high sphere. Sizes
# are divided by the mark's measured extent (`art_fraction`) so "560" means 560 px of sphere.
COLOR_MARK_FRACTION = 0.72
COLOR_COMPACT_FRACTION = 0.80
# One height for both ring counts: the compact mark is more legible because it has three
# deep ridges instead of six, not because it is drawn larger, and the tray's update dot has
# to clear the same silhouette in both.
MONO_MARK_HEIGHT = 560.0


@dataclass(frozen=True)
class Vector:
    width: float
    height: float
    body: str
    # The authored fill this artwork is recoloured through. `mark-ridged.svg` carries a
    # mask built from #ffffff/#000000, so recolouring by "the first hex fill" would paint
    # the mask instead of the mark; the exact source fill is named here on purpose.
    ink: str | None


def run(*command: str) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


def write_text(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def read_vector(path: Path, ink: str | None) -> Vector:
    raw = path.read_text(encoding="utf-8")
    view_box = re.search(r'viewBox="[\d.eE+-]+ [\d.eE+-]+ ([\d.eE+-]+) ([\d.eE+-]+)"', raw)
    open_tag = re.search(r"<svg\b[^>]*>", raw, re.DOTALL)
    if not view_box or not open_tag or "</svg>" not in raw:
        raise RuntimeError(f"{path} is not an SVG with a viewBox")
    body = raw[open_tag.end() : raw.rindex("</svg>")]
    body = re.sub(r"<metadata>.*?</metadata>", "", body, flags=re.DOTALL)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL).strip()
    if ink and f'fill="{ink}"' not in body:
        raise RuntimeError(f"{path} does not carry the authored fill {ink}")
    return Vector(float(view_box.group(1)), float(view_box.group(2)), body, ink)


def recolor(vector: Vector, color: str | None) -> str:
    if color is None or vector.ink is None:
        return vector.body
    return vector.body.replace(f'fill="{vector.ink}"', f'fill="{color}"')


def namespace_ids(body: str, prefix: str) -> str:
    """Rename every id and its url(#…) references so two marks can share one document."""
    for name in dict.fromkeys(re.findall(r'\bid="([^"]+)"', body)):
        body = body.replace(f'id="{name}"', f'id="{prefix}{name}"')
        body = body.replace(f"url(#{name})", f"url(#{prefix}{name})")
    return body


def svg_document(vector: Vector, color: str | None, label: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vector.width:.6f} {vector.height:.6f}" role="img" aria-label="{label}">
{recolor(vector, color)}
</svg>
'''


def nested(
    vector: Vector,
    x: float,
    y: float,
    width: float,
    height: float,
    color: str | None = None,
    prefix: str = "",
) -> str:
    body = recolor(vector, color)
    if prefix:
        body = namespace_ids(body, prefix)
    return f'''<g transform="translate({x:.3f} {y:.3f}) scale({width / vector.width:.8f} {height / vector.height:.8f})">
{body}
</g>'''


def prepare_output() -> None:
    # exports/sphere/ is render-sphere.mjs's output, not ours: never delete it.
    if EXPORTS.exists():
        for child in EXPORTS.iterdir():
            if child == SPHERE:
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    if PREVIEW.exists():
        shutil.rmtree(PREVIEW)
    for path in (LOGOS, APP_ICONS, WEB, SOCIAL, PREVIEW):
        path.mkdir(parents=True, exist_ok=True)


def rasterise(source: Path, destination: Path, size: int, background: str = "transparent") -> None:
    """Render an SVG through Chromium at `size` px. Non-square art is fitted, not stretched:
    the viewBox's own preserveAspectRatio letterboxes it inside the square viewport."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    run("node", str(RASTERISE), str(source), str(destination), str(size), background)


_ART_FRACTION: dict[Path, float] = {}


def art_fraction(source: Path) -> float:
    """How much of its own viewBox a mark actually draws, as a fraction of the longer side.

    Measured by rendering rather than by reading the path, because the marks are clipped and
    masked: what the viewer sees is not what the coordinates say. Cached per source — three
    renders per build.
    """
    if source not in _ART_FRACTION:
        scratch = PREVIEW / ".extent.png"
        rasterise(source, scratch, 512)
        with Image.open(scratch) as image:
            bbox = image.convert("RGBA").getchannel("A").getbbox()
        scratch.unlink(missing_ok=True)
        if bbox is None:
            raise RuntimeError(f"{source} rendered without visible pixels")
        _ART_FRACTION[source] = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 512
    return _ART_FRACTION[source]


def rasterise_fit(source: Path, size: int) -> Image.Image:
    """Render an SVG at `size` px and crop the transparent letterboxing away."""
    scratch = PREVIEW / ".raster.png"
    rasterise(source, scratch, size)
    image = Image.open(scratch).convert("RGBA")
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise RuntimeError(f"{source} rendered without visible pixels")
    image = image.crop(bbox)
    scratch.unlink(missing_ok=True)
    return image


def build_vector_exports(sphere: Vector, ridged: Vector, small: Vector, wordmark: Vector) -> None:
    write_text(LOGOS / "mark-color.svg", svg_document(sphere, None, "Rennet mark"))
    for name, color in (("black", INK), ("white", PAPER)):
        write_text(LOGOS / f"mark-{name}.svg", svg_document(ridged, color, "Rennet mark"))
        write_text(LOGOS / f"mark-small-{name}.svg", svg_document(small, color, "Rennet mark"))
        write_text(LOGOS / f"wordmark-{name}.svg", svg_document(wordmark, color, "Rennet"))

        word_width = WORDMARK_HEIGHT * wordmark.width / wordmark.height
        stacked_word_height = STACKED_WORDMARK_WIDTH * wordmark.height / wordmark.width

        # `black`/`white` names the WORDMARK ink. The default lockups carry the colour
        # sphere on both; the `-mono-` lockups carry the ridged mark in the same ink.
        for kind, mark, mark_color in (("", sphere, None), ("mono-", ridged, color)):
            lockup_width = MARK_HEIGHT + LOCKUP_GAP + word_width
            horizontal = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {lockup_width:.3f} {MARK_HEIGHT:.3f}" role="img" aria-label="Rennet">
{nested(mark, 0, 0, MARK_HEIGHT, MARK_HEIGHT, mark_color, "m-")}
{nested(wordmark, MARK_HEIGHT + LOCKUP_GAP, (MARK_HEIGHT - WORDMARK_HEIGHT) / 2, word_width, WORDMARK_HEIGHT, color, "w-")}
</svg>
'''
            write_text(LOGOS / f"lockup-horizontal-{kind}{name}.svg", horizontal)

            stacked_height = STACKED_MARK + STACKED_GAP + stacked_word_height
            stacked = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {STACKED_WORDMARK_WIDTH:.3f} {stacked_height:.3f}" role="img" aria-label="Rennet">
{nested(mark, (STACKED_WORDMARK_WIDTH - STACKED_MARK) / 2, 0, STACKED_MARK, STACKED_MARK, mark_color, "m-")}
{nested(wordmark, 0, STACKED_MARK + STACKED_GAP, STACKED_WORDMARK_WIDTH, stacked_word_height, color, "w-")}
</svg>
'''
            write_text(LOGOS / f"lockup-stacked-{kind}{name}.svg", stacked)


def squircle(background: str) -> str:
    return f'  <rect x="{TILE_INSET}" y="{TILE_INSET}" width="{TILE_SIZE}" height="{TILE_SIZE}" rx="{TILE_RADIUS}" fill="{background}"/>'


def monochrome_icon(mark: Vector, source: Path, background: str, foreground: str, height: float) -> str:
    # `height` is the drawn sphere; the nesting box is larger by the mark's own slack.
    # The mark is symmetric, so it is centred with no optical shift.
    height = height / art_fraction(source)
    offset = (TILE - height) / 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TILE} {TILE}" role="img" aria-label="Rennet app icon">
{squircle(background)}
{nested(mark, offset, offset, height, height, foreground)}
</svg>
'''


def color_icon_svg(sphere: Vector, source: Path, fraction: float) -> str:
    # Sized on the drawn sphere so this vector icon matches the raster master, which is
    # composed from a bbox-cropped render.
    height = TILE_SIZE * fraction / art_fraction(source)
    offset = (TILE - height) / 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TILE} {TILE}" role="img" aria-label="Rennet app icon">
{squircle(GROUND)}
{nested(sphere, offset, offset, height, height)}
</svg>
'''


def build_color_master(destination: Path, fraction: float) -> None:
    """The colour icon master: the shader's resting frame on the warm ground squircle.

    The sphere comes from the render, not from mark-sphere.svg, so the shipped icon is
    the actual lit shader and not a flat approximation of it.
    """
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (TILE_INSET, TILE_INSET, TILE - TILE_INSET, TILE - TILE_INSET), radius=TILE_RADIUS, fill=255
    )
    ground = Image.new("RGBA", (TILE, TILE), GROUND)
    ground.putalpha(mask)
    tile.alpha_composite(ground)

    source = Image.open(SPHERE / "mark-resting-1024.png").convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if bbox is None:
        raise RuntimeError("the sphere render has no visible pixels")
    mark = source.crop(bbox)
    target = round(TILE_SIZE * fraction)
    scale = target / max(mark.width, mark.height)
    mark = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.Resampling.LANCZOS)

    x = (TILE - mark.width) // 2
    y = (TILE - mark.height) // 2
    # A soft warm contact shadow so the sphere sits on the ground rather than floating.
    shadow_alpha = mark.getchannel("A").filter(ImageFilter.GaussianBlur(26)).point(
        lambda value: round(value * 0.30)
    )
    shadow = Image.new("RGBA", mark.size, (122, 44, 30, 0))
    shadow.putalpha(shadow_alpha)
    shadow_layer = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    shadow_layer.alpha_composite(shadow, (x, y + 22))
    shadow_layer.putalpha(Image.composite(shadow_layer.getchannel("A"), Image.new("L", (TILE, TILE), 0), mask))
    tile.alpha_composite(shadow_layer)
    tile.alpha_composite(mark, (x, y))
    tile.save(destination, optimize=True)


def build_icon_exports(sphere: Vector, ridged: Vector, small: Vector) -> None:
    masters = APP_ICONS / "masters"
    masters.mkdir(parents=True, exist_ok=True)
    (APP_ICONS / "windows").mkdir(parents=True, exist_ok=True)
    black_svg = masters / "app-icon-black-on-white.svg"
    white_svg = masters / "app-icon-white-on-black.svg"
    color_svg = masters / "app-icon-color.svg"
    compact_black_svg = masters / "app-icon-black-on-white-small.svg"
    compact_white_svg = masters / "app-icon-white-on-black-small.svg"
    ridged_src = SOURCES / "mark-ridged.svg"
    small_src = SOURCES / "mark-ridged-small.svg"
    sphere_src = SOURCES / "mark-sphere.svg"
    write_text(black_svg, monochrome_icon(ridged, ridged_src, PAPER, INK, MONO_MARK_HEIGHT))
    write_text(white_svg, monochrome_icon(ridged, ridged_src, INK, PAPER, MONO_MARK_HEIGHT))
    write_text(color_svg, color_icon_svg(sphere, sphere_src, COLOR_MARK_FRACTION))
    write_text(compact_black_svg, monochrome_icon(small, small_src, PAPER, INK, MONO_MARK_HEIGHT))
    write_text(compact_white_svg, monochrome_icon(small, small_src, INK, PAPER, MONO_MARK_HEIGHT))
    rasterise(black_svg, masters / "app-icon-black-on-white-1024.png", TILE)
    rasterise(white_svg, masters / "app-icon-white-on-black-1024.png", TILE)
    build_color_master(masters / "app-icon-color-1024.png", COLOR_MARK_FRACTION)
    rasterise(compact_black_svg, masters / ".app-icon-black-on-white-small.png", TILE)
    rasterise(compact_white_svg, masters / ".app-icon-white-on-black-small.png", TILE)
    build_color_master(masters / ".app-icon-color-small.png", COLOR_COMPACT_FRACTION)

    variants = {
        "black-on-white": (masters / "app-icon-black-on-white-1024.png", masters / ".app-icon-black-on-white-small.png"),
        "white-on-black": (masters / "app-icon-white-on-black-1024.png", masters / ".app-icon-white-on-black-small.png"),
        "color": (masters / "app-icon-color-1024.png", masters / ".app-icon-color-small.png"),
    }
    linux_sizes = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
    iconset_sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for variant, (master, compact_master) in variants.items():
        linux = APP_ICONS / "linux" / variant
        linux.mkdir(parents=True, exist_ok=True)
        source = Image.open(master).convert("RGBA")
        compact_source = Image.open(compact_master).convert("RGBA")
        for size in linux_sizes:
            icon_source = compact_source if size <= 32 else source
            icon_source.resize((size, size), Image.Resampling.LANCZOS).save(linux / f"{size}x{size}.png", optimize=True)
        iconset = APP_ICONS / "macos" / f"rennet-{variant}.iconset"
        iconset.mkdir(parents=True, exist_ok=True)
        for filename, size in iconset_sizes.items():
            icon_source = compact_source if size <= 32 else source
            icon_source.resize((size, size), Image.Resampling.LANCZOS).save(iconset / filename, optimize=True)
        run("iconutil", "-c", "icns", str(iconset), "-o", str(APP_ICONS / "macos" / f"rennet-{variant}.icns"))
        ico_sources = [linux / f"{size}x{size}.png" for size in (16, 24, 32, 48, 64, 128, 256)]
        run("magick", *map(str, ico_sources), str(APP_ICONS / "windows" / f"rennet-{variant}.ico"))

    platform = APP_ICONS / "platform"
    platform.mkdir(parents=True, exist_ok=True)
    shutil.copy2(APP_ICONS / "macos" / "rennet-color.icns", platform / "rennet-color.icns")
    shutil.copy2(APP_ICONS / "windows" / "rennet-color.ico", platform / "rennet-color.ico")
    shutil.copy2(masters / "app-icon-color-1024.png", platform / "rennet-color.png")

    # The favicon IS the colour mark: a browser tab is a colour surface.
    shutil.copy2(LOGOS / "mark-color.svg", WEB / "favicon.svg")

    for temporary in masters.glob(".app-icon-*-small.png"):
        temporary.unlink()


def build_web_and_social() -> None:
    masters = APP_ICONS / "masters"
    black = masters / "app-icon-black-on-white-1024.png"
    color = masters / "app-icon-color-1024.png"
    for size in (16, 32, 48):
        rasterise(WEB / "favicon.svg", WEB / f"favicon-{size}x{size}.png", size)
    run("magick", str(WEB / "favicon-16x16.png"), str(WEB / "favicon-32x32.png"), str(WEB / "favicon-48x48.png"), str(WEB / "favicon.ico"))
    for destination, size in (
        (WEB / "apple-touch-icon.png", 180),
        (WEB / "icon-192.png", 192),
        (WEB / "icon-512.png", 512),
        (SOCIAL / "avatar-color-1024.png", 1024),
    ):
        Image.open(color).resize((size, size), Image.Resampling.LANCZOS).save(destination, optimize=True)
    Image.open(black).save(SOCIAL / "avatar-monochrome-1024.png", optimize=True)
    write_text(WEB / "site.webmanifest", json.dumps({
        "name": "Rennet",
        "short_name": "Rennet",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
        "theme_color": SPHERE_MID,
        "background_color": PAPER,
        "display": "standalone",
    }, indent=2) + "\n")


def preview_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def build_preview() -> None:
    canvas = Image.new("RGB", (1800, 1260), PAPER)
    draw = ImageDraw.Draw(canvas)
    draw.text((90, 58), "Rennet brand pack", fill=INK, font=preview_font(52))
    draw.text((90, 124), "the liquid sphere · colour mark, ridged monochrome mark, app icons", fill="#555B65", font=preview_font(24))
    lockup = rasterise_fit(LOGOS / "lockup-horizontal-black.svg", 1400)
    lockup = lockup.resize((1280, round(1280 * lockup.height / lockup.width)), Image.Resampling.LANCZOS)
    canvas.paste(lockup, ((1800 - lockup.width) // 2, 250), lockup)
    labels = (("color", "Colour"), ("black-on-white", "Black on white"), ("white-on-black", "White on black"))
    icon_size = 360
    gap = 80
    start_x = (1800 - icon_size * 3 - gap * 2) // 2
    for index, (name, label) in enumerate(labels):
        icon = Image.open(APP_ICONS / "masters" / f"app-icon-{name}-1024.png").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        x = start_x + index * (icon_size + gap)
        canvas.paste(icon, (x, 655), icon)
        box = draw.textbbox((0, 0), label, font=preview_font(24))
        draw.text((x + (icon_size - box[2] + box[0]) / 2, 1040), label, fill=INK, font=preview_font(24))
    canvas.save(PREVIEW / "brand-pack-overview.png", optimize=True)


def build_tray_icons() -> None:
    """Run the tray generator before the manifest is written.

    `prepare_output` clears exports/, tray icons included, and the manifest hashes every
    file under brand/ — so if the tray step only ever ran after this script, the committed
    manifest would be permanently missing ten shipped files. The generator is deterministic
    (same SVG in, same PNG bytes out), so running `node brand/scripts/gen-tray-icons.mjs`
    by hand afterwards still reproduces exactly what the manifest recorded.
    """
    run("node", str(BRAND / "scripts" / "gen-tray-icons.mjs"))


def build_manifest() -> None:
    assets = []
    for path in sorted(BRAND.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        data = path.read_bytes()
        item: dict[str, object] = {
            "path": str(path.relative_to(BRAND)),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        if path.suffix.lower() == ".png":
            with Image.open(path) as image:
                item["dimensions"] = f"{image.width}x{image.height}"
        assets.append(item)
    write_text(BRAND / "manifest.json", json.dumps({"brand": "Rennet", "assets": assets}, indent=2) + "\n")


def main() -> None:
    prepare_output()
    sphere = read_vector(SOURCES / "mark-sphere.svg", None)
    ridged = read_vector(SOURCES / "mark-ridged.svg", INK)
    small = read_vector(SOURCES / "mark-ridged-small.svg", INK)
    wordmark = read_vector(SOURCES / "wordmark-outline.svg", "#000000")
    build_vector_exports(sphere, ridged, small, wordmark)
    build_icon_exports(sphere, ridged, small)
    build_web_and_social()
    build_preview()
    build_tray_icons()
    build_manifest()


if __name__ == "__main__":
    main()
