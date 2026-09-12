// Builds the self-contained index.html: inlines the brand SVGs (as <symbol>s so the
// gradient ids are defined exactly once) and the Geist variable font, then writes the
// page. No network, no framework — the output opens straight from disk.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = "/tmp/rennet-orb-lockup-assets";
const FONT =
  "/Users/rai/dev/rennet/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";

const fontB64 = readFileSync(FONT).toString("base64");

// ── brand art → <symbol> ────────────────────────────────────────────────────
const markRaw = readFileSync(join(ASSETS, "mark-color.svg"), "utf8");
const markInner = markRaw
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  // namespace the gradient/clip ids so nothing can collide with the page
  .replace(/id="(body|light|shade|disc)"/g, 'id="rnm-$1"')
  .replace(/url\(#(body|light|shade|disc)\)/g, "url(#rnm-$1)");

const wordRaw = readFileSync(join(ASSETS, "wordmark-black.svg"), "utf8");
const wordVB = /viewBox="([^"]+)"/.exec(wordRaw)[1];
const wordInner = wordRaw
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  // the wordmark is a single-ink glyph; take the ink from the scheme
  .replace(/fill="#0B0D10"/i, 'fill="currentColor"');

// ── geometry ────────────────────────────────────────────────────────────────
// The authored horizontal lockup: mark 126 square at the origin, 24 gap, wordmark
// 480.168 x 112 at x=150, y=7. So relative to a mark of height M:
//   wordmark height = M * 112/126,  wordmark width = height * 480.168/112,  gap = M * 24/126
const WORD_RATIO = 480.168 / 112; // 4.2872
const wm = (markPx) => {
  const h = (markPx * 112) / 126;
  return { h: +h.toFixed(2), w: +(h * WORD_RATIO).toFixed(2), gap: +((markPx * 24) / 126).toFixed(2) };
};
const P1 = { mark: 38, ...wm(38) };
const P3 = { mark: 40, wordH: 18, wordW: +(18 * WORD_RATIO).toFixed(2) };
const P2 = { mark: 52, wordW: 112, wordH: +(112 / WORD_RATIO).toFixed(2) };

const markSvg = (px, cls = "") =>
  `<svg class="mark ${cls}" width="${px}" height="${px}" viewBox="0 0 100 100" role="img" aria-label="Rennet"><use href="#rn-mark"/></svg>`;
const wordSvg = (h, w) =>
  `<svg class="wordmark" width="${w}" height="${h}" viewBox="${wordVB}" aria-hidden="true"><use href="#rn-wordmark"/></svg>`;

// ── lucide-ish glyphs (spike placeholders, 24-grid, 1.5 stroke) ─────────────
const I = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  newChat:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h6"/><path d="M12 7v6"/>',
  folderPlus:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M15 6v15"/><path d="M9 3v15"/>',
  diff: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M9 12h6"/><path d="M12 9v6"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
};
const icon = (name, px) =>
  `<svg class="i" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

// ── the real sidebar contents ───────────────────────────────────────────────
const trafficLights = `<span class="lights" aria-hidden="true"><i class="l close"></i><i class="l min"></i><i class="l zoom"></i></span>`;
const toggle = `<button type="button" class="sb-toggle" title="Collapse sidebar" aria-label="Collapse sidebar">${icon("panelLeft", 14)}</button>`;

/** State-1 corner slot stripped back to lights + toggle (placements 1-3 all do this). */
const bareCornerRow = `
      <div class="corner-slot bare" data-slot="corner-slot" data-owner="sidebar">
        ${trafficLights}
        <span class="grow"></span>
        ${toggle}
      </div>`;

/** The corner slot exactly as it ships today: lights -> 24px lockup -> toggle. */
const todayCornerRow = `
      <div class="corner-slot" data-slot="corner-slot" data-owner="sidebar">
        ${trafficLights}
        <div class="lockup-inline" role="img" aria-label="Rennet">
          ${markSvg(24)}${wordSvg(24, +(24 * WORD_RATIO).toFixed(1))}
        </div>
        ${toggle}
      </div>`;

const actions = `
      <div class="actions">
        <button type="button" class="row quiet">${icon("search", 14)}<span class="flex1">Search</span><kbd>⌘P</kbd></button>
        <button type="button" class="row primary">${icon("newChat", 14)}<span>New Chat</span></button>
        <button type="button" class="row quiet">${icon("folderPlus", 14)}<span>Add Project</span></button>
        <button type="button" class="row quiet">${icon("plus", 14)}<span>Add Environment</span></button>
      </div>`;

const session = (title, sub, opts = {}) => `
          <button type="button" class="session${opts.active ? " active" : ""}">
            <span class="s-line">
              ${icon(opts.kind === "branch" ? "branch" : "pr", 12)}
              <span class="s-title">${title}</span>
              ${opts.reviewed ? `<span class="tick">${icon("check", 12)}</span>` : ""}
              ${opts.pinned ? `<span class="pinned">${icon("pin", 10)}</span>` : ""}
              ${opts.unread ? `<span class="unread"></span>` : ""}
            </span>
            <span class="s-sub">${sub}</span>
          </button>`;

const newChatRow = `
          <button type="button" class="newchat">${icon("plus", 12)}<span>New Chat</span></button>`;

const project = (name, count, sessions, opts = {}) => `
        <div class="proj">
          <button type="button" class="proj-row"${opts.open ? "" : ' data-folded="true"'}>
            <span class="chev${opts.open ? "" : " folded"}">${icon("chevron", 12)}</span>
            <span class="pmark" aria-hidden="true">${icon(opts.mark ?? "monitor", 14)}</span>
            <span class="flex1 truncate">${name}</span>
            <span class="count">${count}</span>
          </button>
          ${opts.open ? `<div class="proj-children">${sessions.join("")}${newChatRow}</div>` : ""}
        </div>`;

const tree = `
      <div class="tree">
        <div class="group">
          <div class="group-head">${icon("pin", 12)}<span>Pinned</span></div>
          ${session("Board tool result byte ceiling", "rennet · 2h", { pinned: true })}
        </div>

        <div class="group pt">
          <div class="group-head">${icon("monitor", 12)}<span>This Mac</span></div>
          ${project(
            "rennet",
            6,
            [
              session("Sidebar lockup placement", "12m", { active: true, unread: false }),
              session("Usage across query resets", "1h", { reviewed: true }),
              session("Settle control requests on exit", "yesterday", { kind: "branch" }),
            ],
            { open: true, mark: "pr" },
          )}
          ${project("tokenmaxx", 3, [], { open: false, mark: "pr" })}
        </div>

        <div class="group pt">
          <div class="group-head">${icon("server", 12)}<span>nimbus</span></div>
          ${project(
            "harness-bridge",
            2,
            [session("Codex bridge node pin", "3d", { kind: "branch", unread: true })],
            { open: true, mark: "pr" },
          )}
        </div>
      </div>`;

const footer = `
      <div class="footer">
        <button type="button" class="row quiet">${icon("archive", 14)}<span class="flex1">Archived</span><span class="count">4</span></button>
        <div class="footer-controls">
          <button type="button" class="icon-btn" title="Settings" aria-label="Settings">${icon("settings", 14)}</button>
          <button type="button" class="icon-btn" title="Help" aria-label="Help">${icon("help", 14)}</button>
        </div>
      </div>`;

// ── the four sidebar variants ───────────────────────────────────────────────
const sidebar = (id, header) => `
    <aside class="sidebar" data-region="sidebar" data-open="true" data-variant="${id}">
      ${header}
      ${actions}
      ${tree}
      ${footer}
    </aside>`;

const VARIANTS = [
  {
    id: "today",
    name: "Today (reference)",
    caption: `40px corner row · mark 24px · wordmark 24 × 102.9 · budget 81 + 24 + 4 + 102.9 + 8 + 12 + 24 = 255.9 / 256`,
    note: "Nothing left to spend: the mark cannot grow inside the row that also holds the 81px light reserve and the toggle. Note the app draws BOTH halves at size 24, so the wordmark here is taller relative to the mark than the authored lockup (126 : 112); the three placements below use the authored ratio.",
    header: todayCornerRow,
  },
  {
    id: "own-row",
    name: "1 · Own row",
    caption: `corner row 40px (lights + toggle only) · lockup row 56px · mark ${P1.mark}px · wordmark ${P1.h} × ${P1.w} · authored gap ${P1.gap}px · left edge 16px`,
    note: `Row occupies 16 + ${P1.mark} + ${P1.gap} + ${P1.w} + 12 = ${(16 + P1.mark + P1.gap + P1.w + 12).toFixed(1)} of 256px — ${(256 - (16 + P1.mark + P1.gap + P1.w + 12)).toFixed(1)}px slack, so the mark could still reach ~44px. Costs 56px of vertical before the actions. The lockup row sits BELOW the drag strip, so it is not titlebar and does not drag the window unless it opts in.`,
    header: `${bareCornerRow}
      <div class="own-row" role="img" aria-label="Rennet">
        ${markSvg(P1.mark)}<span style="width:${P1.gap}px"></span>${wordSvg(P1.h, P1.w)}
      </div>`,
  },
  {
    id: "stacked",
    name: "2 · Stacked header",
    caption: `corner row 40px · stacked block 118px (12 top / 10 gap / 18 bottom) · mark ${P2.mark}px · wordmark ${P2.wordH} × ${P2.wordW}, centred`,
    note: `The biggest mark of the three and the only centred element in a left-aligned panel. Costs 118px before the actions — roughly two session rows of tree. Centring also pulls the identity off the 16px content edge every other row is aligned to.`,
    header: `${bareCornerRow}
      <div class="stacked" role="img" aria-label="Rennet">
        ${markSvg(P2.mark)}
        ${wordSvg(P2.wordH, P2.wordW)}
      </div>`,
  },
  {
    id: "mark-leads",
    name: "3 · Mark leads",
    caption: `corner row 40px · head row 60px · mark ${P3.mark}px · wordmark ${P3.wordH} × ${P3.wordW} beside it, baseline-set · left edge 16px`,
    note: `Uses 16 + ${P3.mark} + 12 + ${P3.wordW} + 12 = ${(16 + P3.mark + 12 + P3.wordW + 12).toFixed(1)} of 256px, the most slack of the three: the mark can grow to ~56px before the word is squeezed. The word reads as caption, which is what makes the collapsed orb feel like the same object rather than a fragment.`,
    header: `${bareCornerRow}
      <div class="mark-leads" role="img" aria-label="Rennet">
        ${markSvg(P3.mark)}
        <span class="ml-word">${wordSvg(P3.wordH, P3.wordW)}</span>
      </div>`,
  },
];

const column = (v, scheme) => `
  <div class="col">
    <div class="col-head">
      <h3>${v.name}</h3>
      <p class="cap">${v.caption}</p>
    </div>
    <div class="frame" data-scheme="${scheme}">
      ${sidebar(v.id, v.header)}
    </div>
    <p class="note"><strong>Constraint.</strong> ${v.note}</p>
  </div>`;

// ── collapsed: the floating pill + the top bar's floating chip layer ────────
const pill = (pillH, orb) => `
  <div class="float-pill" style="--pill-h:${pillH}px">
    ${trafficLights}
    ${markSvg(orb, "orb")}
    <button type="button" class="sb-toggle" title="Expand sidebar" aria-label="Expand sidebar">${icon("panelLeft", 14)}</button>
  </div>`;

const chips = `
  <div class="chip-layer">
    <button type="button" class="chip icon-chip" title="Open chat" aria-label="Open chat">${icon("chat", 14)}</button>
    <button type="button" class="chip pill-chip">${icon("history", 14)}<span>History</span></button>
    <div class="chip joined">
      <button type="button" class="seg">${icon("map", 14)}<span>Map</span></button>
      <span class="hair"></span>
      <button type="button" class="seg">${icon("diff", 14)}<span>Diff</span></button>
    </div>
  </div>`;

const collapsed = (scheme) => `
  <div class="collapsed-pair" data-scheme="${scheme}">
    <div class="collapsed-stage">
      <div class="stage-label">A · orb 28px in today's 32px pill</div>
      <div class="stage">${pill(32, 28)}${chips}</div>
    </div>
    <div class="collapsed-stage">
      <div class="stage-label">B · pill grown to 36px, orb 32px</div>
      <div class="stage">${pill(36, 32)}${chips}</div>
    </div>
  </div>`;

// ── page ────────────────────────────────────────────────────────────────────
const css = String.raw`
@font-face{font-family:"Geist Variable";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${fontB64}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}

/* palette — verbatim from packages/theme/src/palette.css */
[data-scheme="light"],:root{
  --rn-canvas:#fbfaf7; --rn-surface:#ffffff; --rn-raised:#f3f1ec; --rn-overlay:#ffffff;
  --rn-ink:#1e1b16; --rn-ink-soft:#57534a; --rn-ink-faint:#6b6558;
  --rn-line:rgb(60 50 30 / 0.12); --rn-line-strong:rgb(60 50 30 / 0.2);
  --rn-accent:#8a5d0b; --rn-accent-fill:#e0a52e; --rn-accent-soft:rgb(138 93 11 / 0.1);
  --rn-green:#41745b; --rn-model:#2b7d6e; --rn-danger:#b23b2b;
  --rn-mark-ink:#0b0d10;
  --rn-secondary:#f3f1ec;
}
[data-scheme="dark"]{
  --rn-canvas:#0a0a0a; --rn-surface:#131313; --rn-raised:#1a1a1a; --rn-overlay:#060606;
  --rn-ink:#f2ede4; --rn-ink-soft:#a9a196; --rn-ink-faint:#948d80;
  --rn-line:rgb(240 232 215 / 0.09); --rn-line-strong:rgb(240 232 215 / 0.16);
  --rn-accent:#e8b13c; --rn-accent-fill:#e8b13c; --rn-accent-soft:rgb(232 177 60 / 0.14);
  --rn-green:#88bc9b; --rn-model:#9fd0c0; --rn-danger:#db7a6a;
  --rn-mark-ink:#f7f4ee;
  --rn-secondary:#1a1a1a;
}
:root{
  --rn-font-sans:"Geist Variable",system-ui,-apple-system,"Segoe UI",sans-serif;
  --radius-chip:0.375rem;
  --text-2xs:0.6875rem; --text-xs:0.75rem; --text-13:0.8125rem; --text-sm:0.875rem;
}

*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--rn-canvas); color:var(--rn-ink);
  font-family:var(--rn-font-sans);
  font-size:14px; -webkit-font-smoothing:antialiased;
  padding:28px 32px 56px;
}
h1{font-size:20px;font-weight:600;margin:0 0 6px}
h2{font-size:15px;font-weight:600;margin:40px 0 14px;letter-spacing:.01em}
h3{font-size:13px;font-weight:600;margin:0}
.lede{margin:0 0 4px;font-size:13px;color:var(--rn-ink-soft);max-width:96ch;line-height:1.55}
.scheme-tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--rn-ink-faint);margin:26px 0 10px}

.grid{display:flex;gap:24px;align-items:flex-start}
.col{width:256px;flex:0 0 256px}
.col-head{min-height:62px;margin-bottom:8px}
.cap{margin:4px 0 0;font-size:11px;line-height:1.45;color:var(--rn-ink-faint)}
.note{margin:8px 0 0;font-size:11px;line-height:1.5;color:var(--rn-ink-soft)}
.note strong{color:var(--rn-ink);font-weight:600}

/* the frame is exactly the 256px panel; its right edge stands in for the sidebar's
   own border-r/border-line hairline, so the panel edge is not drawn twice */
.frame{display:flex;width:256px;height:680px;background:var(--rn-canvas);border:1px solid var(--rn-line-strong);border-radius:8px;overflow:hidden}

/* ── sidebar ───────────────────────────────────────────────────────── */
.sidebar{width:256px;flex:0 0 256px;height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden}

/* CornerSlot: h-10 (40px), gap-2, pl-[81px] on darwin, pr-3 */
.corner-slot{display:flex;height:40px;flex-shrink:0;align-items:center;gap:8px;padding-left:81px;padding-right:12px;position:relative}
.lights{position:absolute;left:0;top:0;height:40px;width:81px;display:flex;align-items:center;gap:8px;padding-left:14px}
.lights .l{width:12px;height:12px;border-radius:999px;display:block}
.lights .close{background:#ff5f57}.lights .min{background:#febc2e}.lights .zoom{background:#28c840}
.grow{flex:1 1 auto}
.lockup-inline{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto}
.sb-toggle{flex:0 0 auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;border-radius:var(--radius-chip);color:var(--rn-ink-soft);cursor:default;padding:0}

.mark{display:block;flex:0 0 auto}
.wordmark{display:block;color:var(--rn-mark-ink);flex:0 0 auto}

/* 1 · own row */
.own-row{display:flex;align-items:center;height:56px;padding-left:16px;padding-right:12px;flex-shrink:0}
/* 2 · stacked header */
.stacked{display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 12px 18px;flex-shrink:0}
/* 3 · mark leads */
.mark-leads{display:flex;align-items:flex-end;height:60px;padding:0 12px 10px 16px;gap:12px;flex-shrink:0}
.ml-word{display:block;padding-bottom:5px}

/* actions: px-2, gap-0.5, rows h-8 px-2 text-13 */
.actions{display:flex;flex-direction:column;gap:2px;padding:0 8px}
.row{display:flex;height:32px;align-items:center;gap:8px;border-radius:var(--radius-chip);padding:0 8px;text-align:left;font-size:var(--text-13);line-height:1.4;border:0;background:transparent;cursor:default;font-family:inherit;width:100%}
.row.quiet{color:var(--rn-ink-soft)}
.row.primary{color:color-mix(in oklch,var(--rn-ink),transparent 10%)}
.row.primary .i{color:var(--rn-ink-soft)}
.flex1{flex:1 1 auto}
kbd{font-family:inherit;font-size:10px;line-height:1;padding:3px 5px;border-radius:4px;border:1px solid var(--rn-line);color:var(--rn-ink-faint);background:var(--rn-raised)}
.i{flex:0 0 auto}

/* tree: mt-5, px-2 */
.tree{margin-top:20px;flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 8px;display:flex;flex-direction:column}
.tree::after{content:"";display:block;min-height:8px;flex:0 0 auto}
.group{display:flex;flex-direction:column}
.group.pt{padding-top:20px}
.group-head{display:flex;height:24px;align-items:center;gap:6px;padding:0 8px;font-size:var(--text-2xs);font-weight:500;text-transform:uppercase;letter-spacing:.04em;color:color-mix(in oklch,var(--rn-ink-soft),transparent 30%)}
.group:first-child .group-head .i{color:color-mix(in oklch,var(--rn-accent),transparent 30%)}

.proj{display:flex;flex-direction:column}
.proj-row{display:flex;height:28px;width:100%;align-items:center;gap:6px;border-radius:var(--radius-chip);padding:0 8px;text-align:left;font-size:var(--text-13);color:color-mix(in oklch,var(--rn-ink),transparent 10%);border:0;background:transparent;cursor:default;font-family:inherit}
.chev{display:flex;color:var(--rn-ink-soft)}
.chev.folded{transform:rotate(-90deg)}
.pmark{display:flex;color:var(--rn-ink-soft)}
.count{font-size:var(--text-2xs);color:var(--rn-ink-soft)}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proj-children{margin-left:12px;display:flex;flex-direction:column;gap:2px;border-left:1px solid var(--rn-line);padding-left:8px;padding-bottom:4px}

.session{display:flex;min-height:32px;width:100%;flex-direction:column;justify-content:center;gap:2px;border-radius:var(--radius-chip);padding:4px 8px;text-align:left;border:0;background:transparent;cursor:default;font-family:inherit}
.session.active{background:var(--rn-raised)}
.s-line{display:flex;align-items:center;gap:6px;min-width:0}
.s-line .i{color:var(--rn-ink-soft)}
.s-title{font-size:var(--text-13);line-height:1.2;color:color-mix(in oklch,var(--rn-ink),transparent 20%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session.active .s-title{color:var(--rn-ink)}
.tick{display:flex;color:var(--rn-green)}
.pinned{display:flex;color:color-mix(in oklch,var(--rn-ink-soft),transparent 40%)}
.unread{width:6px;height:6px;border-radius:999px;background:var(--rn-model);flex:0 0 auto}
.s-sub{padding-left:18px;font-size:var(--text-2xs);color:var(--rn-ink-soft)}
.newchat{display:flex;height:28px;align-items:center;gap:6px;border-radius:var(--radius-chip);padding:0 8px;font-size:var(--text-xs);color:color-mix(in oklch,var(--rn-ink-soft),transparent 40%);border:0;background:transparent;cursor:default;font-family:inherit;text-align:left}

.footer{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--rn-line);padding:8px}
.footer-controls{display:flex;align-items:center;gap:4px}
.icon-btn{width:32px;height:32px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-chip);color:var(--rn-ink-soft);border:0;background:transparent;cursor:default;padding:0}

/* ── collapsed state ───────────────────────────────────────────────── */
.collapsed-pair{display:flex;gap:24px;padding:16px;border-radius:8px;border:1px solid var(--rn-line-strong);background:var(--rn-canvas)}
.collapsed-stage{flex:1 1 0;min-width:0}
.stage-label{font-size:11px;font-weight:600;color:var(--rn-ink-soft);margin-bottom:8px}
.stage{position:relative;height:96px;border-radius:8px;border:1px dashed var(--rn-line-strong);background:
  repeating-linear-gradient(135deg,transparent 0 9px,color-mix(in oklch,var(--rn-ink),transparent 96%) 9px 10px),var(--rn-canvas)}

/* CornerSlot owner="floating": fixed top-1 left-1, h-8, rounded-full, border-line/60,
   bg-surface/70, backdrop-blur-md, pl-[72px] on darwin, pr-1.5, gap-2 */
.float-pill{position:absolute;top:4px;left:4px;z-index:40;display:flex;align-items:center;gap:8px;
  height:var(--pill-h);border-radius:999px;border:1px solid color-mix(in oklch,var(--rn-line-strong),transparent 40%);
  background:color-mix(in oklch,var(--rn-surface),transparent 30%);backdrop-filter:blur(12px);
  padding-left:72px;padding-right:6px}
.float-pill .lights{height:var(--pill-h);width:72px;padding-left:10px}
.orb{flex:0 0 auto}

/* the session top bar's floating chip layer: chip = border-line/60 bg-surface/70 blur */
.chip-layer{position:absolute;top:4px;right:8px;display:flex;align-items:center;gap:6px}
.chip{border:1px solid color-mix(in oklch,var(--rn-line-strong),transparent 40%);
  background:color-mix(in oklch,var(--rn-surface),transparent 30%);backdrop-filter:blur(12px);
  border-radius:999px;color:var(--rn-ink-soft);font-family:inherit}
.icon-chip{width:32px;height:32px;display:flex;align-items:center;justify-content:center;padding:0;cursor:default}
.pill-chip,.seg{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-size:var(--text-xs);font-weight:500;line-height:1rem;cursor:default}
.joined{display:flex;padding:0}
.seg{border:0;background:transparent;color:inherit;font-family:inherit;border-radius:999px}
.joined .seg:first-of-type{border-radius:999px 0 0 999px;padding-right:8px}
.joined .seg:last-of-type{border-radius:0 999px 999px 0;padding-left:8px}
.hair{width:1px;align-self:stretch;background:color-mix(in oklch,var(--rn-line-strong),transparent 40%)}

.legend{margin:10px 0 0;font-size:11px;line-height:1.55;color:var(--rn-ink-soft);max-width:100ch}
.legend code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:10.5px}
`;

const html = `<!doctype html>
<html lang="en" data-scheme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rennet — sidebar lockup placements</title>
<style>${css}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="rn-mark" viewBox="0 0 100 100">${markInner}</symbol>
  <symbol id="rn-wordmark" viewBox="${wordVB}">${wordInner}</symbol>
</svg>

<h1>Sidebar lockup placements</h1>
<p class="lede">Three placements for a bigger, more prominent mark, plus today's corner-slot lockup as the reference, at the real 256px panel width with the real sidebar contents. Palette, type, radii and the 81px macOS traffic-light reserve are taken from <code>packages/theme</code> and <code>packages/app-ui/src/shell</code>. The sphere and wordmark are the authored static SVGs (<code>brand/exports/logo/svg/</code>) — the shipping mark is the live <code>LiquidSphere</code>, same geometry.</p>

<h2>Expanded sidebar — light</h2>
<div class="grid">${VARIANTS.map((v) => column(v, "light")).join("")}</div>

<h2>Expanded sidebar — dark</h2>
<div class="grid">${VARIANTS.map((v) => column(v, "dark")).join("")}</div>

<h2>Collapsed — the floating orb against its neighbours</h2>
<p class="lede">The floating corner slot (<code>fixed top-1 left-1</code>, <code>rounded-full</code>, hairline, <code>bg-surface/70</code>, <code>backdrop-blur-md</code>, 72px mac reserve, the expand toggle) beside the session top bar's floating chip layer. The tallest neighbour in that layer is the 32px <code>size-8</code> icon chip; the History / Map · Diff pills render shorter than that (see note below).</p>
<div style="display:flex;flex-direction:column;gap:16px">
  ${collapsed("light")}
  ${collapsed("dark")}
</div>
<p class="legend"><strong>Measured, not assumed.</strong> <code>PillToggle</code> overrides the kit <code>Toggle</code>'s <code>h-8</code> with <code>h-auto … px-2.5 py-1 text-xs</code>, so History / Map / Diff render about 26px tall, not 32px. The 32px reference in that layer is the floating icon button (<code>size-8 rounded-full</code>). Option A keeps today's 32px pill and takes the orb to 28px (2px clearance top and bottom); option B grows the pill to 36px for a 32px orb — the orb then matches the icon chip exactly and stands 4px proud of the text pills, which is "almost but not quite" read against the pill layer rather than against the text chips.</p>

<h2>Reading the numbers</h2>
<p class="legend">
<strong>Today.</strong> 81 (light reserve) + 24 (mark) + 4 (authored gap) + 102.9 (wordmark) + 8 + 12 + 24 (toggle) = 255.9 of 256. <br>
<strong>1 · Own row.</strong> 40px corner row, then a 56px full-width row: mark ${P1.mark}px, wordmark ${P1.h} × ${P1.w}, authored gap ${P1.gap}px, left edge 16px (the content padding: <code>px-2</code> container + <code>px-2</code> row). <br>
<strong>2 · Stacked header.</strong> 40px corner row, then a 118px centred block: mark ${P2.mark}px over a ${P2.wordH} × ${P2.wordW} wordmark, 10px between them. <br>
<strong>3 · Mark leads.</strong> 40px corner row, then a 60px head row: mark ${P3.mark}px with the wordmark ${P3.wordH} × ${P3.wordW} set beside it as caption, both on the 16px edge. <br>
<strong>Shared constraint.</strong> All three strip the corner slot back to lights + toggle, so <code>CornerSlot</code> would need a variant that renders no <code>wordmark</code> child. The corner row stays the drag region (<code>app-region-drag</code> on darwin); the new lockup row is below it and does not drag unless it opts in. The toggle stays in the corner row, so collapsing/expanding focus hand-off (<code>[data-slot="corner-slot"] [aria-label="…"]</code>) is unchanged.
</p>
</body>
</html>
`;

writeFileSync(join(here, "index.html"), html);
console.log("wrote index.html", html.length, "bytes");
