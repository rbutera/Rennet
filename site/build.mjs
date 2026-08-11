// Rennet status-page build. Emits a static site into dist/. Zero npm deps: only
// the Node standard library, so it builds in an isolated worktree with no install.
//
//   node build.mjs
//
// What it does:
//   · copies the app's REAL tokens.css (packages/ui/src/tokens.css) into dist, so
//     the site and the product consume one token file and cannot drift;
//   · copies the favicon and the one screenshot;
//   · turns buildlog.json into the on-page build log AND an Atom feed;
//   · writes the honesty line from one config constant below.
//
// BUILD ONLY. It does not deploy. Deploying anything is a Rai-only action.

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const dist = join(here, "dist");

// ── config ──────────────────────────────────────────────────────────────────
// The intended primary domain (Branding Plan §2). Used only to mint stable Atom
// ids; the page itself makes no request to it. The site is not deployed here.
const SITE_URL = "https://rennet.dev";
// The dogfood-v1 start date. NULL until Rai sets it: the honesty line must not
// invent a date. When set (YYYY-MM-DD) the line switches to the dated form and
// the date is meant to move.
const DOGFOOD_SINCE = null;
// The one screenshot: the review surface, from the canonical wireframes.
const SCREENSHOT_SRC = join(repo, "wireframes", "06-review-heart.png");

// ── helpers ─────────────────────────────────────────────────────────────────
const xml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function honestyLine() {
  if (DOGFOOD_SINCE) {
    return `Not released. Dogfooded daily since ${DOGFOOD_SINCE} on real pull requests. The repo goes public when it stops being embarrassing.`;
  }
  return "Not released, and not yet in daily dogfood. When the daily-driver review starts, this line carries the date it started, and the date moves. The repo goes public when it stops being embarrassing.";
}

// ── read sources ────────────────────────────────────────────────────────────
const log = JSON.parse(readFileSync(join(here, "buildlog.json"), "utf8"));
const entries = [...log.entries].reverse(); // newest first

const tokensSrc = join(repo, "packages", "ui", "src", "tokens.css");
if (!existsSync(tokensSrc)) {
  throw new Error(`tokens.css not found at ${tokensSrc}: the anti-drift copy is the point; refusing to build without it.`);
}
if (!existsSync(SCREENSHOT_SRC)) {
  throw new Error(`screenshot not found at ${SCREENSHOT_SRC}`);
}

// ── build log HTML ──────────────────────────────────────────────────────────
const logHtml = entries
  .map(
    (e) =>
      `\n          <li><time datetime="${xml(e.date)}">${xml(e.date)}</time><span class="entry">${xml(e.text)}</span></li>`,
  )
  .join("") + "\n        ";

// ── Atom feed ───────────────────────────────────────────────────────────────
const rfc3339 = (d) => `${d}T00:00:00Z`;
const feedUpdated = rfc3339(entries[0]?.date ?? "2026-08-11");
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Rennet build log</title>
  <subtitle>A build log, not a blog.</subtitle>
  <link href="${SITE_URL}/feed.xml" rel="self"/>
  <link href="${SITE_URL}/"/>
  <id>${SITE_URL}/</id>
  <updated>${feedUpdated}</updated>
${entries
  .map(
    (e, i) => `  <entry>
    <title>${xml(e.text)}</title>
    <id>tag:rennet.dev,${e.date}:buildlog-${entries.length - i}</id>
    <updated>${rfc3339(e.date)}</updated>
    <link href="${SITE_URL}/#buildlog"/>
    <content type="text">${xml(e.text)}</content>
  </entry>`,
  )
  .join("\n")}
</feed>
`;

// ── emit ────────────────────────────────────────────────────────────────────
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

let indexHtml = readFileSync(join(here, "index.html"), "utf8");
indexHtml = indexHtml
  .replace("<!--BUILD_LOG-->", logHtml)
  .replace("<!--HONESTY_LINE-->", xml(honestyLine()));

writeFileSync(join(dist, "index.html"), indexHtml);
copyFileSync(join(here, "styles.css"), join(dist, "styles.css"));
copyFileSync(join(here, "scheme-toggle.js"), join(dist, "scheme-toggle.js"));
copyFileSync(tokensSrc, join(dist, "tokens.css"));
copyFileSync(join(here, "favicon.svg"), join(dist, "favicon.svg"));
copyFileSync(SCREENSHOT_SRC, join(dist, "screenshot.png"));
writeFileSync(join(dist, "feed.xml"), atom);

console.log("built dist/:");
for (const f of ["index.html", "styles.css", "scheme-toggle.js", "tokens.css", "favicon.svg", "screenshot.png", "feed.xml"]) {
  console.log("  " + f);
}
console.log(`build log: ${entries.length} entries; honesty date: ${DOGFOOD_SINCE ?? "unset (pre-dogfood line)"}`);
