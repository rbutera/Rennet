import { ic, dot } from './kit.mjs';

export const css05 = `
.pd{ display:grid; grid-template-columns:236px 1fr; }
.rail{ background:var(--glass); border-right:1px solid var(--line); margin:-26px 0 -26px -28px; padding:22px 18px; }
.rail .pj{ font-size:16px; font-weight:650; display:flex; align-items:center; gap:8px; }
.rail .pjpath{ font-family:var(--mono); font-size:12px; color:var(--muted); margin:3px 0 2px; }
.rail .pjcount{ font-family:var(--mono); font-size:12px; color:var(--faint); }
.rail-h{ font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint);
  display:flex; align-items:center; justify-content:space-between; margin:22px 0 8px; }
.repo{ margin-bottom:4px; }
.repo-n{ display:flex; align-items:center; gap:7px; font-size:13.5px; font-weight:600; padding:4px 0; }
.repo-n .ct{ margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--faint); font-weight:400; }
.branch{ display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:12.5px; color:var(--muted); padding:3px 0 3px 22px; }
.bdot{ width:8px; height:8px; border-radius:50%; flex:none; }
.harnessbox{ margin-top:22px; background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:9px; padding:11px 12px; }
.harnessbox .hh{ font-size:12px; color:var(--blue-ink); display:flex; align-items:center; gap:7px; font-weight:600; }
.harnessbox .hd{ font-family:var(--mono); font-size:11.5px; color:var(--muted); margin-top:4px; }

.main{ padding-left:30px; position:relative; }
.fbar{ display:flex; align-items:center; gap:9px; margin-bottom:16px; }
.searchbox{ flex:1; display:flex; align-items:center; gap:8px; border:1px solid var(--line2); border-radius:8px;
  padding:8px 11px; color:var(--faint); font-size:13.5px; background:#fff; max-width:300px; }
.searchbox svg{ width:15px; height:15px; }
.zonechips{ margin-left:auto; display:flex; gap:0; border:1px solid var(--line2); border-radius:8px; overflow:hidden; }
.zc{ font-family:var(--mono); font-size:12.5px; padding:8px 13px; display:flex; align-items:center; gap:7px; background:#fff; color:var(--muted); }
.zc.on{ background:var(--ink); color:#fff; }
.zc + .zc{ border-left:1px solid var(--line2); }
.zc .n{ font-weight:600; }

.resume{ display:flex; align-items:center; gap:12px; background:var(--blue-bg); border:1px solid var(--blue-line);
  box-shadow: inset 3px 0 0 var(--blue); border-radius:10px; padding:11px 15px; margin-bottom:20px; }
.resume .rt{ font-size:13.5px; } .resume .rt b{ font-weight:600; }
.resume .rm{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--muted); }

.zone-h{ display:flex; align-items:baseline; gap:11px; margin:0 0 11px; }
.zone-h .zn{ font-size:15px; font-weight:650; }
.zone-h .zs{ font-family:var(--mono); font-size:12px; color:var(--faint); }
.zone-h.two{ margin-top:26px; }

.prow{ display:flex; align-items:center; gap:14px; padding:14px 16px; border:1px solid var(--line2); border-radius:11px; margin-bottom:10px; background:#fff; position:relative; }
.prow.back{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow: inset 3px 0 0 var(--blue); }
.prow .gly{ flex:none; }
.prow .body{ flex:1; min-width:0; }
.prow .t1{ display:flex; align-items:center; gap:9px; font-size:14.5px; }
.prow .t1 .nm{ font-family:var(--mono); font-weight:600; }
.prow .t1 .sub{ font-family:var(--mono); font-size:12.5px; color:var(--muted); font-weight:400; }
.prow .t2{ display:flex; align-items:center; gap:8px; margin-top:7px; }
.prow .act{ flex:none; display:flex; align-items:center; gap:8px; }
.traj{ display:inline-flex; align-items:center; gap:0; }
.traj i{ width:8px; height:8px; border-radius:50%; border:1.5px solid var(--blue); display:block; }
.traj i.done{ background:var(--blue); }
.traj i.half{ background:linear-gradient(90deg,var(--blue) 50%, transparent 50%); }
.traj i.todo{ border-color:#b9c4cd; }
.traj .cx{ width:14px; height:1.5px; background:#c3cfd8; }
.trajlbl{ font-family:var(--mono); font-size:11px; color:var(--muted); margin-left:8px; }
.wtflag{ display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11.5px; color:var(--blue-ink);
  background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:6px; padding:3px 7px; }
.wtflag svg{ width:13px; height:13px; }
.modepill{ display:inline-flex; align-items:center; gap:7px; font-family:var(--mono); font-size:12.5px; color:var(--text);
  border:1px solid var(--line2); border-radius:7px; padding:5px 9px; background:#fff; }
.modepill svg{ width:14px; height:14px; }
.anno.gut{ left:-16px; }
`;

const bdot = (c) => `<span class="bdot" style="background:${c}"></span>`;

const traj = (a, b, c, label) =>
  `<span class="traj"><i class="${a}"></i><span class="cx"></span><i class="${b}"></i><span class="cx"></span><i class="${c}"></i></span><span class="trajlbl">${label}</span>`;

export function frame05() {
  const rail = `<div class="rail">
    <div class="pj"><span style="color:#4a5059">${ic.repo}</span>orbital</div>
    <div class="pjpath">~/orbital</div>
    <div class="pjcount">3 repos · 11 branches</div>

    <div class="rail-h"><span>Repos</span><span style="display:flex;gap:8px;color:#aab0b8">${ic.filter}${ic.plus}</span></div>
    <div class="repo">
      <div class="repo-n"><span style="color:#8a9099">${ic.chevron}</span>atlas <span class="ct">7</span></div>
      <div class="branch">${bdot('#4a8a4a')}main</div>
      <div class="branch">${bdot('#3d7cab')}feat/rate-limiting</div>
      <div class="branch">${bdot('#c99a2a')}fix/session-ttl</div>
    </div>
    <div class="repo"><div class="repo-n"><span style="color:#aab0b8;transform:rotate(-90deg)">${ic.chevron}</span>navcore <span class="ct">2</span></div></div>
    <div class="repo"><div class="repo-n"><span style="color:#aab0b8;transform:rotate(-90deg)">${ic.chevron}</span>atlas-docs <span class="ct">2</span></div></div>

    <div class="harnessbox">
      <div class="hh"><span style="color:var(--blue)">${ic.harness}</span>Harness detected</div>
      <div class="hd">Claude · codex · gh</div>
    </div>
  </div>`;

  const fbar = `<div class="fbar rel">
    <span class="anno" style="left:-16px;top:8px">${dot(5)}</span>
    <div class="searchbox">${ic.search}<span>Filter this project</span></div>
    <span class="chip"><span style="color:#4a5059">${ic.eye}</span>needs you <b style="color:var(--text)">3</b></span>
    <span class="chip amber">${ic.flag}CI 1</span>
    <div class="zonechips"><span class="zc on">Yours <span class="n">3</span></span><span class="zc">Team <span class="n">6</span></span></div>
  </div>`;

  const resume = `<div class="resume">
    <span class="gly sm" style="border-color:var(--blue-line);color:var(--blue)">${ic.play}</span>
    <div class="rt"><b>Resume</b> <span class="mono" style="color:var(--muted)">atlas · feat/rate-limiting · reviewing</span></div>
    <div class="rm">held 47m</div>
  </div>`;

  const yoursHead = `<div class="zone-h rel">
    <span class="anno" style="left:-16px;top:0">${dot(1)}</span>
    <span class="zn">Yours</span><span class="zs">local · never left this machine</span>
  </div>`;

  const row1 = `<div class="prow back rel">
    <span class="anno gut" style="top:16px">${dot(2)}</span>
    <span class="gly" style="color:var(--blue)">${ic.branch}</span>
    <div class="body">
      <div class="t1"><span class="nm">feat/rate-limiting</span><span class="sub">atlas · working tree</span></div>
      <div class="t2"><span class="chip">7 files</span><span class="chip">+412 −88</span>${traj('done', 'half', 'todo', 'reviewing')}</div>
    </div>
    <div class="act"><button class="btn ink">${ic.eye}Review</button></div>
  </div>`;

  const row2 = `<div class="prow back rel">
    <span class="gly" style="color:var(--blue)">${ic.branch}</span>
    <div class="body">
      <div class="t1"><span class="nm">fix/session-ttl</span><span class="sub">atlas · working tree</span></div>
      <div class="t2"><span class="chip">5 files</span><span class="chip">+96 −140</span>${traj('done', 'done', 'todo', 'reviewed')}</div>
    </div>
    <div class="act"><button class="btn ink">${ic.makepr}Make PR</button></div>
  </div>`;

  const row3 = `<div class="prow back rel">
    <span class="anno gut" style="top:16px">${dot(3)}</span>
    <span class="gly" style="color:var(--blue)">${ic.branch}</span>
    <div class="body">
      <div class="t1"><span class="nm">spike/import-map</span><span class="sub">navcore · working tree</span></div>
      <div class="t2"><span class="chip amber">${ic.reqchange}3 changes asked</span>${traj('done', 'done', 'todo', 'change requested')}</div>
    </div>
    <div class="act"><button class="btn ink">${ic.resteer}Re-steer</button></div>
  </div>`;

  const teamHead = `<div class="zone-h two rel">
    <span class="zn">Team</span><span class="zs">every PR · yours included</span>
  </div>`;

  const pr482 = `<div class="prow">
    <span class="gly">${ic.pr}</span>
    <div class="body">
      <div class="t1"><span class="nm">#482</span><span class="sub">per-org rate limiting · Marta</span></div>
      <div class="t2"><span class="chip">23 files</span><span class="chip">+1,412 −435</span><span class="chip green">ready</span><span class="chip blue">2/6 read</span><span class="chip">${ic.discuss}4</span><span class="chip amber">${ic.flag}2 flagged</span></div>
    </div>
    <div class="act"><button class="btn ink">${ic.eye}Review</button></div>
  </div>`;

  const pr477 = `<div class="prow rel">
    <span class="anno gut" style="top:16px">${dot(4)}</span>
    <span class="gly">${ic.pr}</span>
    <div class="body">
      <div class="t1"><span class="nm">#477</span><span class="sub">glass theme module · You</span><span class="wtflag">${ic.branch}checked out locally</span></div>
      <div class="t2"><span class="chip">9 files</span><span class="chip">+330 −22</span><span class="chip green">CI ✓</span><span class="chip blue">draft</span></div>
    </div>
    <div class="act"><button class="btn">${ic.eye}Review</button></div>
  </div>`;

  const pr212 = `<div class="prow">
    <span class="gly">${ic.pr}</span>
    <div class="body">
      <div class="t1"><span class="nm">#212</span><span class="sub">navcore · IPC token handshake · draft</span></div>
      <div class="t2"><span class="chip">6 files</span><span class="chip">+310 −22</span><span class="chip blue">4/4 read</span></div>
    </div>
    <div class="act"><button class="btn">Open</button></div>
  </div>`;

  const main = `<div class="main">${fbar}${resume}${yoursHead}${row1}${row2}${row3}${teamHead}${pr482}${pr477}${pr212}</div>`;

  const winBody = `<div class="pd">${rail}${main}</div>`;

  return {
    title: 'Rennet v3 · 05 Project detail',
    head: { badge: '05', title: 'Project detail: the everyday landing', pill: 'Home' },
    ref: 'the two-zone landing · Yours + Team\none scroll, no tabs · mode glyph in the title bar',
    sub: 'Click a project and land here: one scroll, two zones, no tabs. <b>Yours</b> is local work in backlight, each row a worktree becoming a PR. <b>Team</b> is every PR including your own, in ink. The execution mode lives as one glyph in the title bar, defaulting to auto. No consent banner, no “read-only / nothing touched” chrome.',
    css: css05,
    win: `<div class="win"><div class="tbar"><span class="tls"><span class="tl"></span><span class="tl"></span><span class="tl"></span></span><span class="tname"><span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>orbital</span><span class="tmeta"><span class="modepill">${ic.harness}auto<span style="color:#aab0b8">${ic.chevron}</span></span>synced 14:02<span style="color:#aab0b8">${ic.palette}</span></span></div><div class="content">${winBody}</div></div>`,
    notes: [
      { h: 'Two zones, one scroll.', b: 'No tabs as primary structure. Seeing your in-flight work and the team’s PRs in one glance is the whole point of the screen.' },
      { h: 'Yours is backlight, and it is a pipeline.', b: 'Blue means private to this machine. The trajectory dots read captured › reviewed › PR’d, so a row shows where in the local pipeline it sits.' },
      { h: 'The terminal verbs.', b: 'A Yours row’s action is stage-dependent and ends in Make PR (the paper ceremony) or Re-steer (hand the changes back to the harness).' },
      { h: 'Team is ink; your PRs live here too.', b: 'Once a branch has a PR, the PR row wins and the worktree becomes a glyph on it (see #477). One item, one row, no double-listing.' },
      { h: 'Chips switch; the glyph gates.', b: 'The Yours / Team chips are a soft switcher (click one to collapse the other). The title-bar mode glyph replaces the old consent banner entirely.' },
    ],
  };
}
