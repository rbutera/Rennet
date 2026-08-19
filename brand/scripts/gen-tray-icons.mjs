// Rasterize the checked-in monochrome mark into tray/menu-bar icons (issue: tray-presence).
// sharp renders the committed SVG sources to alpha PNGs at exact pixel sizes — no browser,
// no new dependency (sharp already ships in the workspace). Electron's Tray takes a PNG
// NativeImage on every platform, so no .ico is produced.
//
//   node brand/scripts/gen-tray-icons.mjs
//
// macOS uses TEMPLATE images (alpha-only, black artwork) that adapt to the menu-bar theme;
// the glyph comes from mark-small-black.svg. Windows/Linux use the white-on-black SQUARE
// icon so the mark stays visible on any taskbar colour. The "update-ready" variant bakes a
// dot into the corner — the presence of the dot is the whole signal (template images are
// monochrome, so the dot is not a distinct colour on macOS; that is intended).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const brand = resolve(here, "..");
const OUT = resolve(brand, "exports/tray");

const markSvg = readFileSync(resolve(brand, "exports/logo/svg/mark-small-black.svg"), "utf8");
const squareSvg = readFileSync(
  resolve(brand, "exports/app-icons/masters/app-icon-white-on-black-small.svg"),
  "utf8",
);

// Inject a filled dot in the source viewBox coordinates, just before </svg>.
function withDot(svg, circle) {
  return svg.replace("</svg>", `${circle}</svg>`);
}

// Render an SVG buffer to a PNG at an exact height (width follows the aspect ratio) or an
// exact square. `density` scales rasterization so small targets stay crisp.
async function renderPng(svg, out, opts) {
  const buf = Buffer.from(svg);
  const resize = opts.square
    ? {
        width: opts.size,
        height: opts.size,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }
    : { height: opts.size };
  await sharp(buf, { density: 512 }).resize(resize).png().toFile(out);
  return out;
}

const markDot = '<circle cx="116" cy="12" r="12" fill="#0B0D10"/>';
const squareDot = '<circle cx="864" cy="176" r="132" fill="#F7F4EE"/>';

const jobs = [
  // macOS menu-bar template (wide mark), @1x height 16, @2x height 32.
  { svg: markSvg, out: "rennetTemplate.png", size: 16 },
  { svg: markSvg, out: "rennetTemplate@2x.png", size: 32 },
  { svg: withDot(markSvg, markDot), out: "rennetUpdateTemplate.png", size: 16 },
  { svg: withDot(markSvg, markDot), out: "rennetUpdateTemplate@2x.png", size: 32 },
  // Windows/Linux square, 16 and 32.
  { svg: squareSvg, out: "rennet.png", size: 32, square: true },
  { svg: squareSvg, out: "rennet@2x.png", size: 64, square: true },
  { svg: withDot(squareSvg, squareDot), out: "rennetUpdate.png", size: 32, square: true },
  { svg: withDot(squareSvg, squareDot), out: "rennetUpdate@2x.png", size: 64, square: true },
];

for (const job of jobs) {
  const out = resolve(OUT, job.out);
  await renderPng(job.svg, out, job);
  console.log("wrote", job.out);
}
