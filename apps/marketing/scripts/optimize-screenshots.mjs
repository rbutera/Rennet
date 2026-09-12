// Quantise the raw 2x product captures into the PNGs the marketing page serves (#470).
//
// Usage: node apps/marketing/scripts/optimize-screenshots.mjs <raw-dir> <out-dir>
//
// A retina capture of the review board is 3072×2048 and, straight from Chromium, well
// over a megabyte. Palette quantisation keeps it lossless-looking for flat UI and cuts
// the bytes by two thirds or more, which is what keeps a hero image under the old
// wireframe's 640 kB. The raw directory is ignored by git; only the output is committed.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";

const [rawDir, outDir] = process.argv.slice(2);
if (rawDir === undefined || outDir === undefined) {
  console.error("usage: optimize-screenshots.mjs <raw-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const kilobytes = (bytes) => `${Math.round(bytes / 1024)} kB`;
const captures = readdirSync(rawDir).filter((name) => name.endsWith(".png"));
if (captures.length === 0) {
  console.error(`no .png captures in ${rawDir}`);
  process.exit(1);
}

for (const name of captures) {
  const source = join(rawDir, name);
  const target = join(outDir, basename(name));
  const { width, height } = await sharp(source).metadata();
  await sharp(source)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toFile(target);
  console.log(
    `${name}: ${width}×${height}, ${kilobytes(statSync(source).size)} → ${kilobytes(statSync(target).size)}`,
  );
}
