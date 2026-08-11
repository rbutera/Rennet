// QA sheet: show each committed render at TRUE size and pixel-magnified (nearest
// neighbour), on the app's dark ground, so 16px legibility is judged from the
// actual pixels, not a smooth re-scale. Run after render.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "rennet-qa-"));
const GROUND = "#0c1218";
const b64 = (n) =>
  "data:image/png;base64," +
  readFileSync(join(here, "renders", `glyph-${n}.png`)).toString("base64");

const sizes = [16, 32, 64, 512];
const cells = sizes
  .map((n) => {
    const src = b64(n);
    const trueDim = Math.min(n, 64);
    return `<div class="cell">
      <div class="mag"><img src="${src}" style="image-rendering:pixelated;width:160px;height:160px;object-fit:contain"></div>
      <div class="true"><img src="${src}" width="${trueDim}" height="${trueDim}"></div>
      <div class="lab">${n}px &nbsp;·&nbsp; magnified &amp; true${n > 64 ? " (true capped 64)" : ""}</div>
    </div>`;
  })
  .join("");

const html = `<!doctype html><meta charset="utf8"><style>
  html,body{margin:0;background:${GROUND};color:#aeb4bd;
    font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
  .wrap{padding:40px}
  h1{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7e8590;
    font-weight:600;margin:0 0 32px}
  .grid{display:flex;gap:40px;align-items:flex-start}
  .cell{display:flex;flex-direction:column;align-items:center;gap:16px;width:180px}
  .mag{width:160px;height:160px;display:flex;align-items:center;justify-content:center}
  .true{height:64px;display:flex;align-items:flex-end}
  .lab{color:#7e8590;font-size:11px;text-align:center}
</style><div class="wrap">
  <h1>Rennet mark &#183; 16 / 32 / 64 / 512, magnified (pixelated) + true size</h1>
  <div class="grid">${cells}</div>
</div>`;
const page = join(work, "qa.html");
writeFileSync(page, html);
execFileSync(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=920,340",
    `--screenshot=${join(here, "renders", "qa-sheet.png")}`,
    `file://${page}`,
  ],
  { stdio: "pipe" },
);
console.log("rendered renders/qa-sheet.png");
