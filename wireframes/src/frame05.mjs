import { ic, dot } from './kit.mjs';

// 05 Project detail — the UNIFIED smart list (issue #37 / #216), the design Rai
// ratified: ONE scroll, no hard Yours/Team zones. Rows read distinctly by STATE
// (local backlight · my PR accent stripe · teammate PR neutral · needs-you amber ·
// merged read-only + dimmed). Filter bar All/Needs-you/Mine/Local/PRs + sort
// Hot/Recent/Author/Status. Mirrors the shipped project-detail.tsx + smart-list.ts.

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

/* filter + sort bar (the zone chips are gone) */
.fbar{ display:flex; align-items:center; gap:12px; margin-bottom:18px; }
.filters{ display:flex; gap:0; border:1px solid var(--line2); border-radius:9px; overflow:hidden; }
.fchip{ font-family:var(--sans); font-size:12.5px; padding:8px 13px; display:flex; align-items:center; gap:7px;
  background:#fff; color:var(--muted); }
.fchip + .fchip{ border-left:1px solid var(--line2); }
.fchip.on{ background:var(--ink); color:#fff; }
.fchip .fc{ font-family:var(--mono); font-size:11px; color:var(--faint); }
.fchip.on .fc{ color:#c9ced6; }
.sortpill{ margin-left:auto; display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line2);
  border-radius:9px; padding:8px 12px; background:#fff; font-size:12.5px; color:var(--text); }
.sortpill .sl{ color:var(--faint); }
.sortpill .sv{ font-weight:600; }
.sortpill svg{ width:14px; height:14px; color:#aab0b8; }

.resume{ display:flex; align-items:center; gap:12px; background:var(--blue-bg); border:1px solid var(--blue-line);
  box-shadow: inset 3px 0 0 var(--blue); border-radius:10px; padding:11px 15px; margin-bottom:18px; }
.resume .rt{ font-size:13.5px; } .resume .rt b{ font-weight:600; }
.resume .rm{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--muted); }

/* one unified row; state drives appearance */
.srow{ display:flex; align-items:center; gap:8px; border:1px solid var(--line2); border-radius:11px;
  padding:13px 15px; margin-bottom:10px; background:#fff; position:relative; }
.srow.local{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow: inset 3px 0 0 var(--blue); }   /* private glow */
.srow.mine{ box-shadow: inset 3px 0 0 var(--blue-line); }                                                        /* my PR accent stripe */
.srow.needs{ background:var(--amber-bg); border-color:var(--amber-line); box-shadow: inset 3px 0 0 var(--amber); }/* attention */
.srow.merged{ border-color:var(--green-line); box-shadow: inset 3px 0 0 var(--green-line); opacity:.82; }        /* read-only + dimmed */
.srow .lead{ flex:none; min-width:44px; display:flex; align-items:center; justify-content:center; color:var(--muted); }
.srow .lead .num{ font-family:var(--mono); font-weight:700; font-size:13px; color:var(--blue-ink); }
.srow.local .lead{ color:var(--blue); }
.srow .body{ flex:1; min-width:0; }
.srow .t1{ font-size:14px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.srow .t2{ display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:6px; font-size:12px; color:var(--faint); }
.srow .br{ display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); color:var(--muted); }
.srow .br svg{ width:12px; height:12px; }
.srow .au{ color:var(--faint); }
.srow .diff{ font-family:var(--mono); color:var(--muted); }
.srow .state{ flex:none; display:flex; align-items:center; gap:8px; }
.srow .lbl{ font-family:var(--mono); font-size:11.5px; color:var(--muted); }
.srow .act{ flex:none; display:flex; align-items:center; gap:8px; }

.ci{ font-family:var(--mono); font-size:11.5px; border-radius:6px; padding:3px 7px; border:1px solid; }
.ci.ok{ color:var(--green); background:var(--green-bg); border-color:var(--green-line); }
.ci.bad{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }
.ci.pend{ color:var(--muted); background:#fff; border-color:var(--line2); }
.sbadge{ display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11.5px; border-radius:6px; padding:3px 7px; border:1px solid; }
.sbadge.needs{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }
.sbadge.ro{ color:var(--green); background:var(--green-bg); border-color:var(--green-line); }
.sbadge svg{ width:12px; height:12px; }
.checkout{ display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11.5px; color:var(--blue-ink);
  background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:6px; padding:3px 7px; }
.checkout svg{ width:12px; height:12px; }
.cleanup{ font-family:var(--sans); font-size:12.5px; color:var(--muted); background:transparent; border:1px solid var(--line2);
  border-radius:8px; padding:6px 10px; display:inline-flex; align-items:center; gap:6px; }

.traj{ display:inline-flex; align-items:center; gap:0; }
.traj i{ width:8px; height:8px; border-radius:50%; border:1.5px solid var(--blue); display:block; }
.traj i.done{ background:var(--blue); }
.traj i.todo{ border-color:#b9c4cd; }
.traj .cx{ width:14px; height:1.5px; background:#c3cfd8; }
.trajlbl{ font-family:var(--mono); font-size:11px; color:var(--muted); margin-left:8px; }
.dirty{ font-family:var(--mono); font-size:11px; color:var(--amber); }
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
      <div class="branch">${bdot('#c99a2a')}glass-theme</div>
    </div>
    <div class="repo"><div class="repo-n"><span style="color:#aab0b8;transform:rotate(-90deg)">${ic.chevron}</span>navcore <span class="ct">2</span></div></div>
    <div class="repo"><div class="repo-n"><span style="color:#aab0b8;transform:rotate(-90deg)">${ic.chevron}</span>atlas-docs <span class="ct">2</span></div></div>

    <div class="harnessbox">
      <div class="hh"><span style="color:var(--blue)">${ic.harness}</span>Harness detected</div>
      <div class="hd">Claude · codex · gh</div>
    </div>
  </div>`;

  const fchip = (label, count, on) =>
    `<span class="fchip${on ? ' on' : ''}">${label} <span class="fc">${count}</span></span>`;

  const fbar = `<div class="fbar rel">
    <span class="anno" style="left:-16px;top:9px">${dot(1)}</span>
    <div class="filters">
      ${fchip('All', 6, true)}${fchip('Needs you', 1)}${fchip('Mine', 4)}${fchip('Local', 1)}${fchip('PRs', 5)}
    </div>
    <span class="sortpill rel"><span class="anno" style="left:-16px;top:8px">${dot(2)}</span><span class="sl">Sort</span><span class="sv">Hot</span>${ic.chevron}</span>
  </div>`;

  const resume = `<div class="resume">
    <span class="gly sm" style="border-color:var(--blue-line);color:var(--blue)">${ic.play}</span>
    <div class="rt"><b>Resume</b> <span class="mono" style="color:var(--muted)">atlas · feat/rate-limiting · reviewing</span></div>
    <div class="rm">held 47m</div>
  </div>`;

  // Row 1 — teammate PR that needs you (review requested). HOT floats it to the top. Amber.
  const r1 = `<div class="srow needs rel">
    <span class="anno gut" style="top:16px">${dot(3)}</span>
    <span class="lead"><span class="num">#482</span></span>
    <div class="body">
      <div class="t1">Per-org rate limiting</div>
      <div class="t2"><span class="br">${ic.branch}fix/rate-limits</span><span class="au">atlas · emma</span><span class="diff">+1,412 −435 · 23f</span></div>
    </div>
    <div class="state"><span class="ci ok">CI ✓</span><span class="sbadge needs">needs you</span><span class="lbl">review</span></div>
    <div class="act"><button class="btn ink">${ic.eye}Review</button></div>
  </div>`;

  // Row 2 — teammate PR, red CI, NOT needs-you (no review request). Neutral card.
  const r2 = `<div class="srow rel">
    <span class="lead"><span class="num">#491</span></span>
    <div class="body">
      <div class="t1">Lossy-patch carry fail-closed</div>
      <div class="t2"><span class="br">${ic.branch}fix/lossy-carry</span><span class="au">navcore · florence</span><span class="diff">+96 −12 · 4f</span></div>
    </div>
    <div class="state"><span class="ci bad">CI ✕</span><span class="lbl">review</span></div>
    <div class="act"><button class="btn">${ic.eye}Review</button></div>
  </div>`;

  // Row 3 — local work, mine, dirty, reviewed. Private backlight. Ends in Make PR.
  const r3 = `<div class="srow local rel">
    <span class="lead" style="color:var(--blue)">${ic.branch}</span>
    <div class="body">
      <div class="t1">feat/rate-limiting</div>
      <div class="t2"><span class="br">${ic.branch}atlas · working tree</span><span class="au">you</span>${traj('done', 'done', 'todo', 'reviewed')}<span class="dirty">dirty</span></div>
    </div>
    <div class="state"><span class="lbl">local</span></div>
    <div class="act"><button class="btn ink">${ic.makepr}Make PR</button></div>
  </div>`;

  // Row 4 — my PR, checked out locally (the dedupe annotation). Accent stripe.
  const r4 = `<div class="srow mine rel">
    <span class="anno gut" style="top:16px">${dot(4)}</span>
    <span class="lead"><span class="num">#477</span></span>
    <div class="body">
      <div class="t1">Glass theme module</div>
      <div class="t2"><span class="br">${ic.branch}glass-theme</span><span class="au">atlas · you</span><span class="diff">+330 −22 · 9f</span><span class="checkout">${ic.branch}checked out locally</span></div>
    </div>
    <div class="state"><span class="ci ok">CI ✓</span><span class="lbl">your PR</span></div>
    <div class="act"><button class="btn">${ic.eye}Open</button></div>
  </div>`;

  // Row 5 — merged, read-only + dimmed, with a worktree still on disk to sweep. Green.
  const r5 = `<div class="srow merged rel">
    <span class="anno gut" style="top:16px">${dot(5)}</span>
    <span class="lead"><span class="num">#468</span></span>
    <div class="body">
      <div class="t1">Publish egress — the first real GitHub post</div>
      <div class="t2"><span class="br">${ic.branch}feat/publish-egress</span><span class="au">atlas · you</span><span class="diff">+680 −74 · 18f</span><span class="checkout">${ic.branch}checked out locally</span></div>
    </div>
    <div class="state"><span class="ci ok">CI ✓</span><span class="sbadge ro">${ic.lock}read-only</span><span class="lbl">merged</span></div>
    <div class="act"><button class="cleanup">${ic.refresh}Clean up</button><button class="btn">${ic.eye}View</button></div>
  </div>`;

  // Row 6 — my PR, CI still pending. Accent stripe.
  const r6 = `<div class="srow mine rel">
    <span class="lead"><span class="num">#212</span></span>
    <div class="body">
      <div class="t1">IPC token handshake</div>
      <div class="t2"><span class="br">${ic.branch}fix/ipc-token</span><span class="au">navcore · you</span><span class="diff">+310 −22 · 6f</span></div>
    </div>
    <div class="state"><span class="ci pend">CI …</span><span class="lbl">your PR</span></div>
    <div class="act"><button class="btn">${ic.eye}Open</button></div>
  </div>`;

  const main = `<div class="main">${fbar}${resume}${r1}${r2}${r3}${r4}${r5}${r6}</div>`;
  const winBody = `<div class="pd">${rail}${main}</div>`;

  return {
    title: 'Rennet v3 · 05 Project detail',
    head: { badge: '05', title: 'Project detail: the everyday landing', pill: 'Home' },
    ref: 'the everyday landing · ONE smart list\nno zones · filter + sort · mode glyph in the title bar',
    sub: 'Click a project and land here: <b>one list, no hard zones</b>. Every branch, worktree and PR reads distinctly by state — your local work in private backlight, your PRs accent-striped, a teammate’s PR neutral, a row that needs you in amber, a merged PR dimmed and read-only. Sort defaults to <b>Hot</b> (what needs you floats up); the filter bar narrows to Needs-you / Mine / Local / PRs. The execution mode is one glyph in the title bar, no consent banner.',
    css: css05,
    win: `<div class="win"><div class="tbar"><span class="tls"><span class="tl"></span><span class="tl"></span><span class="tl"></span></span><span class="tname"><span class="gly sm plain" style="width:20px;height:20px;color:#4a5059">${ic.repo}</span>orbital</span><span class="tmeta"><span class="modepill">${ic.harness}auto<span style="color:#aab0b8">${ic.chevron}</span></span>synced 14:02<span style="color:#aab0b8">${ic.palette}</span></span></div><div class="content">${winBody}</div></div>`,
    notes: [
      { h: 'One list, no zones.', b: 'The old Yours / Team split is gone (it contradicted the ratified design). It is a single scroll; a row’s STATE — not a zone — gives it its look: local backlight, my-PR accent stripe, teammate PR neutral, needs-you amber, merged green + dimmed.' },
      { h: 'Hot sort, with a needs-you boost.', b: 'Default order is recency of engagement, and anything that needs you (review requested, your own PR’s CI red) floats to the top. Also sort by Recent / Author / Status.' },
      { h: 'Ownership is appearance + filter, not a wall.', b: 'You edit what you own and review what you did not author; the row shows which via stripe + the Mine filter, but nothing is walled off. Filters: All / Needs-you / Mine / Local / PRs, each with a count.' },
      { h: 'One item, one row (dedupe).', b: 'Once a local branch has a PR, the PR row wins and the worktree becomes a “checked out locally” annotation on it (#477) — never a duplicate second row.' },
      { h: 'Merged → read-only + clean up.', b: 'A merged PR (#468) dims to read-only; if a worktree is still on disk, a Clean up action sweeps it away. The terminal verb on local work is Make PR (reviewed) or Review.' },
    ],
  };
}
