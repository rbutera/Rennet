// Rasterize the checked-in monochrome mark into tray/menu-bar icons (issue: tray-presence).
// sharp renders the committed SVG sources to alpha PNGs at exact pixel sizes — no browser,
// no new dependency (sharp already ships in the workspace).
//
//   node brand/scripts/gen-tray-icons.mjs
//
// macOS uses TEMPLATE images (alpha-only, black artwork) that adapt to the menu-bar theme;
// the glyph comes from mark-small-black.svg. Windows uses a multi-resolution .ico (the
// native tray format — the shell picks the size it needs per DPI) and Linux uses the
// white-on-black SQUARE PNG, both so the mark stays visible on any taskbar colour. The
// "update-ready" variant bakes a dot into the corner — the presence of the dot is the whole
// signal (template images are monochrome, so the dot is not a distinct colour on macOS; that
// is intended).
import { readFileSync, writeFileSync } from "node:fs";
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

// Windows tray icons: multi-resolution .ico from the square white-on-black mark.
for (const ico of [
  { svg: squareSvg, out: "rennet.ico" },
  { svg: withDot(squareSvg, squareDot), out: "rennetUpdate.ico" },
]) {
  await renderIco(ico.svg, ico.out, ICO_SIZES);
  console.log("wrote", ico.out);
}
