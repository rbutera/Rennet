// Rennet v4.0 wireframes — shared design system, chrome, icon set.
// Emitted frames are self-contained (this CSS is inlined into every .html).

export const CSS = `
:root{
  --ground:#e7e9ec; --ink:#181b1f; --text:#1c1f24; --muted:#697079; --faint:#9aa1a9;
  --win:#ffffff; --titlebar:#f4f5f7; --glass:#eceff2; --card:#ffffff;
  --line:#e1e5e9; --line2:#d2d7dd;
  --blue:#3d7cab; --blue-ink:#2f6491; --blue-bg:#e9f1f8; --blue-line:#c2d8e9;
  --amber:#94690f; --amber-bg:#f6efdb; --amber-line:#e0cf98;
  --green:#3c7a45; --green-bg:#e7f0e8; --green-line:#bdd8be;
  --add:#3c7a45; --orange:#bf6a2f;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif;
  /* chrome is sans now (Rai: no monospace as UI elements). --mono aliases sans so every
     existing chrome reference flips automatically; only real code/diff uses --code. */
  --mono: var(--sans);
  --code: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
}
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; }
body{ background:var(--ground); color:var(--text); font-family:var(--sans);
  -webkit-font-smoothing:antialiased; text-rendering:geometricPrecision; }
.page{ width:1440px; margin:0 auto; padding:34px 40px 40px; }
.mono{ font-family:var(--mono); }

/* frame header */
.fhead{ display:flex; align-items:center; gap:14px; margin:0 0 12px; }
.badge{ flex:none; width:32px; height:32px; border-radius:8px; background:var(--ink); color:#fff;
  font-family:var(--mono); font-weight:600; font-size:14px; display:flex; align-items:center; justify-content:center; }
.ftitle{ font-size:23px; font-weight:650; letter-spacing:-.01em; margin:0; }
.pill{ font-family:var(--mono); font-size:11px; letter-spacing:.11em; text-transform:uppercase;
  color:var(--muted); border:1px solid var(--line2); background:#fff; border-radius:6px; padding:4px 9px; }
.fref{ margin-left:auto; text-align:right; white-space:pre-line; font-family:var(--mono);
  font-size:12px; line-height:1.5; color:var(--faint); }
.fsub{ color:var(--muted); font-size:15px; line-height:1.5; max-width:1080px; margin:0 0 20px; }
.fsub b{ color:var(--text); font-weight:600; }

/* app window */
.win{ background:var(--win); border:1px solid var(--line2); border-radius:14px; overflow:hidden;
  box-shadow: 0 1px 0 rgba(255,255,255,.6), 0 24px 50px -34px rgba(20,26,33,.42); }
.tbar{ display:flex; align-items:center; gap:12px; height:52px; padding:0 18px;
  background:var(--titlebar); border-bottom:1px solid var(--line); }
.tl{ width:12px; height:12px; border-radius:50%; border:1.5px solid #c3c9d1; }
.tls{ display:flex; gap:8px; margin-right:6px; }
.tname{ display:flex; align-items:center; gap:8px; font-weight:600; font-size:14.5px; }
.tmeta{ margin-left:auto; display:flex; align-items:center; gap:12px; font-family:var(--mono);
  font-size:12.5px; color:var(--muted); }
.content{ padding:26px 28px; }

/* icon box */
.gly{ flex:none; width:34px; height:34px; border-radius:8px; border:1px solid var(--line2);
  background:#fff; display:flex; align-items:center; justify-content:center; color:#2a2e34; }
.gly svg{ width:19px; height:19px; }
.gly.sm{ width:26px; height:26px; border-radius:7px; }
.gly.sm svg{ width:15px; height:15px; }
.gly.plain{ border:none; background:transparent; }
svg{ display:block; width:16px; height:16px; }
.i{ width:16px; height:16px; vertical-align:-3px; }

/* chips + buttons */
.chip{ font-family:var(--mono); font-size:12px; line-height:1; color:var(--muted);
  border:1px solid var(--line2); background:#fff; border-radius:6px; padding:5px 8px; display:inline-flex;
  align-items:center; gap:5px; white-space:nowrap; }
.chip.blue{ color:var(--blue-ink); background:var(--blue-bg); border-color:var(--blue-line); }
.chip.amber{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }
.chip.green{ color:var(--green); background:var(--green-bg); border-color:var(--green-line); }
.chip.ghost{ background:transparent; }
.btn{ font-family:var(--sans); font-size:13.5px; font-weight:550; color:var(--text); background:#fff;
  border:1px solid var(--line2); border-radius:8px; padding:8px 13px; display:inline-flex; align-items:center;
  gap:7px; cursor:default; white-space:nowrap; }
.btn.ink{ background:var(--ink); color:#fff; border-color:var(--ink); }
.btn.sm{ padding:6px 10px; font-size:12.5px; }
.btn svg{ width:15px; height:15px; }

/* generic rows/cards */
.card{ background:var(--card); border:1px solid var(--line2); border-radius:11px; }
.row{ display:flex; align-items:center; gap:14px; background:var(--card); border:1px solid var(--line2);
  border-radius:11px; padding:15px 16px; }
.row.backlight{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow: inset 3px 0 0 var(--blue); }
.muted{ color:var(--muted); } .faint{ color:var(--faint); }
.k{ font-family:var(--mono); }

/* designer notes footer */
.notes{ border:1.5px dashed var(--line2); border-radius:12px; padding:20px 24px; margin-top:20px; }
.notes-h{ font-family:var(--mono); font-size:12px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--faint); margin:0 0 14px; }
.notes-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px 40px; }
.note{ display:flex; gap:11px; font-size:14px; line-height:1.5; color:var(--muted); }
.note b{ color:var(--text); font-weight:600; }
.dot{ flex:none; width:20px; height:20px; border-radius:50%; background:var(--orange); color:#fff;
  font-family:var(--mono); font-size:11px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; }
.anno{ position:absolute; z-index:5; }
.rel{ position:relative; }
.sec-label{ font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
.modepill{ display:inline-flex; align-items:center; gap:7px; font-family:var(--sans); font-size:12.5px; color:var(--text);
  border:1px solid var(--line2); border-radius:7px; padding:5px 9px; background:#fff; }
.modepill svg{ width:14px; height:14px; }

/* ---- v4.0 navigation chrome ---- */
/* breadcrumb spine in the title bar (the "where am I") — glass, sans, interactive */
.crumbs{ display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.cseg{ display:inline-flex; align-items:center; gap:6px; font-size:14px; font-weight:550; color:var(--muted); }
.cseg .cico{ display:flex; color:#5a6069; }
.cseg .cico svg{ width:15px; height:15px; }
.cseg.cur{ color:var(--text); font-weight:650; }
.cseg.root{ color:var(--muted); }
.csep{ display:flex; color:#aab0b8; }
.csep svg{ width:13px; height:13px; }

/* the compact left nav rail (the "where can I go" controls): back/forward, home, projects, context */
.winmain{ display:flex; align-items:stretch; }
.winmain > .content{ flex:1; min-width:0; }
.navrail{ flex:none; width:64px; align-self:stretch; background:var(--glass); border-right:1px solid var(--line);
  display:flex; flex-direction:column; align-items:center; gap:13px; padding:16px 0 18px; }
.navbtn{ display:flex; flex-direction:column; align-items:center; gap:4px; color:var(--muted); }
.navbtn .gb{ width:34px; height:34px; border-radius:9px; border:1px solid var(--line2); background:#fff;
  display:flex; align-items:center; justify-content:center; color:#2a2e34; }
.navbtn .gb svg{ width:18px; height:18px; }
.navbtn .cap{ font-family:var(--mono); font-size:9px; letter-spacing:.02em; color:var(--faint); }
.navbtn.off{ opacity:.38; }
.navrail .sep{ width:28px; height:1px; background:var(--line2); }
.navrail .ctx{ margin-top:auto; display:flex; flex-direction:column; align-items:center; gap:6px; }
.navrail .ctx .cnode{ width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center;
  border:1px solid var(--line2); background:#fff; color:#5a6069; }
.navrail .ctx .cnode svg{ width:15px; height:15px; }
.navrail .ctx .cnode.on{ background:var(--blue-bg); border-color:var(--blue-line); color:var(--blue-ink); }
.navrail .ctx .cbar{ width:1.5px; height:9px; background:var(--line2); }
.navrail .ctx .clab{ font-family:var(--mono); font-size:8.5px; color:var(--faint); }

/* the patchset chip (title-bar meta) with an optional trail caret */
.psetchip{ display:inline-flex; align-items:center; gap:6px; font-family:var(--sans); font-size:12px; color:var(--text);
  border:1px solid var(--line2); border-radius:7px; padding:5px 9px; background:#fff; }
.psetchip svg{ width:13px; height:13px; color:#5a6069; }
.psetchip .pcaret{ display:flex; color:#aab0b8; }
.psetchip .pcaret svg{ width:12px; height:12px; }
`;

// --- icon set: stroke-only, greyscale (final art keeps semantics, refined) ---
const S = (inner, o = {}) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${o.w || 1.7}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const ic = {
  check: S('<path d="M4.5 12.5l5 5 10-11"/>'),
  reqchange: S('<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v4h-4"/>'),
  comment: S('<path d="M4 5.5h16v10H9l-4 3.5v-3.5H4z"/>'),
  question: S('<circle cx="12" cy="12" r="8.4"/><path d="M9.5 9.4a2.6 2.6 0 0 1 4.9 1.1c0 1.7-2.4 2-2.4 3.6"/><circle cx="12" cy="17.2" r=".7" fill="currentColor" stroke="none"/>'),
  discuss: S('<path d="M3 4.5h12v8H8l-3 2.6V12.5H3z"/><path d="M8.5 8.5h12v8h-2v2.6l-3-2.6H12"/>'),
  askharness: S('<path d="M4 5.5h16v9H9l-4 3v-3H4z"/><path d="M15 2.4l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7L12.5 5l1.7-.9z"/>'),
  spec: S('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13.5l1.7 1.7L14 11.8"/>'),
  sequence: S('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4.2" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.2" cy="12" r="1.3"/><path d="M3 17l1.2 1.2L6 16.4" />'),
  decisions: S('<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 8.4v7.2M8.3 6.9C13 7.5 15.6 8.9 16 10.6M8.2 17c4.8-.6 7.4-2 7.8-3.8"/>'),
  flag: S('<path d="M6 21V4"/><path d="M6 4.5h11l-2.2 4 2.2 4H6"/>'),
  coverage: S('<path d="M9.5 14.5l5-5"/><path d="M11 7l1.2-1.2a3.4 3.4 0 0 1 4.9 4.9L16 12"/><path d="M13 17l-1.2 1.2a3.4 3.4 0 0 1-4.9-4.9L8 12"/>'),
  peek: S('<circle cx="11" cy="11" r="6.4"/><path d="M11 6.8v8.4M6.8 11h8.4" opacity=".55"/><path d="M15.8 15.8L20 20"/>'),
  flask: S('<path d="M9 3h6"/><path d="M10 3v6.2L5.6 17a2 2 0 0 0 1.8 3h9.2a2 2 0 0 0 1.8-3L14 9.2V3"/><path d="M8 14.5h8"/>'),
  editor: S('<path d="M13 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7"/><path d="M14 4h6v6"/><path d="M11 13L20 4"/>'),
  inspector: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14 4.5v15"/><path d="M16.4 9l2 2-2 2" opacity=".7"/>'),
  orchestrator: S('<circle cx="6" cy="7" r="2.1"/><circle cx="18" cy="7" r="2.1"/><circle cx="12" cy="18" r="2.1"/><path d="M7.7 8.4l3 8M16.3 8.4l-3 8M8 7h8"/>'),
  harness: S('<path d="M12 3v18M3 12h18M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7"/>', { w: 1.5 }),
  sign: S('<path d="M3 20.5h18"/><path d="M15.5 4.6l3.9 3.9L9.6 18.3l-4.6 1 1-4.6z"/>'),
  palette: S('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 9.5h.01M10.5 9.5h.01M14 9.5h.01M7.5 13.5h9" />'),
  repo: S('<path d="M5 4.5h11a2 2 0 0 1 2 2v13"/><path d="M18 16.5H7a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h11z"/><path d="M5 4.5v12"/>'),
  branch: S('<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="8" r="2.3"/><path d="M6.5 8.3v7.4"/><path d="M17.5 10.3c0 4-3.5 4.4-6.4 5.2"/>'),
  pr: S('<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="18" r="2.3"/><path d="M6.5 8.3v7.4"/><path d="M17.5 15.7V10a3 3 0 0 0-3-3h-3M13 4.5L10.5 7 13 9.5"/>'),
  makepr: S('<path d="M6 18L18 6"/><path d="M9 6h9v9"/>'),
  resteer: S('<path d="M20 5.5A8.3 8.3 0 1 0 21 12"/><path d="M20 4.5V9h-4.5"/><path d="M9 12l2.5 2.5L16 10" opacity=".6"/>'),
  auto: S('<path d="M12 4v16M4 12h16M6 6l12 12M18 6L6 18"/>', { w: 1.4 }),
  lock: S('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  search: S('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>'),
  filter: S('<path d="M4 5.5h16l-6 7v5l-4 2v-7z"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-2.3 5.3"/><path d="M20 5v5h-5"/>'),
  eye: S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  play: S('<path d="M7 5l11 7-11 7z"/>'),
  paper: S('<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3"/><path d="M9 12h6M9 15.5h6M9 8.5h3"/>'),
  dotpause: S('<circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/>'),
  cmd: S('<path d="M9 4.5A2.5 2.5 0 1 0 11.5 7v10A2.5 2.5 0 1 0 9 19.5"/><path d="M15 4.5A2.5 2.5 0 1 1 12.5 7v10a2.5 2.5 0 1 1 2.5 2.5" transform="translate(0.5 0)"/>'),
  chevron: S('<path d="M8 10l4 4 4-4"/>'),
  chevronR: S('<path d="M9 6l6 6-6 6"/>'),
  chevronL: S('<path d="M15 6l-6 6 6 6"/>'),
  home: S('<path d="M4 11l8-7 8 7"/><path d="M6.5 9.5V20h4v-6h3v6h4V9.5"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  dotsdrag: S('<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"/>', { w: 1.4 }),
  noise: S('<path d="M2 12h3.5l2-6.5 3 13 2.4-9 1.6 3.5H22"/>'),
  github: S('<path d="M15 21.5v-3.4a4.2 4.2 0 0 0-.9-3c2.7 0 5.4-1.8 5.4-4.9.07-1.1-.24-2.2-.9-3.1.25-1 .25-2.1 0-3.1 0 0-.9 0-2.7 1.3a12 12 0 0 0-7.2 0C6.9 4 6 4 6 4c-.27 1-.27 2.1 0 3.1a4.9 4.9 0 0 0-.9 3.1c0 3.1 2.7 4.9 5.4 4.9a4.2 4.2 0 0 0-.9 3v3.4"/><path d="M9.6 18.6c-3.6 1.6-4-1.6-5.6-1.6"/>'),
};

// the title-bar execution-mode glyph (auto default) — on every in-project surface
export const modePill = `<span class="modepill"><span style="color:#2a2e34">${ic.harness}</span>auto<span style="color:#aab0b8">${ic.chevron}</span></span>`;

// annotation dot (numbered orange), optionally positioned
export const dot = (n, style = '') => `<span class="dot"${style ? ` style="${style}"` : ''}>${n}</span>`;
export const anno = (n, style) => `<span class="anno" style="${style}">${dot(n)}</span>`;

export const traffic = `<span class="tls"><span class="tl"></span><span class="tl"></span><span class="tl"></span></span>`;

// full self-contained document
export function doc({ title, head, sub, ref, win, notes, css = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><style>${CSS}${css}</style></head>
<body><div class="page">
  <div class="fhead">
    <span class="badge">${head.badge}</span>
    <h1 class="ftitle">${head.title}</h1>
    <span class="pill">${head.pill}</span>
    <div class="fref">${ref}</div>
  </div>
  <p class="fsub">${sub}</p>
  ${win}
  <div class="notes"><div class="notes-h">Designer notes &nbsp;/&nbsp; what to weigh in on</div>
    <div class="notes-grid">${notes.map((n, i) => `<div class="note">${dot(i + 1)}<div><b>${n.h}</b> ${n.b}</div></div>`).join('')}</div>
  </div>
</div></body></html>`;
}

// --- v4.0 navigation helpers ---

// interactive breadcrumb chain for the title bar. segments: [{label, icon?, cur?, root?}]
// lenses never appear here (they are tabs); the leaf is the current surface.
export function crumb(segments) {
  return `<span class="crumbs">${segments
    .map(
      (s, i) =>
        `${i ? `<span class="csep">${ic.chevronR}</span>` : ''}<span class="cseg${s.cur ? ' cur' : ''}${s.root ? ' root' : ''}">${s.icon ? `<span class="cico">${s.icon}</span>` : ''}${s.label}</span>`,
    )
    .join('')}</span>`;
}

// the compact left nav rail. back/forward are the temporal history (⌘[ / ⌘]); home + projects
// jump; ctx nodes show the current project → review lineage. Muted when history is empty.
export function navRail({ back = true, fwd = false, ctx } = {}) {
  const btn = (icon, cap, off) =>
    `<span class="navbtn${off ? ' off' : ''}"><span class="gb">${icon}</span><span class="cap">${cap}</span></span>`;
  return `<div class="navrail">
    ${btn(ic.chevronL, '⌘[', !back)}
    ${btn(ic.chevronR, '⌘]', !fwd)}
    <span class="sep"></span>
    ${btn(ic.home, 'Home')}
    ${btn(ic.repo, 'Projects')}
    ${ctx || ''}
  </div>`;
}

// current-review context stack for the bottom of the nav rail
export function navCtx(nodes) {
  return `<div class="ctx">${nodes
    .map(
      (n, i) =>
        `${i ? '<span class="cbar"></span>' : ''}<span class="cnode${n.on ? ' on' : ''}" title="${n.title || ''}">${n.icon}</span>`,
    )
    .join('')}<span class="clab">here</span></div>`;
}

export function patchsetChip(label, { trail = false } = {}) {
  return `<span class="psetchip">${ic.resteer}${label}${trail ? `<span class="pcaret">${ic.chevron}</span>` : ''}</span>`;
}

// window helper. Pass `nav` (a navRail) to add the compact left nav rail beside the content.
export function win({ name, meta, body, nav }) {
  const inner = nav
    ? `<div class="winmain">${nav}<div class="content">${body}</div></div>`
    : `<div class="content">${body}</div>`;
  return `<div class="win"><div class="tbar">${traffic}<span class="tname">${name}</span><span class="tmeta">${meta}</span></div>${inner}</div>`;
}
