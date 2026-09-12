// Rasterize the checked-in monochrome mark into tray/menu-bar icons (issue: tray-presence).
// sharp renders the committed SVG sources to alpha PNGs at exact pixel sizes — no browser,
// no new dependency (sharp already ships in the workspace).
//
//   node brand/scripts/gen-tray-icons.mjs
//
// macOS uses TEMPLATE images (alpha-only, black artwork) that adapt to the menu-bar theme;
// the glyph comes from mark-small-black.svg — the ridged sphere with three rings, SQUARE
// (100x100) since the liquid-sphere identity landed. Windows uses a multi-resolution .ico
// (the native tray format — the shell picks the size it needs per DPI) and Linux uses the
// white-on-black SQUARE PNG, both so the mark stays visible on any taskbar colour. The
// "update-ready" variant bakes a dot into the corner — the presence of the dot is the whole
// signal (template images are monochrome, so the dot is not a distinct colour on macOS; that
// is intended). A round mark fills its box in every direction, so the update variants shrink
// the mark toward the bottom-left first: the dot needs empty space around it or it merges
// with the silhouette and reads as a bump rather than a signal.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const brand = resolve(here, "..");
const OUT = resolve(brand, "exports/tray");
// build-brand-assets.py clears exports/ before it rebuilds, so this dir is gone on every
// full rebuild and the tray step has to recreate it.
mkdirSync(OUT, { recursive: true });

const markSvg = readFileSync(resolve(brand, "exports/logo/svg/mark-small-black.svg"), "utf8");
const squareSvg = readFileSync(
  resolve(brand, "exports/app-icons/masters/app-icon-white-on-black-small.svg"),
  "utf8",
);

// Shrink the artwork into a corner of its own viewBox and drop a filled dot into the space
// that frees up. `shrink` is an SVG transform in source viewBox coordinates; `circle` is the
// dot in the same coordinates. Wrapping the whole body (defs included — the ridged mark's
// creases are a mask, and a mask inside a transformed group still resolves) keeps this a
// pure text edit with no SVG parser.
function withDot(svg, { shrink, circle }) {
  if (!shrink) return svg.replace("</svg>", `${circle}</svg>`);
  const open = svg.match(/<svg\b[^>]*>/)[0];
  const body = svg.slice(open.length, svg.lastIndexOf("</svg>"));
  return `${open}<g transform="${shrink}">${body}</g>${circle}</svg>`;
}

// Render an SVG buffer to a PNG at an exact height (width follows the aspect ratio — for the
// square mark that is the same number) or an exact square. `density` scales rasterization so
// small targets stay crisp.
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

// Assemble a multi-resolution .ico from PNG buffers (PNG-in-ICO, valid on every supported
// Windows). Header: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the raw
// PNG blobs. width/height 0 means 256. No dependency — the format is a flat table.
function pngsToIco(entries) {
  const count = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);
  const table = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const b = 16 * i;
    table.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width
    table.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    table.writeUInt8(0, b + 2); // palette count
    table.writeUInt8(0, b + 3); // reserved
    table.writeUInt16LE(1, b + 4); // color planes
    table.writeUInt16LE(32, b + 6); // bits per pixel
    table.writeUInt32LE(e.png.length, b + 8); // bytes in resource
    table.writeUInt32LE(offset, b + 12); // offset from file start
    offset += e.png.length;
  });
  return Buffer.concat([dir, table, ...entries.map((e) => e.png)]);
}

// Render the square SVG to a set of PNG buffers and pack them into one .ico.
async function renderIco(svg, out, sizes) {
  const buf = Buffer.from(svg);
  const entries = await Promise.all(
    sizes.map(async (size) => ({
      size,
      png: await sharp(buf, { density: 512 })
        .resize({
          width: size,
          height: size,
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer(),
    })),
  );
  writeFileSync(resolve(OUT, out), pngsToIco(entries));
  return out;
}

const ICO_SIZES = [16, 24, 32, 48, 256];

// The mark's own 100x100 viewBox: shrink to 78% anchored bottom-left, dot in the freed
// top-right corner. Centres are 60.8 units apart against a 52.9-unit sum of radii, so the
// two shapes never touch at any render size.
const markUpdate = {
  shrink: "translate(0 22) scale(0.78)",
  circle: '<circle cx="82" cy="18" r="17" fill="#0B0D10"/>',
};
// The square icon's 1024 viewBox already insets the mark inside a squircle, so only the dot
// is added. It is pinned on the diagonal at distance 440 from the tile centre: 42 units clear
// of the 560-wide mark's edge, and 32 units inside the squircle's corner arc. Both margins
// are small, so a change to either the mark height or the corner radius moves this dot.
const squareUpdate = { circle: '<circle cx="823" cy="201" r="118" fill="#F7F4EE"/>' };

const jobs = [
  // macOS menu-bar template (square mark), @1x height 16, @2x height 32.
  { svg: markSvg, out: "rennetTemplate.png", size: 16 },
  { svg: markSvg, out: "rennetTemplate@2x.png", size: 32 },
  { svg: withDot(markSvg, markUpdate), out: "rennetUpdateTemplate.png", size: 16 },
  { svg: withDot(markSvg, markUpdate), out: "rennetUpdateTemplate@2x.png", size: 32 },
  // Windows/Linux square, 16 and 32.
  { svg: squareSvg, out: "rennet.png", size: 32, square: true },
  { svg: squareSvg, out: "rennet@2x.png", size: 64, square: true },
  { svg: withDot(squareSvg, squareUpdate), out: "rennetUpdate.png", size: 32, square: true },
  { svg: withDot(squareSvg, squareUpdate), out: "rennetUpdate@2x.png", size: 64, square: true },
];

for (const job of jobs) {
  const out = resolve(OUT, job.out);
  await renderPng(job.svg, out, job);
  console.log("wrote", job.out);
}

// Windows tray icons: multi-resolution .ico from the square white-on-black mark.
for (const ico of [
  { svg: squareSvg, out: "rennet.ico" },
  { svg: withDot(squareSvg, squareUpdate), out: "rennetUpdate.ico" },
]) {
  await renderIco(ico.svg, ico.out, ICO_SIZES);
  console.log("wrote", ico.out);
}
