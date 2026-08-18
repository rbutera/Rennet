// Rennet v4.0 — the navigation MODEL, drawn as one page (issue #297).
// Frame 17 is the journey map (forward flow); this is the STRUCTURE map: the wayfinding
// spine (breadcrumb + nav rail + palette), the destination tree with peer/child/overlay
// law, the history keys, one-review-at-a-time, and the patchset trail.
import { ic, dot, win, modePill, crumb, navRail, navCtx, patchsetChip } from './kit.mjs';

export const navModelCss = `
.nm-sec{ margin:0 0 22px; }
.nm-h{ font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin:0 0 12px; display:flex; align-items:center; gap:9px; }
.nm-h .n{ width:20px; height:20px; border-radius:50%; background:var(--ink); color:#fff; font-size:11px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; }

/* anatomy strip — a labeled reproduction of the real title-bar chrome */
.anat{ border:1px solid var(--line2); border-radius:12px; overflow:hidden; }
.anat .bar{ display:flex; align-items:center; gap:12px; height:52px; padding:0 16px; background:var(--titlebar); border-bottom:1px solid var(--line); }
.anat .tls{ display:flex; gap:8px; }
.anat .tl{ width:12px; height:12px; border-radius:50%; border:1.5px solid #c3c9d1; }
.anat .rmeta{ margin-left:auto; display:flex; align-items:center; gap:11px; }
.anat .labels{ display:flex; padding:11px 16px; gap:10px; background:#fbfcfd; }
.anat .lab{ flex:1; font-size:12px; color:var(--muted); line-height:1.45; }
.anat .lab b{ color:var(--text); font-weight:600; display:block; font-size:12.5px; margin-bottom:2px; }
.anat .lab .k{ font-family:var(--mono); color:var(--blue-ink); }

/* three spine layers */
.spine3{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
.slayer{ border:1px solid var(--line2); border-radius:12px; padding:15px 16px; }
.slayer .st{ font-size:14.5px; font-weight:650; display:flex; align-items:center; gap:9px; margin-bottom:4px; }
.slayer .sq{ font-family:var(--mono); font-size:11px; color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:5px; padding:2px 6px; }
.slayer .sd{ font-size:13px; color:var(--muted); line-height:1.5; margin:6px 0 10px; }
.slayer .cmds{ display:flex; flex-direction:column; gap:5px; }
.slayer .cmdrow{ display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text); }
.slayer .cmdrow svg{ width:14px; height:14px; color:#5a6069; }
.slayer .cmdrow .kh{ margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--faint); }

/* destination tree */
.tier{ display:flex; align-items:center; gap:12px; margin-bottom:11px; }
.tier .tlab{ flex:none; width:118px; font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); }
.tier .nodes{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.dnode{ display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line2); border-radius:10px; padding:8px 11px; background:#fff; font-size:13px; font-weight:550; }
.dnode svg{ width:15px; height:15px; color:#5a6069; }
.dnode .tag{ font-family:var(--mono); font-size:9.5px; letter-spacing:.04em; text-transform:uppercase; border-radius:4px; padding:1px 5px; }
.tag.peer{ color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); }
.tag.child{ color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); }
.tag.overlay{ color:var(--amber); background:var(--amber-bg); border:1px solid var(--amber-line); }
.tag.root{ color:var(--muted); background:#fff; border:1px solid var(--line2); }
.dnode.glass{ background:var(--glass); }
.dnode.arrowto{ border:none; background:transparent; padding:0; color:#aab0b8; }

/* the law rows */
.law{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.lawcard{ border:1px solid var(--line2); border-radius:11px; padding:13px 14px; }
.lawcard .lh{ font-size:13.5px; font-weight:650; display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.lawcard .lh .tag{ margin-left:auto; }
.lawcard .lb{ font-size:12.5px; color:var(--muted); line-height:1.5; }
.lawcard .lb b{ color:var(--text); }

/* history + one-review */
.hist{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.histcard{ border:1px solid var(--line2); border-radius:12px; padding:15px 16px; }
.histcard .ht{ font-size:14px; font-weight:650; margin-bottom:8px; display:flex; align-items:center; gap:9px; }
.histcard .stack{ display:flex; align-items:center; gap:7px; margin-bottom:10px; flex-wrap:wrap; }
.histcard .surf{ font-family:var(--mono); font-size:11.5px; border:1px solid var(--line2); border-radius:7px; padding:5px 9px; color:var(--muted); background:#fff; }
.histcard .surf.cur{ color:var(--text); font-weight:600; border-color:var(--line2); background:var(--glass); }
.histcard .surf.dim{ opacity:.5; }
.histcard .arrow{ color:#aab0b8; display:flex; }
.histcard .arrow svg{ width:14px; height:14px; }
.histcard p{ font-size:12.5px; color:var(--muted); line-height:1.5; margin:0; }
.histcard p b{ color:var(--text); }
.keys{ display:inline-flex; gap:6px; }
.kbd2{ font-family:var(--mono); font-size:11px; color:var(--faint); border:1px solid var(--line2); border-radius:6px; padding:2px 7px; }
`;

export function frame18() {
  // ── A · anatomy of the chrome ──
  const seg = (icon, label, cur) =>
    `<span class="cseg${cur ? ' cur' : ''}">${icon ? `<span class="cico">${icon}</span>` : ''}${label}</span>`;
  const sep = `<span class="csep">${ic.chevronR}</span>`;
  const anat = `<div class="anat">
    <div class="bar">
      <span class="tls"><span class="tl"></span><span class="tl"></span><span class="tl"></span></span>
      <span class="crumbs">${seg(ic.home, 'Projects')}${sep}${seg(ic.repo, 'orbital')}${sep}${seg(ic.branch, 'feat/rate-limiting', true)}</span>
      <span class="rmeta">${modePill}${patchsetChip('patchset 8', { trail: true })}<span style="color:#aab0b8;display:flex">${ic.palette}</span></span>
    </div>
    <div class="labels">
      <div class="lab"><b>Breadcrumb — where am I</b>The chain from the root to this surface. Click any crumb to ascend to it; the leaf is current. Lenses never appear here.</div>
      <div class="lab"><b>Mode pill</b>The execution-mode glyph — a contract on every in-project surface. It never moves.</div>
      <div class="lab"><b>Patchset chip + trail</b>Drops the patchset lineage (9 ‹ 8 ‹ 7); predecessors read-only.</div>
      <div class="lab"><b>Palette glyph <span class="k">⌘K</span></b>The keyboard spine — the Navigate group and recent locations.</div>
    </div>
  </div>`;

  // ── B · three spine layers ──
  const cmdrow = (icon, label, kh) => `<div class="cmdrow">${icon}${label}<span class="kh">${kh}</span></div>`;
  const spine3 = `<div class="spine3">
    <div class="slayer">
      <div class="st">${ic.chevronR}Breadcrumb <span class="sq">up</span></div>
      <div class="sd">Hierarchical position. Each crumb is a click that <b>ascends</b> one tier. It is the "where am I / how do I go up," not a history.</div>
      <div class="cmds"><div class="cmdrow">Projects › orbital › review › Draft</div><div class="cmdrow" style="color:var(--muted)">click a crumb → jump to that tier</div></div>
    </div>
    <div class="slayer">
      <div class="st">${ic.chevronL}Back / forward <span class="sq">undo nav</span></div>
      <div class="sd">A temporal history over <b>surfaces</b> — not lens switches, not scroll. In the left nav rail and on the keyboard. Different verb from the crumb.</div>
      <div class="cmds">${cmdrow(ic.chevronL, 'Back', '⌘[')}${cmdrow(ic.chevronR, 'Forward', '⌘]')}</div>
    </div>
    <div class="slayer">
      <div class="st">${ic.palette}Palette <span class="sq">keyboard spine</span></div>
      <div class="sd">A <b>Navigate</b> group on every screen, recent locations on an empty query. Where you can go, by name.</div>
      <div class="cmds">${cmdrow(ic.repo, 'Go to project…', '⌘P')}${cmdrow(ic.eye, 'Open review…', '⌘O')}${cmdrow(ic.palette, 'Open Settings', '⌘,')}</div>
    </div>
  </div>`;

  // ── C · the destination tree ──
  const node = (icon, label, tag, tagcls, glass) =>
    `<span class="dnode${glass ? ' glass' : ''}">${icon}${label}<span class="tag ${tagcls}">${tag}</span></span>`;
  const arw = `<span class="dnode arrowto">${ic.chevronR}</span>`;
  const tree = `<div>
    <div class="tier"><span class="tlab">Root</span><div class="nodes">${node(ic.home, 'Projects list', 'root', 'root', true)}${node(ic.plus, 'Add project', 'child', 'child')}${node(ic.palette, 'Settings', 'orbital', 'overlay')}</div></div>
    <div class="tier"><span class="tlab">Project</span><div class="nodes">${node(ic.repo, 'Project detail', 'child', 'child', true)}<span class="dnode arrowto" style="font-family:var(--mono);font-size:11px">the review’s real home</span></div></div>
    <div class="tier"><span class="tlab">Review · lenses</span><div class="nodes">${node('<span style="color:#5a6069">&lt;&gt;</span>', 'Files', 'peer', 'peer')}${node(ic.spec, 'Spec', 'peer', 'peer')}${node(ic.sequence, 'Sequence', 'peer', 'peer')}${node(ic.decisions, 'Decisions', 'peer', 'peer')}${node(ic.flag, 'Flagged', 'peer', 'peer')}${node(ic.noise, 'Noise', 'peer', 'peer')}</div></div>
    <div class="tier"><span class="tlab">Off the review</span><div class="nodes">${node(ic.decisions, 'Draft', 'child', 'child')}${arw}${node(ic.paper, 'Preview', 'child', 'child')}${node(ic.resteer, 'Re-review', 'child', 'child')}</div></div>
    <div class="tier"><span class="tlab">Transient</span><div class="nodes">${node(ic.discuss, 'Conversation / Ask', 'overlay', 'overlay')}${node(ic.inspector, 'Symbol inspector', 'overlay', 'overlay')}${node(ic.palette, 'Command palette', 'overlay', 'overlay')}</div></div>
  </div>`;

  // ── D · the law ──
  const law = `<div class="law">
    <div class="lawcard"><div class="lh">Lens <span class="tag peer">peer · tab</span></div><div class="lb">Files · Spec · Sequence · Decisions · Flagged · Noise are <b>tabs on one lens bar</b>. Switching one <b>never moves the crumb</b> — you have not gone anywhere.</div></div>
    <div class="lawcard"><div class="lh">Surface <span class="tag child">child · crumb</span></div><div class="lb">Project → review → Draft → Preview each <b>extend the crumb</b> by a segment. Esc or the crumb ascends one. These are the moves back/forward record.</div></div>
    <div class="lawcard"><div class="lh">Overlay <span class="tag overlay">neither</span></div><div class="lb">Conversation, inspector, palette, Settings-return: they <b>touch neither crumb nor history</b>. They open over where you are and close back to it.</div></div>
  </div>`;

  // ── E · history + one review at a time ──
  const hist = `<div class="hist">
    <div class="histcard">
      <div class="ht">${ic.chevronL}History records surfaces <span class="keys"><span class="kbd2">⌘[</span><span class="kbd2">⌘]</span></span></div>
      <div class="stack"><span class="surf dim">Projects</span><span class="arrow">${ic.chevronR}</span><span class="surf">orbital</span><span class="arrow">${ic.chevronR}</span><span class="surf cur">Sequence</span></div>
      <p><b>Back from a review lands on Project detail</b> — the review’s real home — not the front door. The stack holds surfaces (screen · review · destination), not lens flips or scroll.</p>
    </div>
    <div class="histcard">
      <div class="ht">${ic.eye}One review at a time</div>
      <div class="stack"><span class="surf cur">Review B open</span><span class="arrow">${ic.chevronR}</span><span class="surf dim">Review A evicted</span></div>
      <p>Opening review B <b>evicts A</b> — a deliberate property, no review tabs. History + <b>Resume</b> + recent-locations make returning to A a single keystroke, so eviction costs nothing.</p>
    </div>
  </div>`;

  const body = `<div class="nm-sec">
      <div class="nm-h"><span class="n">1</span>Anatomy of the chrome — the wayfinding spine lives in glass, and never publishes</div>${anat}
    </div>
    <div class="nm-sec"><div class="nm-h"><span class="n">2</span>Three spine layers, three jobs</div>${spine3}</div>
    <div class="nm-sec"><div class="nm-h"><span class="n">3</span>The destination tree — every place, classified</div>${tree}</div>
    <div class="nm-sec"><div class="nm-h"><span class="n">4</span>The law: tab vs crumb vs overlay</div>${law}</div>
    <div class="nm-sec" style="margin-bottom:0"><div class="nm-h"><span class="n">5</span>History &amp; one review at a time</div>${hist}</div>`;

  return {
    title: 'Rennet v4.0 · 18 Navigation model',
    head: { badge: '18', title: 'Navigation model: the wayfinding structure', pill: 'The map · new' },
    ref: 'the structure map (v4.0)\nspine · tree · law · history',
    sub: 'The model v4.0 is named for. Frame 17 draws the forward <b>journey</b>; this draws the <b>structure</b>: the hybrid spine (a title-bar <b>breadcrumb</b> for "where am I", a left <b>nav rail</b> with back/forward for "how did I get here", and the <b>palette</b> for "where can I go"), the full destination tree with every place tagged <b>peer / child / overlay</b>, the tab-vs-crumb-vs-overlay law, the history keys, and one-review-at-a-time. Pure UX — it only ever adds reachable places; it never interposes a gate.',
    css: navModelCss,
    win: win({
      name: crumb([
        { label: 'Projects', icon: ic.home, root: true },
        { label: 'orbital', icon: ic.repo },
        { label: 'feat/rate-limiting', icon: ic.branch, cur: true },
      ]),
      meta: `${modePill}${patchsetChip('patchset 8', { trail: true })}<span style="color:#aab0b8;display:flex">${ic.palette}</span>`,
      body,
      nav: navRail({
        back: true,
        fwd: true,
        ctx: navCtx([
          { icon: ic.repo, title: 'orbital' },
          { icon: ic.branch, on: true, title: 'feat/rate-limiting' },
        ]),
      }),
    }),
    notes: [
      { h: 'Hybrid spine, both halves.', b: 'The left nav rail is where you GO (back/forward · Home · Projects · the current lineage); the title-bar breadcrumb is where you ARE. Sidebar = where can I go; breadcrumb = where am I. Not either/or.' },
      { h: 'Back is a different verb from up.', b: 'The crumb is hierarchical up (ascend a tier); back/forward (⌘[ / ⌘]) is temporal undo of navigation over surfaces. Both drawn, because they answer different questions.' },
      { h: 'Peer / child / overlay is the whole grammar.', b: 'A lens is a peer tab (no crumb move); a surface is a child (extends the crumb, recorded in history); an overlay — Ask, inspector, palette, Settings-return — touches neither. Every destination in the app fits one bucket.' },
      { h: 'Reachability only — no gates.', b: 'Nothing here confirms, warns, or blocks. Back from a draft mid-edit just navigates away and the draft persists (state preservation, not are-you-sure). Wayfinding adds places; it never adds ceremony (Rule Zero).' },
    ],
  };
}
