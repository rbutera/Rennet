// Render wireframe HTML frames to PNG at 2x (1440px logical width) via Playwright Chromium.
// Usage: node render.mjs [name ...]   (no args = render every *.html in this dir)
// Requires Playwright installed in a resolvable node_modules (rennet repo provides it).
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url)); // .../src
const OUT = resolve(__dir, '..'); // PNGs sit one level up, beside the src/ dir

const args = process.argv.slice(2).map((a) => basename(a).replace(/\.(html|png)$/, ''));
const names = args.length
  ? args
  : readdirSync(__dir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();

for (const name of names) {
  const htmlPath = resolve(__dir, `${name}.html`);
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const pngPath = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log('rendered', `${name}.png`);
}

await browser.close();
