import { ic, dot, win, modePill } from './kit.mjs';

const cl4 = () => `<span class="cluster"><i>${ic.comment}</i><i>${ic.reqchange}</i><i>${ic.question}</i><i>${ic.discuss}</i></span>`;
// title-bar meta = the mode glyph (auto) then whatever else the frame states
const tmeta = (extra) => `${modePill}${extra ? `<span>${extra}</span>` : ''}`;

/* ---------- 11 Collation draft ---------- */
export const css11 = `
.draftgrid{ display:grid; grid-template-columns:1fr 262px; gap:20px; }
.draft-top{ display:flex; align-items:center; gap:10px; margin-bottom:16px; }
.draft-top .right{ margin-left:auto; display:flex; gap:9px; }
.ditem{ border:1px solid var(--line2); border-radius:11px; padding:13px 15px; margin-bottom:11px; display:flex; gap:12px; }
.ditem .drag{ color:#b7bec6; flex:none; margin-top:2px; }
.ditem .db{ flex:1; min-width:0; }
.ditem .dh{ display:flex; align-items:center; gap:9px; margin-bottom:7px; }
.ditem .verb{ font-family:var(--mono); font-size:11.5px; border-radius:6px; padding:3px 8px; }
.verb.rc{ color:var(--amber); background:var(--amber-bg); border:1px solid var(--amber-line); }
.verb.cm{ color:var(--muted); background:#fff; border:1px solid var(--line2); }
.ditem .loc{ font-family:var(--mono); font-size:12px; color:var(--muted); }
.ditem .refined{ font-size:14px; line-height:1.5; }
.ditem .refined b{ font-weight:600; }
.ditem .raw{ font-size:12.5px; color:var(--faint); text-decoration:line-through; margin-top:4px; }
.ditem .cl-right{ margin-left:auto; }
.ask-draft{ display:flex; align-items:center; gap:10px; border:1px dashed var(--line2); border-radius:11px; padding:13px 15px; margin-top:2px; }
.ask-draft .k{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--faint); }
.dpanel .pblock{ border:1px solid var(--line2); border-radius:11px; padding:13px 14px; margin-bottom:11px; }
.dpanel .pl{ font-family:var(--mono); font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin-bottom:5px; }
.dpanel .pv{ font-size:20px; font-weight:650; font-family:var(--mono); }
.dpanel .pv.sm{ font-size:15px; }
.dpanel .pblock.ok{ background:var(--amber-bg); border-color:var(--amber-line); }
.dpanel .next{ background:#fbf6ea; border:1px solid var(--amber-line); border-radius:11px; padding:14px; }
.dpanel .next .nh{ font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:8px; margin-bottom:5px; }
.dpanel .next p{ font-size:12.5px; color:var(--muted); margin:0 0 11px; line-height:1.45; }
`;
export function frame11() {
  const item = (n, verb, verbCls, loc, refined, raw, annoN) => `<div class="ditem rel">${annoN ? `<span class="anno" style="left:-30px;top:14px">${dot(annoN)}</span>` : ''}<span class="drag">${ic.dotsdrag}</span><div class="db"><div class="dh"><span class="verb ${verbCls}">${verb}</span><span class="loc">${loc}</span><span class="cl-right">${cl4()}</span></div><div class="refined"><b>refined:</b> ${refined}</div>${raw ? `<div class="raw">raw: ${raw}</div>` : ''}</div></div>`;

  const main = `<div>
    ${item(1, 'request-change', 'rc', 'keys.ts · L18-19', 'Re-keying from API key to org changes what a 429 means for existing clients; document the migration note in the PR body.', 'this breaks per-key clients?? add note', 2)}
    ${item(2, 'comment', 'cm', 'rate-limit.ts · L44', 'The fail-open path is defensible but unbounded: consider a process-local fallback bucket (see decision 2).', null)}
    ${item(3, 'request-change', 'rc', 'migrations/0042', 'The backfill is irreversible and has no down migration. Please add a rollback path before merge.', null)}
    <div class="ask-draft rel"><span class="anno" style="left:-30px;top:14px">${dot(3)}</span>${ic.orchestrator}<span>Ask the orchestrator about this draft</span><span class="k">it proposes; you accept, it never writes it</span></div>
  </div>`;

  const panel = `<div class="dpanel rel">
    <span class="anno" style="left:-2px;top:-2px">${dot(4)}</span>
    <div class="pblock"><div class="pl">Items</div><div class="pv sm">3 · from 5</div></div>
    <div class="pblock"><div class="pl">Verdict · derived</div><div class="pv sm">Request changes</div></div>
    <div class="pblock ok"><div class="pl" style="color:var(--amber)">${ic.check} residue 0</div><div style="font-size:12.5px;color:var(--muted)">sign unblocked</div></div>
    <div class="next"><div class="nh">${ic.paper}Next: paper <span class="chip">freeze</span></div><p>Signing crystallises this glass. Editing lives here, never on the paper.</p><button class="btn ink" style="width:100%;justify-content:center">${ic.paper}Review the paper</button></div>
  </div>`;

  const body = `<div class="draft-top"><span class="chip blue">${ic.decisions}editable · yours</span><div class="right"><button class="btn ink">${ic.comment}Refine to post</button><button class="btn">${ic.resteer}Compose handoff</button></div></div><div class="draftgrid">${main}${panel}</div>`;

  return {
    title: 'Rennet v3.3 · 11 Collation draft',
    head: { badge: '11', title: 'Collation draft: the one editable draft', pill: 'Draft' },
    ref: 'the missing middle\neditable glass between lenses and paper',
    sub: 'The editable draft between the lenses and the paper: your dispositions collated into a document-in-formation, one click back to each anchor. Every staged item carries the inline conversation cluster, so you can question or discuss a staged chunk before signing. The orchestrator proposes; you dispose. Editing lives here; the paper is a freeze.',
    css: css11,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.decisions}</span>#482 · Collation draft`, meta: tmeta('review to post'), body }),
    notes: [
      { h: 'The one editable surface.', b: 'The glass draft between the lenses and the paper. The raw note becomes a refined comment; the strikethrough keeps what you actually typed visible.' },
      { h: 'Merge, split, reorder, withdraw.', b: 'Via the drag handle and item controls, plus the inline cluster on every staged item. You can still question or discuss a staged chunk here.' },
      { h: 'The orchestrator proposes; you dispose.', b: 'It can suggest refinements and accept or dismiss, but it never writes the draft. The draft is yours.' },
      { h: 'Sign is downstream.', b: 'The verdict here is derived (request changes) and the panel shows the paper is unblocked. Editing lives on the draft; the paper only freezes it.' },
    ],
  };
}

/* ---------- 12 Paper / sign ---------- */
export const css12 = `
.papergrid{ display:grid; grid-template-columns:1fr 292px; gap:20px; }
.paper{ background:#fdfdfb; border:1px solid #e6e2d6; border-radius:12px; box-shadow:0 1px 0 #fff inset, 0 14px 30px -22px rgba(90,80,50,.35); padding:20px 22px; }
.paper .ph{ display:flex; align-items:center; gap:10px; border-bottom:1px solid #ece7d8; padding-bottom:13px; margin-bottom:14px; }
.paper .ph .vd{ font-size:16px; font-weight:650; }
.paper .ph .tg{ margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--amber); background:var(--amber-bg); border:1px solid var(--amber-line); border-radius:6px; padding:3px 8px; }
.paper .cmt{ padding:11px 0; border-bottom:1px solid #ece7d8; }
.paper .cmt:last-child{ border:none; }
.paper .cmt .ch{ font-family:var(--mono); font-size:12px; color:var(--muted); display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.paper .cmt .cb{ font-size:13.5px; line-height:1.5; }
.signpanel .vblock{ border:1px solid var(--line2); border-radius:12px; padding:15px; margin-bottom:12px; }
.signpanel .pl{ font-family:var(--mono); font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin-bottom:6px; }
.signpanel .derived{ font-size:17px; font-weight:650; margin-bottom:8px; }
.signpanel .deriv-note{ font-size:12.5px; color:var(--muted); line-height:1.5; }
.signpanel .override{ display:flex; align-items:center; gap:8px; margin-top:11px; font-family:var(--mono); font-size:12.5px; border:1px solid var(--line2); border-radius:8px; padding:9px 11px; }
.signpanel .override .k{ margin-left:auto; color:var(--faint); }
.holdsign{ margin-top:2px; border:1px solid var(--ink); background:var(--ink); color:#fff; border-radius:12px; padding:15px; text-align:center; }
.holdsign .hs{ font-size:15px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:9px; }
.holdsign .track{ height:6px; border-radius:3px; background:rgba(255,255,255,.22); margin-top:11px; overflow:hidden; }
.holdsign .track i{ display:block; height:100%; width:38%; background:#fff; border-radius:3px; }
.holdsign .hint{ font-family:var(--mono); font-size:11px; color:rgba(255,255,255,.7); margin-top:8px; }
`;
export function frame12() {
  const paper = `<div class="paper rel">
    <span class="anno" style="left:-30px;top:14px">${dot(1)}</span>
    <div class="ph"><span style="color:#8a7f5a">${ic.paper}</span><span class="vd">Review · #482</span><span class="tg">exactly what will post</span></div>
    <div class="cmt"><div class="ch">${ic.reqchange}keys.ts · L18-19 · request change</div><div class="cb">Re-keying from API key to org changes what a 429 means for existing clients; document the migration note in the PR body.</div></div>
    <div class="cmt"><div class="ch">${ic.comment}rate-limit.ts · L44 · comment</div><div class="cb">The fail-open path is defensible but unbounded: consider a process-local fallback bucket (see decision 2).</div></div>
    <div class="cmt"><div class="ch">${ic.reqchange}migrations/0042 · request change</div><div class="cb">The backfill is irreversible and has no down migration. Please add a rollback path before merge.</div></div>
  </div>`;

  const panel = `<div class="signpanel">
    <div class="vblock rel"><span class="anno" style="left:-30px;top:14px">${dot(2)}</span><div class="pl">Verdict · derived from dispositions</div><div class="derived">Request changes</div><div class="deriv-note">2 request-changes · 1 comment. Rennet derives the verdict; you can override it, and your sign is what makes it real.</div><div class="override rel"><span class="anno" style="left:-30px;top:8px">${dot(3)}</span>${ic.check}override<span class="k">Approve · Request changes · Comment ${ic.chevron}</span></div></div>
    <div class="holdsign rel"><span class="anno" style="left:-30px;top:16px">${dot(4)}</span><div class="hs">${ic.sign}Hold to sign</div><div class="track"><i></i></div><div class="hint">the deliberate act · nothing posts until you do</div></div>
  </div>`;

  const body = `<div class="draft-top" style="margin-bottom:16px"><span class="chip">${ic.paper}paper · solid</span><span class="chip">nothing editable here</span></div><div class="papergrid">${paper}${panel}</div>`;

  return {
    title: 'Rennet v3.3 · 12 Paper / sign',
    head: { badge: '12', title: 'Paper: the one thing you sign', pill: 'Sign' },
    ref: 'the derived verdict + the human sign\nsign in the loop IS the safety',
    sub: 'The one solid object. It previews <b>exactly</b> what will post, nothing editable. The verdict is derived from your dispositions (here, request changes) and shown with its derivation, and you can override it. The human sign carries the real verdict: the sign in the loop is the safety, not a forced-neutral event.',
    css: css11 + css12,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px;color:#8a7f5a">${ic.paper}</span>#482 · Paper`, meta: tmeta('sign to post'), body }),
    notes: [
      { h: 'The one solid object.', b: 'Paper is opaque: it shows precisely the comments that will land on the PR, in the order they will land. Editing happened on the draft; here it is frozen.' },
      { h: 'The verdict is derived.', b: 'Rennet reads your dispositions and derives Approve / Request changes / Comment, and shows the arithmetic (2 request-changes, 1 comment).' },
      { h: 'Override is yours.', b: 'The derived verdict is a default, not a lock. You can change it before signing; the review carries whatever you sign.' },
      { h: 'The sign is the safety.', b: 'Rennet never forces a neutral event. The human sign in the loop is the safeguard, and it publishes the real verdict.' },
    ],
  };
}

/* ---------- 13 Questions ---------- */
export const css13 = `
.qcomposer{ border:1px solid var(--line2); border-radius:12px; padding:14px 16px; margin-bottom:18px; }
.qcomposer .qf{ display:flex; align-items:center; gap:10px; }
.qcomposer .qph{ flex:1; color:var(--faint); font-size:14px; }
.splitsend{ display:flex; border:1px solid var(--ink); border-radius:8px; overflow:hidden; }
.splitsend .s1{ background:var(--ink); color:#fff; font-size:13px; font-weight:550; padding:8px 12px; display:flex; align-items:center; gap:7px; }
.splitsend .s2{ background:var(--ink); color:#fff; padding:8px 9px; border-left:1px solid rgba(255,255,255,.25); display:flex; align-items:center; }
.qmenu{ margin-top:10px; border:1px solid var(--line2); border-radius:10px; overflow:hidden; max-width:320px; }
.qmenu .mrow{ display:flex; align-items:center; gap:10px; padding:10px 13px; font-size:13.5px; border-bottom:1px solid var(--line); }
.qmenu .mrow:last-child{ border:none; }
.qmenu .mrow.on{ background:var(--glass); font-weight:600; }
.qmenu .mrow .k{ margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--faint); }
.qthread{ margin-top:6px; }
.qask{ font-size:13.5px; color:var(--muted); margin-bottom:10px; }
.qask b{ color:var(--text); }
.twoans{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.ansc{ border:1px solid var(--line2); border-radius:11px; overflow:hidden; }
.ansc .ah{ font-family:var(--mono); font-size:12.5px; font-weight:600; display:flex; align-items:center; gap:8px; padding:10px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.ansc .ab{ padding:12px 13px; font-size:13px; color:var(--text); line-height:1.55; }
.nosynth{ text-align:center; font-family:var(--mono); font-size:12px; color:var(--faint); margin-top:14px; display:flex; align-items:center; gap:8px; justify-content:center; }
`;
export function frame13() {
  const composer = `<div class="qcomposer rel">
    <span class="anno" style="left:-30px;top:14px">${dot(1)}</span>
    <div class="qf"><span style="color:#5a6069">${ic.orchestrator}</span><span class="qph">Ask about this review</span><span class="splitsend rel"><span class="anno" style="right:-2px;top:-30px">${dot(2)}</span><span class="s1">${ic.askharness}Ask</span><span class="s2">${ic.chevron}</span></span></div>
    <div class="qmenu"><div class="mrow on">${ic.orchestrator}Ask the orchestrator<span class="k">default</span></div><div class="mrow">${ic.harness}Ask both models<span class="k">two answers</span></div></div>
  </div>`;

  const thread = `<div class="qthread rel">
    <span class="anno" style="left:-30px;top:0">${dot(3)}</span>
    <div class="qask"><b>You asked both:</b> is the retry-after header in seconds or milliseconds, and does the client agree?</div>
    <div class="twoans">
      <div class="ansc"><div class="ah"><span style="color:var(--blue)">${ic.orchestrator}</span>Orchestrator · Claude</div><div class="ab">The header carries milliseconds here. The spec text says seconds, so the field name is misleading even though the value is internally consistent. Worth a rename, not a behaviour change.</div></div>
      <div class="ansc"><div class="ah"><span style="color:var(--amber)">${ic.harness}</span>codex</div><div class="ab">Milliseconds. The client wrapper divides by 1000 on read, so end to end it is correct. I would only add a doc comment naming the unit.</div></div>
    </div>
    <div class="nosynth">${ic.flag}no synthesis block · two answers, side by side · you decide</div>
  </div>`;

  const body = `${composer}${thread}`;

  return {
    title: 'Rennet v3.3 · 13 Questions',
    head: { badge: '13', title: 'Questions: the orchestrator, by default', pill: 'Ask' },
    ref: 'orchestrator-only default\nask both is an opt-in split',
    sub: 'Every question goes to the orchestrator by default. The send control carries one small split: ask both models, remembered per thread, never sticky globally. When you ask both, the answers arrive as two labeled cards, side by side. There is no synthesis block, ever: the robotic auto-merge is gone.',
    css: css13,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.orchestrator}</span>#482 · Ask`, meta: tmeta('orchestrator by default'), body }),
    notes: [
      { h: 'Orchestrator by default.', b: 'Every question goes to the one harness you converse with. Nothing auto-fires to a second model behind your back.' },
      { h: 'Ask both is a split, not a mode.', b: 'A small caret on the send control offers “ask both models”, remembered per thread and never sticky globally.' },
      { h: 'Two answers, labeled.', b: 'When both are asked, you get two cards side by side, each named by its model. You read them yourself.' },
      { h: 'No synthesis, ever.', b: 'Rennet never manufactures a merged answer. If the two disagree, that disagreement is itself something you can ask the orchestrator about.' },
    ],
  };
}

/* ---------- 14 Settings ---------- */
export const css14 = `
.setgrid{ display:grid; grid-template-columns:1fr 320px; gap:22px; }
.ladder{ display:flex; gap:8px; margin-bottom:14px; }
.ltab{ font-family:var(--mono); font-size:12.5px; padding:7px 12px; border:1px solid var(--line2); border-radius:8px; background:#fff; color:var(--muted); }
.ltab.on{ background:var(--ink); color:#fff; border-color:var(--ink); }
.setrow{ display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--line); }
.setrow:last-child{ border:none; }
.setrow .sk{ font-size:13.5px; font-weight:600; }
.setrow .sd{ font-size:12.5px; color:var(--muted); }
.setrow .sv{ margin-left:auto; display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:12.5px; }
.inherit{ font-family:var(--mono); font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--faint); border:1px solid var(--line2); border-radius:5px; padding:2px 6px; }
.inherit.set{ color:var(--blue-ink); background:var(--blue-bg); border-color:var(--blue-line); }
.instr{ border:1px solid var(--line2); border-radius:12px; overflow:hidden; }
.instr .ih{ font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:10px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.instr .ib{ padding:13px; font-size:13px; color:var(--muted); line-height:1.55; }
.instr .ib b{ color:var(--text); }
`;
export function frame14() {
  const left = `<div class="rel"><span class="anno" style="left:-30px;top:34px">${dot(2)}</span>
    <div class="ladder rel"><span class="anno" style="left:-30px;top:6px">${dot(1)}</span><span class="ltab">Global</span><span class="ltab on">Workspace · orbital</span><span class="ltab">Repo · atlas</span></div>
    <div class="setrow"><div><div class="sk">Execution mode</div><div class="sd">default when opening a review</div></div><div class="sv"><span class="modepill">${ic.harness}auto</span><span class="inherit">from global</span></div></div>
    <div class="setrow"><div><div class="sk">Worktree location</div><div class="sd">where new checkouts are created</div></div><div class="sv"><span>~/orbital/.worktrees</span><span class="inherit set">set here</span></div></div>
    <div class="setrow"><div><div class="sk">Review harness</div><div class="sd">the session you converse with</div></div><div class="sv"><span>Claude Code</span><span class="inherit">from global</span></div></div>
    <div class="setrow"><div><div class="sk">Light-tier harness</div><div class="sd">cheap thinking, off the reviewer</div></div><div class="sv"><span>codex</span><span class="inherit set">set here</span></div></div>
  </div>`;

  const right = `<div class="rel"><span class="anno" style="left:-2px;top:-2px">${dot(3)}</span>
    <div class="instr"><div class="ih">Per-repo guidance · atlas</div><div class="ib"><b>House rules the harness reads before every review.</b><br><br>Prefer table-driven tests. Flag any new dependency. Public contracts in src/**/keys.ts need a migration note.</div></div>
  </div>`;

  const body = `<div class="setgrid">${left}${right}</div>`;

  return {
    title: 'Rennet v3.3 · 14 Settings',
    head: { badge: '14', title: 'Settings and instructions', pill: 'Cross-cutting' },
    ref: 'the layered config ladder\nglobal › workspace › repo',
    sub: 'Terse. Config layers: global, then workspace, then repo, each overriding the last, with every row showing where its value comes from. Per-repo guidance is the house rules the harness reads before every review. The execution-mode default lives here and surfaces as the title-bar glyph.',
    css: css14,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.palette}</span>Settings`, meta: tmeta('orbital'), body }),
    notes: [
      { h: 'Terse.', b: 'Facts and their source, no prose. Every row states its value and whether it is inherited or set here.' },
      { h: 'The ladder.', b: 'Global to workspace to repo, each overriding the last. A project you only spectate can sit in read-only without dragging your own repos with it.' },
      { h: 'Per-repo guidance.', b: 'The house rules the harness reads before every review, plus where new worktrees get created. The mode default lives here and in the title bar.' },
    ],
  };
}

/* ---------- 15 Command palette ---------- */
export const css15 = `
.pal-backdrop{ background:var(--glass); border-radius:10px; padding:60px 0; display:flex; justify-content:center; position:relative; }
.palette{ width:560px; background:#fff; border:1px solid var(--line2); border-radius:14px; box-shadow:0 30px 70px -24px rgba(20,26,33,.5); overflow:hidden; }
.palette .pinput{ display:flex; align-items:center; gap:11px; padding:15px 18px; border-bottom:1px solid var(--line); }
.palette .pinput .cue{ color:var(--faint); font-size:15px; flex:1; }
.palette .pinput .kbd{ font-family:var(--mono); font-size:12px; color:var(--faint); border:1px solid var(--line2); border-radius:6px; padding:3px 7px; }
.pcmd{ display:flex; align-items:center; gap:12px; padding:11px 18px; font-size:14px; border-bottom:1px solid var(--line); }
.pcmd:last-child{ border:none; }
.pcmd.on{ background:var(--glass); }
.pcmd .pg{ color:#5a6069; display:flex; }
.pcmd .kh{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--faint); }
.pcmd .grp{ font-family:var(--mono); font-size:11px; color:var(--faint); }
`;
export function frame15() {
  const cmd = (icon, label, keys, on) => `<div class="pcmd${on ? ' on' : ''}"><span class="pg">${icon}</span><span>${label}</span><span class="kh">${keys}</span></div>`;
  const body = `<div class="pal-backdrop rel">
    <span class="anno" style="left:calc(50% + 270px);top:52px">${dot(1)}</span>
    <div class="palette">
      <div class="pinput">${ic.search}<span class="cue">Type a command</span><span class="kbd">⌘K</span></div>
      ${cmd(ic.eye, 'Review this branch', 'R', true)}
      ${cmd(ic.makepr, 'Make PR from worktree', 'P')}
      ${cmd(ic.resteer, 'Re-steer: hand changes back', '⇧R')}
      ${cmd(ic.harness, 'Ask both models', '⇧A')}
      ${cmd(ic.flask, 'View test for this hunk', 'T')}
      ${cmd(ic.editor, 'Open in editor', '⌘E')}
      ${cmd(ic.auto, 'Toggle execution mode', '⌘M')}
    </div>
  </div>`;

  return {
    title: 'Rennet v3.3 · 15 Command palette',
    head: { badge: '15', title: 'Command palette', pill: 'Cross-cutting' },
    ref: 'command-K\nevery action, named and remappable',
    sub: 'Command-K. Every action in Rennet is a named command with a key hint, and every binding is remappable. The keyboard is a first-class surface, not an afterthought.',
    css: css15,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.palette}</span>orbital`, meta: tmeta('⌘K'), body }),
    notes: [
      { h: 'Command-K opens it.', b: 'One overlay, one search field, every action reachable by name. Review, Make PR, Re-steer, Ask both, View test, Toggle mode.' },
      { h: 'Named and remappable.', b: 'Each command carries a default key hint you can rebind. The palette is the discoverable index of the whole keyboard surface.' },
    ],
  };
}

/* ---------- 16 Flow overview ---------- */
export const css16 = `
.flow{ padding:10px 4px; }
.frow{ display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
.fnode{ border:1px solid var(--line2); border-radius:11px; padding:12px 14px; background:#fff; min-width:132px; }
.fnode .fn-h{ font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:8px; }
.fnode .fn-s{ font-family:var(--mono); font-size:11px; color:var(--muted); margin-top:3px; }
.fnode.glass{ background:var(--glass); }
.fnode.blue{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow:inset 3px 0 0 var(--blue); }
.fnode.paper{ background:#fdfdfb; border-color:#e6e2d6; }
.farrow{ color:#aab0b8; flex:none; }
.lenses{ display:flex; gap:8px; border:1px dashed var(--line2); border-radius:11px; padding:11px 12px; }
.lenspill{ font-family:var(--mono); font-size:12px; display:flex; align-items:center; gap:7px; color:var(--muted); border:1px solid var(--line2); border-radius:7px; padding:6px 9px; background:#fff; }
.loopnote{ font-family:var(--mono); font-size:12px; color:var(--blue-ink); display:flex; align-items:center; gap:8px; margin:2px 0 16px 8px; }
.matlegend{ display:flex; gap:18px; border-top:1px solid var(--line); padding-top:16px; margin-top:8px; flex-wrap:wrap; }
.matlegend .m{ display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--muted); }
.matlegend .sw{ width:14px; height:14px; border-radius:4px; border:1px solid var(--line2); }
.sw.ink{ background:var(--ink); } .sw.blue{ background:var(--blue-bg); border-color:var(--blue-line); }
.sw.glass{ background:var(--glass); } .sw.paper{ background:#fdfdfb; border-color:#e6e2d6; }
`;
export function frame16() {
  const A = (glyph, h, s, cls = '') => `<div class="fnode ${cls}"><div class="fn-h">${glyph}${h}</div><div class="fn-s">${s}</div></div>`;
  const arw = `<span class="farrow">${ic.chevronR}</span>`;

  const body = `<div class="flow">
    <div class="frow">
      ${A(ic.repo, 'Projects', 'list', 'glass')}${arw}
      ${A(ic.plus, 'Add project', 'type · path · worktrees')}${arw}
      ${A(ic.sun, 'Processing', 'narrated dump')}${arw}
      ${A(ic.repo, 'Project detail', 'Yours + Team', 'glass')}
    </div>
    <div class="frow rel">
      <span class="anno" style="left:-30px;top:16px">${dot(1)}</span>
      ${A(ic.branch, 'Yours', 'local worktree', 'blue')}${arw}
      ${A(ic.eye, 'Review surfaces', 'the canvases')}${arw}
      <div class="lenses">
        <span class="lenspill">${ic.spec}Spec</span><span class="lenspill">${ic.sequence}Sequence</span><span class="lenspill">${ic.decisions}Decisions</span><span class="lenspill">${ic.flag}Flagged</span>
      </div>
    </div>
    <div class="loopnote rel"><span class="anno" style="left:-30px;top:-2px">${dot(3)}</span>${ic.resteer} re-steer loops a Yours branch back to the harness before it becomes a PR</div>
    <div class="frow">
      ${A(ic.decisions, 'Collation draft', 'editable · yours', 'glass')}${arw}
      ${A(ic.paper, 'Paper', 'sign · derived verdict', 'paper')}${arw}
      ${A(ic.pr, 'Posts to the PR', 'exactly what you signed')}
    </div>
    <div class="frow rel">
      <span class="anno" style="left:-30px;top:16px">${dot(2)}</span>
      ${A(ic.pr, 'Team PR', 'incl. your own')}${arw}${A(ic.eye, 'Teammate review', 'same canvases')}
      <span class="farrow" style="margin:0 4px">→</span><span class="mono" style="font-size:12px;color:var(--muted)">the other entry point</span>
    </div>
    <div class="matlegend">
      <div class="m"><span class="sw ink"></span>ink · publishes, travels to the PR</div>
      <div class="m"><span class="sw blue"></span>blue · stays local to this machine</div>
      <div class="m"><span class="sw glass"></span>glass · chrome</div>
      <div class="m"><span class="sw paper"></span>paper · the one thing you sign</div>
    </div>
  </div>`;

  return {
    title: 'Rennet v3.3 · 16 Flow overview',
    head: { badge: '16', title: 'Flow overview: the whole app, one map', pill: 'The map' },
    ref: 'the v3 journey\ntwo entry points, one draft, one sign',
    sub: 'The v3 flow as one map. Point at code, watch it process, land on the two-zone project detail, and review through the canvases into a single editable draft and one signed paper. Your local work flows toward Make PR; a teammate’s PR is the other entry point, into the same canvases.',
    css: css16,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>Rennet · flow`, meta: tmeta('v3'), body }),
    notes: [
      { h: 'One map of the flow.', b: 'Projects list to add-project to the narrated processing, then the two-zone project detail, the review canvases, one draft, one signed paper.' },
      { h: 'Two entry points.', b: 'Your own local work (backlight, heading toward Make PR) and a teammate’s PR (ink, into teammate review). Both land in the same canvases.' },
      { h: 'The re-steer loop.', b: 'A Yours branch can loop back to the coding harness with your requested changes before it ever becomes a PR.' },
      { h: 'The material legend.', b: 'Ink publishes, blue stays local, glass is chrome, paper is the one thing you sign. The whole app reads by material.' },
    ],
  };
}
