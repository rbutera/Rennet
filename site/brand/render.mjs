// Render the Rennet mark to exact-size PNGs (16/32/64/512) and a dark-ground
// contact sheet, using headless Chrome. This is the bead-139 acceptance step:
// "renders committed; 16px legibility confirmed", confirmed by looking at the
// 16px output, not by asserting it.
//
// Run: node render.mjs   (from site/brand/)
// Output: renders/glyph-{16,32,64,512}.png  and  renders/contact-sheet.png
//
// Zero npm deps: it shells out to the Google Chrome already on the machine.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const glyph = readFileSync(join(here, "rennet-glyph.svg"), "utf8");
const outDir = join(here, "renders");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "rennet-glyph-"));

// tokens.css --surface darkest / icon-concept "aurora at its darkest" ground.
const GROUND = "#0c1218";

function chromeShot(html, out, w, h, transparent) {
  const page = join(work, `p-${w}x${h}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(page, html);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${w},${h}`,
    `--screenshot=${out}`,
  ];
  if (transparent) args.push("--default-background-color=00000000");
  args.push(`file://${page}`);
  execFileSync(CHROME, args, { stdio: "pipe" });
}

const sizes = [16, 32, 64, 512];
for (const n of sizes) {
  // The glyph sized to exactly n×n, transparent ground, no page chrome.
  const sized = glyph.replace(
    /width="64" height="64"/,
    `width="${n}" height="${n}"`,
  );
  const html = `<!doctype html><meta charset="utf8"><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block}
  </style>${sized}`;
  chromeShot(html, join(outDir, `glyph-${n}.png`), n, n, true);
  console.log(`rendered renders/glyph-${n}.png`);
}

// Contact sheet: every size on the app's dark ground, with the lockup, for QA.
const lockup = readFileSync(join(here, "rennet-lockup.svg"), "utf8");
const row = sizes
  .map((n) => {
    const disp = Math.min(n, 96); // cap 512 so the sheet fits; label the true size
    const svg = glyph.replace(/width="64" height="64"/, `width="${disp}" height="${disp}"`);
    return `<div class="cell"><div class="g" style="width:${disp}px;height:${disp}px">${svg}</div><div class="lab">${n}px${n > 96 ? " (shown 96)" : ""}</div></div>`;
  })
  .join("");
const sheetW = 900,
  sheetH = 420;
const sheet = `<!doctype html><meta charset="utf8"><style>
  html,body{margin:0;background:${GROUND};color:#aeb4bd;
    font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
  .wrap{padding:36px}
  .glyphs{display:flex;align-items:flex-end;gap:44px;margin-bottom:40px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:12px}
  .lab{color:#7e8590;font-size:12px}
  .lock{margin-top:8px}
  h1{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7e8590;
    font-weight:600;margin:0 0 28px}
</style><div class="wrap">
  <h1>Rennet mark &#183; solid curd, open whey, a hairline cut</h1>
  <div class="glyphs">${row}</div>
  <div class="lock">${lockup}</div>
</div>`;
chromeShot(sheet, join(outDir, "contact-sheet.png"), sheetW, sheetH, false);
console.log("rendered renders/contact-sheet.png");
