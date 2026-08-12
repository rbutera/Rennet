#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand"
SOURCES = BRAND / "sources"
EXPORTS = BRAND / "exports"
LOGOS = EXPORTS / "logo" / "svg"
APP_ICONS = EXPORTS / "app-icons"
WEB = EXPORTS / "web"
SOCIAL = EXPORTS / "social"
PREVIEW = BRAND / "preview"

INK = "#0B0D10"
PAPER = "#F7F4EE"
WHITE = (255, 255, 255)


@dataclass(frozen=True)
class Vector:
    width: float
    height: float
    body: str


def run(*command: str) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


def write_text(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def read_vector(path: Path) -> Vector:
    raw = path.read_text(encoding="utf-8")
    view_box = re.search(r'viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"', raw)
    body = re.search(r'(<g\b.*</g>)', raw, re.DOTALL)
    if not view_box or not body:
        raise RuntimeError(f"{path} is not a traced SVG in the expected format")
    return Vector(float(view_box.group(1)), float(view_box.group(2)), body.group(1))


def recolor(body: str, color: str) -> str:
    return re.sub(r'fill="#[0-9A-Fa-f]{6}"', f'fill="{color}"', body, count=1)


def svg_document(vector: Vector, color: str, label: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vector.width:.6f} {vector.height:.6f}" role="img" aria-label="{label}">
{recolor(vector.body, color)}
</svg>
'''


def nested(vector: Vector, x: float, y: float, width: float, height: float, color: str) -> str:
    return f'''<g transform="translate({x:.3f} {y:.3f}) scale({width / vector.width:.8f} {height / vector.height:.8f})">
{recolor(vector.body, color)}
</g>'''


def prepare_output() -> None:
    for path in (EXPORTS, PREVIEW):
        if path.exists():
            shutil.rmtree(path)
    for path in (LOGOS, APP_ICONS, WEB, SOCIAL, PREVIEW):
        path.mkdir(parents=True, exist_ok=True)


def build_vector_exports(mark: Vector, small_mark: Vector, wordmark: Vector) -> None:
    for name, color in (("black", INK), ("white", PAPER)):
        write_text(LOGOS / f"mark-{name}.svg", svg_document(mark, color, "Rennet mark"))
        write_text(LOGOS / f"mark-small-{name}.svg", svg_document(small_mark, color, "Rennet mark"))
        write_text(LOGOS / f"wordmark-{name}.svg", svg_document(wordmark, color, "Rennet"))

        mark_height = 126.0
        mark_width = mark_height * mark.width / mark.height
        word_height = 112.0
        word_width = word_height * wordmark.width / wordmark.height
        gap = 24.0
        lockup_height = max(mark_height, word_height)
        lockup_width = mark_width + gap + word_width
        horizontal = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {lockup_width:.3f} {lockup_height:.3f}" role="img" aria-label="Rennet">
{nested(mark, 0, (lockup_height - mark_height) / 2, mark_width, mark_height, color)}
{nested(wordmark, mark_width + gap, (lockup_height - word_height) / 2, word_width, word_height, color)}
</svg>
'''
        write_text(LOGOS / f"lockup-horizontal-{name}.svg", horizontal)

        stacked_mark_width = 330.0
        stacked_mark_height = stacked_mark_width * mark.height / mark.width
        stacked_word_width = 420.0
        stacked_word_height = stacked_word_width * wordmark.height / wordmark.width
        stacked_gap = 38.0
        stacked_height = stacked_mark_height + stacked_gap + stacked_word_height
        stacked = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {stacked_word_width:.3f} {stacked_height:.3f}" role="img" aria-label="Rennet">
{nested(mark, (stacked_word_width - stacked_mark_width) / 2 + 20, 0, stacked_mark_width, stacked_mark_height, color)}
{nested(wordmark, 0, stacked_mark_height + stacked_gap, stacked_word_width, stacked_word_height, color)}
</svg>
'''
        write_text(LOGOS / f"lockup-stacked-{name}.svg", stacked)


def monochrome_icon(mark: Vector, background: str, foreground: str) -> str:
    mark_height = 350.0
    mark_width = mark_height * mark.width / mark.height
    optical_shift = 44.0
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Rennet app icon">
  <rect x="32" y="32" width="960" height="960" rx="214" fill="{background}"/>
{nested(mark, (1024 - mark_width) / 2 + optical_shift, (1024 - mark_height) / 2, mark_width, mark_height, foreground)}
</svg>
'''


def color_icon_svg(mark: Vector) -> str:
    encoded = base64.b64encode((SOURCES / "gradient-reference.png").read_bytes()).decode("ascii")
    mark_height = 350.0
    mark_width = mark_height * mark.width / mark.height
    x = (1024 - mark_width) / 2 + 44
    y = (1024 - mark_height) / 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Rennet app icon">
  <defs>
    <clipPath id="squircle"><rect x="32" y="32" width="960" height="960" rx="214"/></clipPath>
  </defs>
  <image x="32" y="32" width="960" height="960" preserveAspectRatio="xMidYMid slice" clip-path="url(#squircle)" href="data:image/png;base64,{encoded}"/>
  <rect x="32" y="32" width="960" height="960" rx="214" fill="#080B2A" fill-opacity=".42"/>
  <rect x="33" y="33" width="958" height="958" rx="213" fill="none" stroke="#FFFFFF" stroke-opacity=".18" stroke-width="2"/>
  <g opacity=".25" transform="translate(0 20)">{nested(mark, x, y, mark_width, mark_height, "#090B25")}</g>
  {nested(mark, x, y, mark_width, mark_height, "#FFFFFF")}
</svg>
'''


def render_svg(source: Path, destination: Path, size: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run("magick", "-background", "none", "-density", "192", str(source), "-resize", f"{size}x{size}", f"PNG32:{destination}")


def build_color_master(mark_source: Path, destination: Path) -> None:
    background_rgb = Image.open(SOURCES / "gradient-reference.png").convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
    background_rgb = ImageEnhance.Brightness(background_rgb).enhance(0.62)
    background_rgb = ImageEnhance.Contrast(background_rgb).enhance(1.08)
    background = background_rgb.convert("RGBA")
    squircle = Image.new("L", (1024, 1024), 0)
    ImageDraw.Draw(squircle).rounded_rectangle((32, 32, 992, 992), radius=214, fill=255)
    background.putalpha(squircle)

    temporary = APP_ICONS / "masters" / ".mark.png"
    run("magick", "-background", "none", "-density", "192", str(mark_source), "-resize", "x350", f"PNG32:{temporary}")
    mark = Image.open(temporary).convert("RGBA")
    alpha = mark.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise RuntimeError("mark rendered without visible pixels")
    mark = mark.crop(bbox)
    alpha = mark.getchannel("A")

    white = Image.new("RGBA", mark.size, (*WHITE, 0))
    white.putalpha(alpha)

    x = (1024 - mark.width) // 2 + 44
    y = (1024 - mark.height) // 2 - 4
    shadow_alpha = alpha.filter(ImageFilter.GaussianBlur(20)).point(lambda value: round(value * 0.42))
    shadow = Image.new("RGBA", mark.size, (8, 9, 32, 0))
    shadow.putalpha(shadow_alpha)
    background.alpha_composite(shadow, (x, y + 22))
    background.alpha_composite(white, (x, y))
    highlight = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ImageDraw.Draw(highlight).rounded_rectangle((34, 34, 990, 990), radius=212, outline=(255, 255, 255, 46), width=2)
    background.alpha_composite(highlight)
    background.save(destination, optimize=True)
    temporary.unlink(missing_ok=True)


def build_icon_exports(mark: Vector, small_mark: Vector) -> None:
    masters = APP_ICONS / "masters"
    masters.mkdir(parents=True, exist_ok=True)
    (APP_ICONS / "windows").mkdir(parents=True, exist_ok=True)
    black_svg = masters / "app-icon-black-on-white.svg"
    white_svg = masters / "app-icon-white-on-black.svg"
    color_svg = masters / "app-icon-color.svg"
    compact_black_svg = masters / "app-icon-black-on-white-small.svg"
    compact_white_svg = masters / "app-icon-white-on-black-small.svg"
    write_text(black_svg, monochrome_icon(mark, PAPER, INK))
    write_text(white_svg, monochrome_icon(mark, INK, PAPER))
    write_text(color_svg, color_icon_svg(mark))
    write_text(compact_black_svg, monochrome_icon(small_mark, PAPER, INK))
    write_text(compact_white_svg, monochrome_icon(small_mark, INK, PAPER))
    render_svg(black_svg, masters / "app-icon-black-on-white-1024.png", 1024)
    render_svg(white_svg, masters / "app-icon-white-on-black-1024.png", 1024)
    build_color_master(LOGOS / "mark-black.svg", masters / "app-icon-color-1024.png")
    render_svg(compact_black_svg, masters / ".app-icon-black-on-white-small.png", 1024)
    render_svg(compact_white_svg, masters / ".app-icon-white-on-black-small.png", 1024)
    build_color_master(LOGOS / "mark-small-black.svg", masters / ".app-icon-color-small.png")

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

    favicon = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Rennet">
{nested(small_mark, 2, 28, 96, 43, INK)}
</svg>
'''
    write_text(WEB / "favicon.svg", favicon)

    for temporary in masters.glob(".app-icon-*-small.png"):
        temporary.unlink()


def build_web_and_social() -> None:
    masters = APP_ICONS / "masters"
    black = masters / "app-icon-black-on-white-1024.png"
    color = masters / "app-icon-color-1024.png"
    for size in (16, 32, 48):
        render_svg(WEB / "favicon.svg", WEB / f"favicon-{size}x{size}.png", size)
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
        "theme_color": "#11143B",
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
    draw.text((90, 124), "20% narrower selected mark · exact option 3 lettering · app icons", fill="#555B65", font=preview_font(24))
    lockup_png = PREVIEW / ".lockup.png"
    run("magick", "-background", "none", "-density", "192", str(LOGOS / "lockup-horizontal-black.svg"), "-resize", "1280x300", f"PNG32:{lockup_png}")
    lockup = Image.open(lockup_png).convert("RGBA")
    canvas.paste(lockup, ((1800 - lockup.width) // 2, 220), lockup)
    labels = (("black-on-white", "Black on white"), ("white-on-black", "White on black"), ("color", "Colour gradient"))
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
    lockup_png.unlink(missing_ok=True)


def build_trace_qa() -> None:
    canvas = Image.new("RGB", (1600, 900), "#E8E8E8")
    draw = ImageDraw.Draw(canvas)
    draw.text((70, 44), "Trace fidelity", fill=INK, font=preview_font(46))
    draw.text((70, 105), "Selected artwork on the left · 20% narrower production SVG on the right", fill="#555B65", font=preview_font(23))
    draw.text((70, 180), "Selected artwork", fill=INK, font=preview_font(22))
    draw.text((830, 180), "Production SVG", fill=INK, font=preview_font(22))

    mark_reference = Image.open(SOURCES / "trace-reference-mark.png").convert("RGB").resize((650, 294), Image.Resampling.NEAREST)
    mark_vector_path = PREVIEW / ".mark-vector.png"
    word_vector_path = PREVIEW / ".word-vector.png"
    run("magick", "-background", "white", "-density", "192", str(LOGOS / "mark-black.svg"), "-resize", "650x294", str(mark_vector_path))
    run("magick", "-background", "white", "-density", "192", str(LOGOS / "wordmark-black.svg"), "-resize", "650x160", str(word_vector_path))
    canvas.paste(mark_reference, (70, 220))
    canvas.paste(Image.open(mark_vector_path).convert("RGB"), (830, 220))

    word_reference = Image.open(SOURCES / "trace-reference-wordmark.png").convert("RGB").resize((650, 151), Image.Resampling.NEAREST)
    canvas.paste(word_reference, (70, 640))
    canvas.paste(Image.open(word_vector_path).convert("RGB"), (830, 635))
    canvas.save(PREVIEW / "trace-fidelity.png", optimize=True)
    mark_vector_path.unlink(missing_ok=True)
    word_vector_path.unlink(missing_ok=True)


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
    mark = read_vector(SOURCES / "mark-master.svg")
    small_mark = read_vector(SOURCES / "mark-small.svg")
    wordmark = read_vector(SOURCES / "wordmark-outline.svg")
    build_vector_exports(mark, small_mark, wordmark)
    build_icon_exports(mark, small_mark)
    build_web_and_social()
    build_preview()
    build_trace_qa()
    build_manifest()


if __name__ == "__main__":
    main()
