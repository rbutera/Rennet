// Rasterise an SVG through Chromium (Playwright) at an exact pixel size.
// ImageMagick's internal SVG renderer drops gradients, masks and clip paths,
// so anything with more than one flat fill goes through here instead.
//   node brand/scripts/rasterise-svg.mjs <in.svg> <out.png> <size> [background|transparent]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [, , input, output, sizeArg, background = "transparent"] = process.argv;
const size = Number(sizeArg);
if (!input || !output || !size) {
  console.error("usage: rasterise-svg.mjs <in.svg> <out.png> <size> [background]");
  process.exit(2);
}
const svg = readFileSync(resolve(input), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: size, height: size },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<!doctype html><html><body style="margin:0;background:${background}">${svg}</body></html>`,
);
await page.evaluate((size) => {
  const s = document.querySelector("svg");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.style.display = "block";
}, size);
await page.screenshot({ path: resolve(output), omitBackground: background === "transparent" });
await browser.close();
