import { ic, dot, win } from './kit.mjs';

// The populated projects list — the app's front door (Home). Same screen/chrome as
// 01-first-run, just with projects present. Home surfaces carry NO execution-mode
// glyph (that lives per-project); only the palette hint, exactly like 01.
const paletteMeta = `<span style="color:#aab0b8">${ic.palette}</span>`;

export const cssProjectsList = `
.plist{ padding:22px 6px 6px; }
.pl-label{ font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--faint); margin-bottom:16px; }

.pjrow{ display:flex; align-items:center; gap:15px; border:1px solid var(--line2); border-radius:13px;
  padding:15px 17px; margin-bottom:11px; background:#fff; position:relative; }
.pjrow.attn{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow: inset 3px 0 0 var(--blue); }
.pjrow.fresh{ background:#fbfcfd; }
.pjrow .gly{ flex:none; width:38px; height:38px; }
.pjrow .gly svg{ width:20px; height:20px; }
.pjrow .body{ flex:1; min-width:0; }
.pjrow .nm{ font-size:15.5px; font-weight:650; display:flex; align-items:center; gap:9px; }
.pjrow .path{ font-family:var(--mono); font-size:12.5px; color:var(--muted); margin:2px 0 0; }
.pjrow .repos{ font-family:var(--mono); font-size:12px; color:var(--muted); margin-top:6px;
  display:flex; align-items:center; gap:7px; }
.pjrow .repos svg{ width:13px; height:13px; }
.pjrow .meta{ font-family:var(--mono); font-size:12px; color:var(--faint); margin-top:6px;
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pjrow .right{ flex:none; display:flex; align-items:center; gap:11px; }
.openchev{ color:#aab0b8; display:flex; } .openchev svg{ width:18px; height:18px; }

.procdot{ width:9px; height:9px; border-radius:50%; background:var(--blue);
  box-shadow:0 0 0 4px rgba(61,124,171,.18); flex:none; display:inline-block; }
.proc-txt{ color:var(--blue-ink); display:inline-flex; align-items:center; gap:8px; }
.stale{ color:var(--amber); display:inline-flex; align-items:center; gap:5px; }
.stale svg{ width:13px; height:13px; }
.newtag{ font-family:var(--mono); font-size:11px; color:var(--faint); border:1px solid var(--line2);
  border-radius:6px; padding:3px 7px; }

.addrow{ display:flex; align-items:center; gap:14px; border:1.5px dashed var(--line2); border-radius:13px;
  padding:15px 17px; background:#fbfcfd; margin-top:3px; }
.addrow .plusbox{ width:38px; height:38px; border-radius:9px; border:1px solid var(--line2); background:#fff;
  display:flex; align-items:center; justify-content:center; color:#4a5059; flex:none; }
.addrow .plusbox svg{ width:20px; height:20px; }
.addrow .at{ font-size:14.5px; font-weight:600; color:var(--text); }
.addrow .as{ font-size:13px; color:var(--muted); margin-top:1px; }

.ambient{ margin:16px 0 0; display:flex; align-items:center; gap:9px; background:var(--blue-bg);
  border:1px solid var(--blue-line); box-shadow:inset 3px 0 0 var(--blue); border-radius:9px; padding:10px 13px; }
.ambient .hh{ font-family:var(--mono); font-size:12.5px; color:var(--blue-ink); }
.ambient .hh b{ color:var(--text); font-weight:600; }

.anno.gut{ left:-16px; }
`;

const needsYou = (n) =>
  `<span class="chip"><span style="color:#4a5059">${ic.eye}</span>needs you <b style="color:var(--text)">${n}</b></span>`;

export function frameProjectsList() {
  // A workspace row (multi-repo) leads with the repo glyph and lists its repos; a
  // single-repo row leads with the branch glyph and a branch count.
  const rowOrbital = `<div class="pjrow attn rel">
    <span class="anno gut" style="top:19px">${dot(1)}</span>
    <span class="anno gut" style="top:66px">${dot(3)}</span>
    <span class="gly" style="color:var(--blue)">${ic.repo}</span>
    <div class="body">
      <div class="nm">orbital</div>
      <div class="path">~/orbital</div>
      <div class="repos"><span style="color:#8a9099">${ic.branch}</span>atlas · navcore · atlas-docs</div>
      <div class="meta">3 repos · 11 branches<span>·</span>active 6m ago</div>
    </div>
    <div class="right">${needsYou(3)}<span class="chip amber">${ic.flag}CI 1</span><span class="openchev">${ic.chevronR}</span></div>
  </div>`;

  const rowAtlasMobile = `<div class="pjrow rel">
    <span class="gly" style="color:#4a5059">${ic.branch}</span>
    <div class="body">
      <div class="nm">atlas-mobile</div>
      <div class="path">~/code/atlas-mobile</div>
      <div class="meta">1 repo · 4 branches<span>·</span>synced 1h ago</div>
    </div>
    <div class="right"><span class="openchev">${ic.chevronR}</span></div>
  </div>`;

  const rowNavcore = `<div class="pjrow rel">
    <span class="anno gut" style="top:20px">${dot(4)}</span>
    <span class="gly" style="color:var(--blue)">${ic.repo}</span>
    <div class="body">
      <div class="nm">navcore-mono</div>
      <div class="path">~/work/navcore-mono</div>
      <div class="repos"><span style="color:#8a9099">${ic.branch}</span>navcore · gateway · edge · billing · docs</div>
      <div class="meta"><span class="proc-txt"><span class="procdot"></span>indexing · 214 files, 38 modules</span></div>
    </div>
    <div class="right"><span class="chip blue">reading</span></div>
  </div>`;

  const rowAtlas = `<div class="pjrow rel">
    <span class="gly" style="color:#4a5059">${ic.branch}</span>
    <div class="body">
      <div class="nm">atlas</div>
      <div class="path">~/code/atlas</div>
      <div class="meta">1 repo · 7 branches<span>·</span><span class="stale">${ic.refresh}map 6 days old · refresh</span></div>
    </div>
    <div class="right"><span class="openchev">${ic.chevronR}</span></div>
  </div>`;

  const rowFresh = `<div class="pjrow fresh rel">
    <span class="gly" style="color:#8a9099">${ic.branch}</span>
    <div class="body">
      <div class="nm">orbital-infra <span class="newtag">not opened yet</span></div>
      <div class="path">~/orbital-infra</div>
      <div class="meta">1 repo · 2 branches<span>·</span>added just now</div>
    </div>
    <div class="right"><span class="openchev">${ic.chevronR}</span></div>
  </div>`;

  const addRow = `<div class="addrow">
    <span class="plusbox">${ic.plus}</span>
    <div class="body"><div class="at">Add a project</div><div class="as">Point Rennet at another workspace or repo.</div></div>
  </div>`;

  const ambient = `<div class="ambient">
    <span style="color:var(--blue)">${ic.harness}</span>
    <span class="hh"><b>Claude · codex · gh</b> detected</span>
  </div>`;

  const body = `<div class="plist rel">
    <div class="pl-label rel"><span class="anno" style="left:-22px;top:-3px">${dot(2)}</span>Projects · 5</div>
    ${rowOrbital}${rowAtlasMobile}${rowNavcore}${rowAtlas}${rowFresh}
    ${addRow}
    ${ambient}
  </div>`;

  return {
    title: 'Rennet v4.0 · Projects list',
    head: { badge: '04a', title: 'Projects list: the populated home', pill: 'Home' },
    ref: 'the front door · same screen as first-run\nadd stays present · one row per project',
    sub: 'The everyday front door: every project you have added, one row each, most-recently-active first. A row is a whole <b>project</b> — a single repo or a <b>workspace</b> holding several repos. Add-a-project stays present as its own row, and harness detection stays the one ambient line it was on first run. Click a row to land in project detail.',
    css: cssProjectsList,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>Rennet`, meta: paletteMeta, body }),
    notes: [
      { h: 'What a row shows is my call.', b: 'Name, path, repos · branches, last-active, and a quiet needs-you count. Deliberately minimal — confirm the field set, or want more (author, CI, ahead/behind)?' },
      { h: 'Order is my call: most-recently-active.', b: 'No sort or filter chrome on the home list (you steered HOT-sort / needs-me-boost / filtering to project detail, not here). The needs-you row sits near the top only because it was just active. Prefer manual pinning, or none?' },
      { h: 'Workspace vs single repo, flagged.', b: 'A workspace leads with the repo glyph and lists its repos inline; a single repo leads with the branch glyph and a branch count. Is the inline repo list right, or a count with an expander?' },
      { h: 'Row states, proposed lightly.', b: 'Fresh/never-opened (orbital-infra, faint), processing (navcore-mono, the reused narration organ as a card state), and stale-map (atlas, refresh hint) are all drawn. Which of these deserve their own treatment?' },
    ],
  };
}
