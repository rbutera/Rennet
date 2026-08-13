import { ic, dot, win, modePill } from './kit.mjs';

// pre-project frames (01-03) carry NO execution-mode glyph, just the palette hint
const paletteMeta = `<span style="color:#aab0b8">${ic.palette}</span>`;

/* ---------- 01 First run ---------- */
export const css01 = `
.firstrun{ padding:26px 10px 40px; }
.fr-label{ font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin-bottom:20px; }
.addbig{ max-width:560px; margin:34px auto 0; border:1.5px dashed var(--line2); border-radius:16px;
  padding:44px 30px; text-align:center; background:#fbfcfd; }
.addbig .plus{ width:56px; height:56px; border-radius:14px; border:1px solid var(--line2); background:#fff;
  display:flex; align-items:center; justify-content:center; margin:0 auto 16px; color:#4a5059; }
.addbig .plus svg{ width:26px; height:26px; }
.addbig h2{ font-size:19px; margin:0 0 6px; font-weight:650; }
.addbig p{ margin:0; color:var(--muted); font-size:14px; }
.ambient{ max-width:560px; margin:18px auto 0; display:flex; align-items:center; gap:9px;
  background:var(--blue-bg); border:1px solid var(--blue-line); box-shadow:inset 3px 0 0 var(--blue);
  border-radius:9px; padding:10px 13px; }
.ambient .hh{ font-family:var(--mono); font-size:12.5px; color:var(--blue-ink); }
.ambient .hh b{ color:var(--text); font-weight:600; }
.coach{ max-width:560px; margin:14px auto 0; text-align:center; font-size:12.5px; color:var(--faint); }
`;
export function frame01() {
  const body = `<div class="firstrun rel">
    <div class="fr-label">Projects · none yet</div>
    <span class="anno" style="left:6px;top:200px">${dot(1)}</span>
    <div class="addbig">
      <div class="plus">${ic.plus}</div>
      <h2>Add a project</h2>
      <p>Point Rennet at a workspace or a repo.</p>
    </div>
    <div class="ambient rel">
      <span class="anno" style="left:-30px;top:8px">${dot(2)}</span>
      <span style="color:var(--blue)">${ic.harness}</span>
      <span class="hh"><b>Claude · codex · gh</b> detected</span>
    </div>
    <div class="coach rel"><span class="anno" style="left:-30px;top:-2px">${dot(3)}</span>A few one-time coach marks teach the rest, in place.</div>
  </div>`;
  return {
    title: 'Rennet v4.0 · 01 First run',
    head: { badge: '01', title: 'First run: the empty projects list', pill: 'Onboarding' },
    ref: 'no wizard, no ceremony\nadd-a-project IS the onboarding',
    sub: 'First run is a <b>state</b> of the projects list, not a separate flow. It is one large add-a-project affordance and an ambient line saying which harnesses were found. Nothing here is once-only, so nothing can rot in a surface you never revisit.',
    css: css01,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>Rennet`, meta: paletteMeta, body }),
    notes: [
      { h: 'Add-a-project is the onboarding.', b: 'No connect / find-tools / point-at-code wizard. The one persistent action does the whole job, and it exists forever, not once.' },
      { h: 'Detection is ambient.', b: 'Harness discovery is one backlight line, not a screen. Zero-config means it is felt, not ceremonial.' },
      { h: 'First run is a state.', b: 'The empty projects list IS first run. The only explicit teaching is a handful of coach marks that fire at their anchor and dismiss forever.' },
    ],
  };
}

/* ---------- 02 Add a project ---------- */
export const css02 = `
.seg{ display:flex; gap:12px; margin:4px 0 22px; }
.segcard{ flex:1; border:1px solid var(--line2); border-radius:12px; padding:16px; background:#fff; display:flex; gap:12px; align-items:flex-start; }
.segcard.on{ border-color:var(--blue); box-shadow:inset 0 0 0 1px var(--blue), 0 0 0 3px var(--blue-bg); }
.segcard .gly{ margin-top:1px; }
.segcard h3{ font-size:15px; margin:0 0 3px; font-weight:650; }
.segcard p{ margin:0; font-size:13px; color:var(--muted); }
.fld-h{ font-family:var(--mono); font-size:11.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin:0 0 8px; }
.pathrow{ display:flex; gap:10px; margin-bottom:18px; }
.pathfield{ flex:1; display:flex; align-items:center; gap:9px; border:1px solid var(--line2); border-radius:9px; padding:11px 13px; font-family:var(--mono); font-size:13.5px; color:var(--text); background:#fff; }
.recents{ border:1px solid var(--line); border-radius:11px; overflow:hidden; }
.recents .rh{ font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:9px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.recrow{ display:flex; align-items:center; gap:10px; padding:11px 13px; border-bottom:1px solid var(--line); font-family:var(--mono); font-size:13px; }
.recrow:last-child{ border-bottom:none; }
.recrow .det{ margin-left:auto; }
.foot{ display:flex; justify-content:flex-end; margin-top:22px; }
`;
export function frame02() {
  const body = `<div class="rel">
    <div class="fld-h rel"><span class="anno" style="left:-30px;top:-4px">${dot(1)}</span>What are you pointing at</div>
    <div class="seg">
      <div class="segcard on"><span class="gly" style="color:var(--blue)">${ic.repo}</span><div><h3>Workspace</h3><p>a folder holding several repos</p></div></div>
      <div class="segcard"><span class="gly">${ic.branch}</span><div><h3>Project repo</h3><p>one repo</p></div></div>
    </div>
    <div class="fld-h rel"><span class="anno" style="left:-30px;top:-4px">${dot(2)}</span>Path</div>
    <div class="pathrow">
      <div class="pathfield">${ic.repo}<span>~/orbital</span></div>
      <button class="btn">Browse</button>
    </div>
    <div class="recents">
      <div class="rh">Recent · detected nearby</div>
      <div class="recrow">${ic.repo}~/orbital<span class="chip blue det">3 repos</span></div>
      <div class="recrow">${ic.branch}~/code/atlas<span class="chip det">1 repo</span></div>
      <div class="recrow">${ic.repo}~/work/navcore-mono<span class="chip blue det">5 repos</span></div>
    </div>
    <div class="foot"><button class="btn ink">Continue ${ic.chevronR}</button></div>
  </div>`;
  return {
    title: 'Rennet v4.0 · 02 Add a project',
    head: { badge: '02', title: 'Add a project: type and path', pill: 'Onboarding' },
    ref: 'step 1 of 2\ntwo nouns, then a path',
    sub: 'The only vocabulary you meet is <b>workspace</b> (a folder holding several repos) and <b>project repo</b> (one repo), one line of explanation each. Everything else is inference. Pick the type, point at the path, continue.',
    css: css02,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.plus}</span>Add a project`, meta: 'step 1 of 2', body }),
    notes: [
      { h: 'Two nouns, no four-noun model.', b: 'The old component is gone. Workspace or project repo, one line each, and the rest is discovered.' },
      { h: 'Native dialog plus recents.', b: 'Browse opens the OS picker; the list below is dirs Rennet cheaply detected near where you pointed.' },
      { h: 'Terse by construction.', b: 'No questions it can answer itself. If discovery finds nothing odd, the next screen is three rows tall.' },
    ],
  };
}

/* ---------- 03 Worktree config ---------- */
export const css03 = `
.disc-h{ display:flex; align-items:center; gap:9px; font-size:15px; font-weight:600; margin:2px 0 16px; }
.disc-h .k{ font-family:var(--mono); color:var(--muted); font-weight:400; font-size:13.5px; }
.togrow{ display:flex; align-items:center; gap:13px; border:1px solid var(--line2); border-radius:11px; padding:13px 15px; margin-bottom:10px; }
.togrow .nm{ font-family:var(--mono); font-weight:600; font-size:13.5px; }
.togrow .sub{ font-family:var(--mono); font-size:12px; color:var(--muted); }
.togrow .tog{ margin-left:auto; width:40px; height:23px; border-radius:12px; background:var(--blue); position:relative; }
.togrow .tog::after{ content:""; position:absolute; right:3px; top:3px; width:17px; height:17px; border-radius:50%; background:#fff; }
.togrow .tog.off{ background:#cdd3da; } .togrow .tog.off::after{ right:auto; left:3px; }
.primary{ display:flex; align-items:center; gap:13px; border:1px solid var(--line2); border-radius:11px; padding:13px 15px; margin-top:6px; background:var(--glass); }
.primary .lbl{ font-family:var(--mono); font-size:12.5px; color:var(--muted); }
.primary .val{ font-family:var(--mono); font-weight:600; font-size:13.5px; display:flex; align-items:center; gap:7px; }
.foot{ display:flex; justify-content:space-between; align-items:center; margin-top:22px; }
`;
export function frame03() {
  const body = `<div class="rel">
    <div class="disc-h rel"><span class="anno" style="left:-30px;top:0">${dot(1)}</span><span style="color:#4a5059">${ic.repo}</span>Found in <span class="k">~/orbital</span></div>
    <div class="togrow rel"><span class="anno" style="left:-30px;top:14px">${dot(2)}</span><span class="gly sm">${ic.branch}</span><div><div class="nm">atlas</div><div class="sub">3 branches · git.com/orbital/atlas</div></div><span class="tog"></span></div>
    <div class="togrow"><span class="gly sm">${ic.branch}</span><div><div class="nm">navcore</div><div class="sub">2 branches</div></div><span class="tog"></span></div>
    <div class="togrow"><span class="gly sm">${ic.branch}</span><div><div class="nm">atlas-docs</div><div class="sub">2 branches · docs only</div></div><span class="tog off"></span></div>
    <div class="primary"><span class="lbl">Primary branch</span><span class="val">${ic.branch}main</span><span style="margin-left:auto;color:var(--blue-ink);font-family:var(--mono);font-size:12.5px">edit</span></div>
    <div class="foot rel"><span class="anno" style="left:-30px;top:8px">${dot(3)}</span><span class="mono" style="color:var(--faint);font-size:12.5px">2 of 3 included</span><button class="btn ink">${ic.check}Confirm</button></div>
  </div>`;
  return {
    title: 'Rennet v4.0 · 03 Worktree config',
    head: { badge: '03', title: 'Worktree config: editable defaults', pill: 'Onboarding' },
    ref: 'step 2 of 2\ndiscovery, not an interrogation',
    sub: 'Discovery shows what it found as <b>editable defaults</b>, not questions: the repos and worktrees it detected, each with an include toggle (all on), and the primary branch confirmed. One Confirm. If nothing is odd, this screen is three rows tall.',
    css: css03,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.plus}</span>Add a project`, meta: 'step 2 of 2', body }),
    notes: [
      { h: 'Defaults, not questions.', b: 'The old discovery tree is gone. What survives is the list of found worktrees as toggle rows you can adjust.' },
      { h: 'Toggles all on.', b: 'Everything detected is included by default; flip off what you do not want (atlas-docs here). The primary branch is confirmed, editable.' },
      { h: 'One Confirm.', b: 'Then it processes. There is no third step.' },
    ],
  };
}

/* ---------- 04 Processing ---------- */
export const css04 = `
.proc{ padding:16px 10px 8px; text-align:center; }
.prism-wrap{ height:150px; display:flex; align-items:center; justify-content:center; position:relative; }
.spinner{ width:60px; height:60px; border-radius:50%; border:5px solid var(--line); border-top-color:#5a6069; transform:rotate(40deg); }
.prism-cap{ font-size:12px; color:var(--faint); margin-top:2px; }
.feed{ max-width:560px; margin:22px auto 0; text-align:left; }
.ledger{ border:1px solid var(--line); border-radius:11px; overflow:hidden; margin-bottom:10px; }
.ledrow{ display:flex; align-items:center; gap:10px; padding:9px 13px; border-bottom:1px solid var(--line); font-size:13.5px; color:var(--muted); }
.ledrow:last-child{ border-bottom:none; }
.ledrow .ct{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--faint); }
.ledrow .ck{ color:var(--green); }
.active{ display:flex; align-items:center; gap:11px; border:1px solid var(--blue-line); background:var(--blue-bg); border-radius:11px; padding:13px 15px; }
.active .pulse{ width:9px; height:9px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 4px rgba(61,124,171,.18); flex:none; }
.active .txt{ font-size:14px; } .active .txt b{ font-weight:600; }
.active .t{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--muted); }
.morph{ max-width:560px; margin:20px auto 0; border-top:1px dashed var(--line2); padding-top:16px; }
.morph .mh{ font-family:var(--mono); font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin-bottom:9px; text-align:center; }
.ghosthead{ display:flex; align-items:center; gap:10px; opacity:.5; border:1px solid var(--line2); border-radius:11px; padding:12px 15px; }
.ghosthead .nm{ font-weight:650; } .ghosthead .k{ font-family:var(--mono); font-size:12px; color:var(--muted); }
`;
export function frame04() {
  const body = `<div class="proc rel">
    <div class="prism-wrap rel"><span class="anno" style="left:calc(50% + 52px);top:18px">${dot(1)}</span><div class="spinner"></div></div>
    <div class="prism-cap">spinner · MVP placeholder</div>
    <div class="feed">
      <div class="ledger rel"><span class="anno" style="left:-30px;top:14px">${dot(2)}</span>
        <div class="ledrow"><span class="ck">${ic.check}</span>Walked 3 repos<span class="ct">16 worktrees</span></div>
        <div class="ledrow"><span class="ck">${ic.check}</span>Read the commit graph<span class="ct">1,204 commits</span></div>
        <div class="ledrow"><span class="ck">${ic.check}</span>Mapped open PRs<span class="ct">6 · 2 yours</span></div>
      </div>
      <div class="active"><span class="pulse"></span><span class="txt"><b>Building the context index</b> · 214 files, 38 modules</span><span class="t">now</span></div>
    </div>
    <div class="morph rel"><span class="anno" style="left:-30px;top:16px">${dot(3)}</span>
      <div class="mh">then it becomes the project</div>
      <div class="ghosthead"><span style="color:#4a5059">${ic.repo}</span><span class="nm">orbital</span><span class="k">~/orbital · 3 repos · 11 branches</span></div>
    </div>
  </div>`;
  return {
    title: 'Rennet v4.0 · 04 Processing',
    head: { badge: '04', title: 'Processing: the narrated context dump', pill: 'Onboarding' },
    ref: 'the narrated context dump\nhonest spinner for the MVP',
    sub: 'The initial context dump, narrated. A plain spinner (the MVP placeholder) sits over a real feed of pipeline events in plain speech. Completed lines collapse into a done-ledger; the current line is always the bottom line. When it finishes it <b>becomes</b> the project.',
    css: css04,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>orbital`, meta: `${modePill}<span>reading</span>`, body }),
    notes: [
      { h: 'An honest spinner, for now.', b: 'The MVP shows a plain spinner over the real narration feed. The lines are real events in plain speech, and the model’s voice fills them, exempt from the terse rule. No fake delight before the substance is right.' },
      { h: 'Lines collapse as they land.', b: 'Completed work folds into a compact done-ledger (glyph plus count) so a long dump never becomes a wall.' },
      { h: 'It ends by becoming the project.', b: 'The final frame morphs into the project-detail header: continuity of object, not a cut. The dump feels like it produced the project.' },
      { h: 'The delight comes later.', b: 'Post-MVP, the spinner becomes a real animation: little agents going out to fetch each repo’s history and dumping it into context, so the dump you are watching is literally drawn. Promoted once the rest of the app is worked out.' },
      { h: 'One narration organ, reused.', b: 'The same component drives stage-3 refresh and review-capture narration. Interruptible: leave and it continues, with a progress glyph on the project card.' },
    ],
  };
}
