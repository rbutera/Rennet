// Rennet mobile wireframes (phase 6 gate deliverable 2, issue #382).
// Six frames, each a row of phone mockups on the shared v4.0 kit. Every phone
// names the protocol commands and event topics it consumes (the gate's rule:
// a screen that cannot name its commands is not designed yet).
import { ic, dot } from './kit.mjs';

// ---- phone chrome ----
export const cssMobile = `
.phones{ display:flex; gap:36px; align-items:flex-start; justify-content:center; padding:6px 0 2px; }
.phcol{ flex:none; width:393px; }
.phone{ width:393px; background:var(--win); border:1.5px solid var(--line2); border-radius:44px;
  overflow:hidden; position:relative;
  box-shadow: 0 1px 0 rgba(255,255,255,.6), 0 24px 50px -34px rgba(20,26,33,.42); }
.ph-status{ display:flex; align-items:center; justify-content:space-between; padding:14px 26px 6px;
  font-family:var(--mono); font-size:13px; font-weight:600; color:var(--text); }
.ph-island{ position:absolute; left:50%; top:11px; transform:translateX(-50%);
  width:108px; height:26px; border-radius:14px; background:var(--ink); }
.ph-body{ padding:10px 16px 18px; min-height:640px; }
.ph-home{ width:120px; height:4.5px; border-radius:3px; background:var(--line2); margin:10px auto 12px; }
.ph-cap{ margin-top:14px; }
.ph-cap .cn{ font-size:14.5px; font-weight:650; display:flex; align-items:center; gap:8px; }
.ph-cap .cs{ font-size:13px; color:var(--muted); line-height:1.5; margin-top:3px; }
.ph-cmds{ margin-top:9px; display:flex; flex-wrap:wrap; gap:5px; }
.cmd{ font-family:var(--code); font-size:10.5px; color:var(--blue-ink); background:var(--blue-bg);
  border:1px solid var(--blue-line); border-radius:5px; padding:3px 6px; white-space:nowrap; }
.cmd.topic{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }

/* phone-scale chrome */
.mhead{ display:flex; align-items:center; gap:9px; padding:8px 4px 12px; }
.mhead .mt{ font-size:19px; font-weight:700; letter-spacing:-.01em; }
.mhead .daemon{ margin-left:auto; }
.daemon{ display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px;
  color:var(--muted); border:1px solid var(--line2); background:#fff; border-radius:999px; padding:4px 9px; }
.daemon .dd{ width:7px; height:7px; border-radius:50%; background:var(--green); flex:none; }
.daemon.off .dd{ background:var(--faint); }
.mback{ display:inline-flex; align-items:center; gap:4px; color:var(--muted); font-size:14px; font-weight:550; }
.mback svg{ width:16px; height:16px; }

.mrow{ display:flex; align-items:center; gap:11px; background:#fff; border:1px solid var(--line2);
  border-radius:12px; padding:12px 12px; margin-bottom:9px; position:relative; }
.mrow.attn{ background:var(--blue-bg); border-color:var(--blue-line); box-shadow: inset 3px 0 0 var(--blue); }
.mrow .gly{ width:32px; height:32px; }
.mrow .gly svg{ width:17px; height:17px; }
.mrow .body{ flex:1; min-width:0; }
.mrow .nm{ font-size:14.5px; font-weight:650; display:flex; align-items:center; gap:7px; }
.mrow .sub{ font-family:var(--mono); font-size:11px; color:var(--muted); margin-top:3px;
  display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.mrow .openchev{ color:#aab0b8; display:flex; } .mrow .openchev svg{ width:16px; height:16px; }
.mrow .chip{ font-size:10.5px; padding:4px 6px; }

.livedot{ width:8px; height:8px; border-radius:50%; background:var(--blue);
  box-shadow:0 0 0 4px rgba(61,124,171,.18); flex:none; display:inline-block; }

.msec{ font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--faint); margin:14px 2px 9px; }

.mbtn{ display:flex; align-items:center; justify-content:center; gap:8px; font-size:15px; font-weight:600;
  border:1px solid var(--line2); background:#fff; border-radius:12px; padding:14px; margin-bottom:10px; }
.mbtn.ink{ background:var(--ink); color:#fff; border-color:var(--ink); }
.mbtn svg{ width:18px; height:18px; }

/* pairing */
.scanbox{ border-radius:16px; background:#22262b; height:300px; position:relative; margin-bottom:12px; }
.scanbox .aim{ position:absolute; inset:52px 72px; border:2.5px dashed rgba(255,255,255,.55); border-radius:14px; }
.scanbox .qr{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:120px; height:120px; background:
  repeating-linear-gradient(0deg,#fff 0 8px,transparent 8px 16px),
  repeating-linear-gradient(90deg,#fff 0 8px,rgba(255,255,255,.25) 8px 16px); border-radius:6px; opacity:.9; }
.scanbox .hint{ position:absolute; left:0; right:0; bottom:14px; text-align:center; color:#c8cdd3;
  font-size:12.5px; }
.codefield{ display:flex; gap:7px; justify-content:center; margin:6px 0 12px; }
.codefield .c{ width:40px; height:48px; border:1.5px solid var(--line2); border-radius:9px; background:#fff;
  font-family:var(--code); font-size:20px; font-weight:650; display:flex; align-items:center; justify-content:center; }

/* stream timeline */
.tl-ev{ display:flex; gap:9px; margin-bottom:9px; }
.tl-ev .tico{ flex:none; width:24px; height:24px; border-radius:7px; border:1px solid var(--line2);
  background:#fff; display:flex; align-items:center; justify-content:center; color:#4a5059; }
.tl-ev .tico svg{ width:13px; height:13px; }
.tl-ev .tb{ flex:1; min-width:0; font-size:13px; line-height:1.45; color:var(--text);
  background:#fff; border:1px solid var(--line2); border-radius:10px; padding:9px 11px; }
.tl-ev .tb .th{ font-family:var(--mono); font-size:10.5px; color:var(--faint); margin-bottom:3px; }
.tl-ev.dim .tb{ color:var(--muted); background:#fbfcfd; }
.streambar{ display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11px;
  color:var(--blue-ink); margin:4px 2px 10px; }
.composer{ display:flex; align-items:center; gap:8px; border:1.5px solid var(--line2); border-radius:14px;
  background:#fff; padding:10px 12px; margin-top:10px; }
.composer .ph{ flex:1; color:var(--faint); font-size:14px; }
.composer .send{ width:32px; height:32px; border-radius:9px; background:var(--ink); color:#fff;
  display:flex; align-items:center; justify-content:center; flex:none; }
.composer .send svg{ width:16px; height:16px; }
.sendmode{ display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:10.5px;
  color:var(--muted); margin:7px 4px 0; }
.stopbtn{ display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; color:#8a3b2e;
  border:1px solid #dcb9ae; background:#f7ece8; border-radius:8px; padding:6px 10px; }
.stopbtn .sq{ width:9px; height:9px; background:#8a3b2e; border-radius:2px; }

/* ask card */
.askcard{ background:var(--amber-bg); border:1px solid var(--amber-line); border-radius:13px; padding:13px 14px;
  margin-bottom:11px; }
.askcard .ah{ display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:10.5px;
  letter-spacing:.09em; text-transform:uppercase; color:var(--amber); margin-bottom:7px; }
.askcard .aq{ font-size:14.5px; font-weight:600; line-height:1.45; }
.answers{ display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
.answers .ans{ font-size:13px; font-weight:600; border:1.5px solid var(--line2); background:#fff;
  border-radius:999px; padding:8px 13px; }
.answers .ans.pick{ border-color:var(--ink); background:var(--ink); color:#fff; }

/* digest / canvas */
.digestrow{ display:flex; gap:8px; margin-bottom:11px; }
.digestrow .dstat{ flex:1; background:#fff; border:1px solid var(--line2); border-radius:11px;
  padding:10px 6px; text-align:center; }
.digestrow .dstat b{ display:block; font-size:19px; }
.digestrow .dstat span{ font-family:var(--mono); font-size:10px; color:var(--muted); }
.hunk{ font-family:var(--code); font-size:11px; line-height:1.55; background:#fbfcfd;
  border:1px solid var(--line2); border-radius:10px; padding:9px 11px; overflow:hidden; margin-top:8px; }
.hunk .add{ color:var(--add); } .hunk .del{ color:#a4442e; } .hunk .ctx{ color:var(--muted); }
.dispo{ display:flex; gap:7px; margin-top:10px; }
.dispo .dbtn{ flex:1; display:flex; align-items:center; justify-content:center; gap:6px; font-size:12.5px;
  font-weight:600; border:1.5px solid var(--line2); background:#fff; border-radius:9px; padding:8px 4px; }
.dispo .dbtn.on{ border-color:var(--green-line); background:var(--green-bg); color:var(--green); }

/* publish */
.paper{ background:#fff; border:1px solid var(--line2); border-radius:13px; padding:15px 15px; }
.paper .pt{ font-size:15.5px; font-weight:700; margin-bottom:7px; }
.paper .pb{ font-size:13px; line-height:1.55; color:var(--text); }
.paper .pb p{ margin:0 0 8px; }
.verdict{ display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px;
  color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); border-radius:6px;
  padding:4px 8px; }
.faceid{ text-align:center; padding:26px 0 8px; }
.faceid .fbox{ width:74px; height:74px; margin:0 auto 12px; border:2.5px solid var(--ink); border-radius:20px;
  display:flex; align-items:center; justify-content:center; }
.faceid .fbox svg{ width:40px; height:40px; }
.honest{ font-size:12px; color:var(--muted); line-height:1.5; border:1.5px dashed var(--line2);
  border-radius:10px; padding:9px 11px; margin-top:12px; }

/* notifications frame */
.lock{ background:linear-gradient(180deg,#2b3038,#171a1f); min-height:640px; border-radius:0; padding:12px 14px; }
.lock .ltime{ text-align:center; color:#fff; font-size:56px; font-weight:250; margin:34px 0 2px; letter-spacing:-.02em; }
.lock .ldate{ text-align:center; color:#c8cdd3; font-size:14px; margin-bottom:26px; }
.notif{ background:rgba(250,251,252,.96); border-radius:16px; padding:11px 13px; margin-bottom:9px; }
.notif .nh{ display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:10px;
  letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
.notif .nh .napp{ width:16px; height:16px; border-radius:4px; background:var(--ink); color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; }
.notif .nh .nago{ margin-left:auto; }
.notif .nt{ font-size:13.5px; font-weight:650; }
.notif .nb{ font-size:12.5px; color:var(--text); line-height:1.45; margin-top:2px; }
.notif .nacts{ display:flex; gap:7px; margin-top:9px; }
.notif .nacts .na{ flex:1; text-align:center; font-size:12px; font-weight:600; border:1px solid var(--line2);
  border-radius:8px; padding:7px 4px; background:#fff; }
.notif .nacts .na.ink{ background:var(--ink); border-color:var(--ink); color:#fff; }
.maproute{ display:flex; align-items:center; gap:9px; background:#fff; border:1px solid var(--line2);
  border-radius:11px; padding:11px 12px; margin-bottom:9px; }
.maproute .me{ flex:1; min-width:0; }
.maproute .me .mt2{ font-size:13px; font-weight:650; }
.maproute .me .ms{ font-family:var(--mono); font-size:10.5px; color:var(--muted); margin-top:2px; }
.maproute .lands{ font-family:var(--mono); font-size:10.5px; color:var(--blue-ink); white-space:nowrap; }
.tgl{ flex:none; width:44px; height:26px; border-radius:999px; background:var(--green); position:relative; }
.tgl::after{ content:""; position:absolute; top:3px; right:3px; width:20px; height:20px; border-radius:50%; background:#fff; }
.tgl.off{ background:var(--line2); } .tgl.off::after{ right:auto; left:3px; }
.prio{ flex:none; width:8px; height:8px; border-radius:50%; }
.prio.hi{ background:var(--amber); } .prio.lo{ background:var(--faint); }
`;

// ---- helpers ----
const status = `<div class="ph-status"><span>9:41</span><span class="ph-island"></span><span>􀙇 􀛨</span></div>`;
const phone = (body, { lock = false } = {}) =>
  `<div class="phone">${lock ? '' : status}<div class="ph-body${lock ? '' : ''}"${lock ? ' style="padding:0"' : ''}>${body}</div><div class="ph-home"></div></div>`;
const cap = (name, sub, cmds = [], topics = []) =>
  `<div class="ph-cap"><div class="cn">${name}</div><div class="cs">${sub}</div>
   <div class="ph-cmds">${cmds.map((c) => `<span class="cmd">${c}</span>`).join('')}${topics.map((t) => `<span class="cmd topic">${t}</span>`).join('')}</div></div>`;
const col = (ph, capHtml) => `<div class="phcol">${ph}${capHtml}</div>`;
const daemon = (name, on = true) =>
  `<span class="daemon${on ? '' : ' off'}"><span class="dd"></span>${name}</span>`;
const mhead = (title, d = daemon('home-mac')) =>
  `<div class="mhead"><span class="mt">${title}</span><span class="daemon-slot" style="margin-left:auto">${d}</span></div>`;
const backhead = (title, d = daemon('home-mac')) =>
  `<div class="mhead"><span class="mback">${ic.chevronL}Back</span><span class="mt" style="font-size:16px">${title}</span><span style="margin-left:auto">${d}</span></div>`;

// ---- frame 19: connections + pairing ----
export function frameM1() {
  const a = phone(`
    ${mhead('Rennet', '')}
    <div style="text-align:center; padding:38px 10px 22px">
      <div class="gly" style="width:58px;height:58px;margin:0 auto 16px;border-radius:15px"><span style="transform:scale(1.7);display:flex">${ic.paper}</span></div>
      <div style="font-size:20px;font-weight:700">Connect to your Rennet</div>
      <div style="font-size:13.5px;color:var(--muted);line-height:1.5;margin:8px 0 26px">Your reviews run on your machine.<br>Pair this phone with its daemon.</div>
    </div>
    <div class="mbtn ink">${ic.peek}Scan pairing QR</div>
    <div class="mbtn">${ic.coverage}Paste pairing link</div>
    <div class="honest">No Rennet backend. The phone talks to your daemon over your tailnet; the only egress is the harness/provider egress your desktop already discloses.</div>`);
  const b = phone(`
    ${backhead('Pair a daemon', '')}
    <div class="scanbox"><span class="aim"></span><span class="qr"></span><span class="hint">Point at the QR on your desktop — Settings → Devices → Pair</span></div>
    <div class="msec">Or enter the one-time code</div>
    <div class="codefield"><span class="c">H</span><span class="c">7</span><span class="c">K</span><span class="c">-</span><span class="c">2</span><span class="c">F</span><span class="c">9</span></div>
    <div class="mbtn ink" style="margin-top:2px">Pair</div>`);
  const c = phone(`
    ${mhead('Connections', '')}
    <div class="mrow attn"><span class="gly" style="color:var(--blue)">${ic.harness}</span>
      <div class="body"><div class="nm">home-mac <span class="chip green">online</span></div>
      <div class="sub">tailnet · 100.84.12.9 · protocol v3</div>
      <div class="sub">${ic.askharness}claude · codex detected</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow"><span class="gly" style="color:#4a5059">${ic.harness}</span>
      <div class="body"><div class="nm">work-mbp <span class="chip">offline</span></div>
      <div class="sub">last seen 2h ago · showing last replica</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="msec">This phone</div>
    <div class="mrow"><span class="gly sm" style="color:#4a5059">${ic.lock}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">Device token · rai-iphone</div>
      <div class="sub">minted 2026-08-18 · revocable from any client</div></div>
      <span class="chip">revoke</span></div>
    <div class="mbtn" style="margin-top:14px">${ic.plus}Pair another daemon</div>`);
  return {
    head: { badge: '19', title: 'Mobile · connect & pair', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\npairing = bootstrap, not a gate',
    sub: `First run to paired. The desk mints the offer (<b>pairing.mint</b> on the desktop shows the QR); the phone scans or types the one-time code, trades it for a device token, and lands on the connections list. Multiple daemons coexist; an unreachable one degrades to its last replica, never a blank.`,
    win: `<div class="phones">
      ${col(a, cap('Welcome', 'Empty state. Two entries: scan or paste. Honest copy, no consent ceremony.', [], []))}
      ${col(b, cap('Scan / code', 'Camera view with a typed fallback for when the camera can’t scan.', ['pairing.exchange'], []))}
      ${col(c, cap('Connections', 'Daemons with reachability, harness disclosure, and this phone’s revocable token.', ['app.bootstrap', 'harness.detect', 'pairing.listDevices', 'pairing.revokeDevice'], []))}
    </div>`,
    notes: [
      { h: 'Tailscale-first.', b: 'The phone joins the user’s tailnet; no relay, no exposed port, no Rennet server in the path.' },
      { h: 'Pairing is bootstrap.', b: 'One scan, then the phone just works (Rule Zero: connection bootstrap, not a consent gate).' },
      { h: 'Offline shows the replica.', b: 'An unreachable daemon row keeps its reviews readable with a staleness banner.' },
      { h: 'Desk mints, phone consumes.', b: 'pairing.mint is absent-by-locus here — the QR lives on the desktop screen.' },
    ],
    css: cssMobile,
  };
}

// ---- frame 20: review list + kickoff ----
export function frameM2() {
  const a = phone(`
    ${mhead('Reviews')}
    <div class="mrow attn"><span class="livedot"></span>
      <div class="body"><div class="nm">orbital/atlas <span class="chip blue">running</span></div>
      <div class="sub">${ic.pr}PR #214 · lens 3/5 · started 11m ago</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow attn"><span class="gly sm" style="color:var(--amber)">${ic.question}</span>
      <div class="body"><div class="nm">rennet/rennet <span class="chip amber">needs you</span></div>
      <div class="sub">${ic.branch}own branch · ask pending 4m</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="msec">Today</div>
    <div class="mrow"><span class="gly sm" style="color:var(--green)">${ic.check}</span>
      <div class="body"><div class="nm">orbital/navcore</div>
      <div class="sub">${ic.pr}PR #209 · 12 findings · 9 judged · fresh</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow"><span class="gly sm" style="color:var(--amber)">${ic.refresh}</span>
      <div class="body"><div class="nm">atlas-mobile</div>
      <div class="sub">${ic.branch}feat/push · <span class="stale" style="font-size:11px">head moved · stale</span></div></div>
      <span class="chip">re-review</span></div>
    <div class="msec">This week</div>
    <div class="mrow"><span class="gly sm" style="color:#4a5059">${ic.paper}</span>
      <div class="body"><div class="nm">rennet/rennet</div>
      <div class="sub">${ic.pr}PR #392 · posted ✓ · Mon</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mbtn ink" style="margin-top:12px">${ic.plus}New review</div>`);
  const b = phone(`
    ${backhead('New review')}
    <div class="msec">From a pull request</div>
    <div class="composer" style="margin:0 0 8px"><span class="ph">Paste a PR link…</span><span class="send">${ic.makepr}</span></div>
    <div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--muted);margin:0 2px 4px">or share a PR to Rennet from any app (share sheet)</div>
    <div class="msec">Your branches on home-mac</div>
    <div class="mrow"><span class="gly sm" style="color:#4a5059">${ic.branch}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">rennet · feat/mobile-shell</div>
      <div class="sub">14 commits ahead of main · uncommitted: 0</div></div>
      <span class="chip blue">review</span></div>
    <div class="mrow"><span class="gly sm" style="color:#4a5059">${ic.branch}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">atlas · fix/tile-cache</div>
      <div class="sub">3 commits ahead · uncommitted: 2 files</div></div>
      <span class="chip blue">review</span></div>
`);
  return {
    head: { badge: '20', title: 'Mobile · review list & kickoff', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\nrunning + needs-you pinned',
    sub: `Home. Reviews aggregate across projects and daemons; <b>running</b> and <b>needs-you</b> pin to the top, the rest group by recency with disposition and freshness at a glance. Kickoff covers both loops: a pasted or share-sheet PR link, and the own-branch pre-submit review.`,
    win: `<div class="phones">
      ${col(a, cap('Review list', 'Status-first: live turn pinned, ask pending badged amber, stale rows offer re-review.', ['projects.list', 'project.detail', 'review.checkFreshness', 'review.load'], ['attention events']))}
      ${col(b, cap('Kickoff', 'Team-PR entry (paste / share sheet) and own-branch capture, same screen.', ['review.openPr', 'review.capture', 'review.regenerate'], ['onProgress(commandId)']))}
    </div>`,
    notes: [
      { h: 'Pull to refresh, push to know.', b: 'The list is replica-painted instantly and reconciled by cursor; pushes carry state changes when the app is away.' },
      { h: 'Share sheet is the headline entry.', b: 'No surveyed competitor starts work from a shared PR link — Rennet does.' },
      { h: 'Both loops are first-class.', b: 'Team PR review and pre-submit own-branch review ride the same list, same detail, same publish end.' },
      { h: 'Freshness is a row fact.', b: 'review.checkFreshness renders as the stale chip — never a surprise after opening.' },
    ],
    css: cssMobile,
  };
}

// ---- frame 21: review detail / canvas digest ----
export function frameM3() {
  const a = phone(`
    ${backhead('orbital/atlas · PR #214')}
    <div class="digestrow">
      <div class="dstat"><b>17</b><span>findings</span></div>
      <div class="dstat" style="border-color:var(--green-line)"><b style="color:var(--green)">6</b><span>resolved</span></div>
      <div class="dstat" style="border-color:var(--amber-line)"><b style="color:var(--amber)">3</b><span>new</span></div>
      <div class="dstat"><b>8</b><span>carried</span></div>
    </div>
    <div class="msec">Delta digest · patchset 4 → 5</div>
    <div class="mrow attn"><span class="gly sm" style="color:var(--amber)">${ic.flag}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">Race in tile eviction</div>
      <div class="sub">src/cache/evict.ts · new in ps5</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow"><span class="gly sm" style="color:var(--green)">${ic.check}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">N+1 in manifest fetch</div>
      <div class="sub">resolved by ps5 · evidence carried</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow"><span class="gly sm" style="color:#4a5059">${ic.sequence}</span>
      <div class="body"><div class="nm" style="font-size:13.5px">Ordering: migrate before flag flip</div>
      <div class="sub">carried · judged agree</div></div>
      <span class="openchev">${ic.chevronR}</span></div>
    <div class="msec">Canvases</div>
    <div class="mrow"><span class="gly sm">${ic.decisions}</span><div class="body"><div class="nm" style="font-size:13.5px">Decisions</div><div class="sub">5 recorded</div></div><span class="openchev">${ic.chevronR}</span></div>
    <div class="mrow"><span class="gly sm">${ic.flag}</span><div class="body"><div class="nm" style="font-size:13.5px">Flagged</div><div class="sub">2 awaiting adjudication</div></div><span class="openchev">${ic.chevronR}</span></div>`);
  const b = phone(`
    ${backhead('Race in tile eviction')}
    <div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--muted);margin:0 2px 8px">src/cache/evict.ts · hunk 2 of 3 · finding F-214-09</div>
    <div style="font-size:13.5px;line-height:1.5">Eviction reads <span class="k" style="font-family:var(--code)">entries.size</span> outside the lock, then deletes inside it — a concurrent insert between the two can evict a fresh tile.</div>
    <div class="hunk"><span class="ctx">@@ src/cache/evict.ts:41 @@</span><br>
<span class="del">-  if (entries.size > limit) {</span><br>
<span class="del">-    lock.run(() => evictOldest());</span><br>
<span class="add">+  lock.run(() => {</span><br>
<span class="add">+    if (entries.size > limit) evictOldest();</span><br>
<span class="add">+  });</span><br>
<span class="ctx">   metrics.count(entries.size);</span></div>
    <div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--blue-ink);margin:8px 2px 0">open full canvas ↗</div>
    <div class="dispo">
      <span class="dbtn on">${ic.check}Agree</span>
      <span class="dbtn">${ic.reqchange}Disagree</span>
      <span class="dbtn">${ic.discuss}Discuss</span>
    </div>
    <div class="askcard" style="margin-top:12px">
      <div class="ah">${ic.askharness}Proposal</div>
      <div class="aq" style="font-size:13.5px">Merge with F-214-04 (same lock scope)?</div>
      <div class="answers"><span class="ans pick">Accept</span><span class="ans">Keep separate</span></div>
    </div>`);
  return {
    head: { badge: '21', title: 'Mobile · review detail & digest', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\ndigest first, hunks on demand',
    sub: `The canvas digest read path at phone width. Delta digest leads — what is new, resolved, carried since the last patchset — then findings open one at a time: claim, the load-bearing hunk (size-ceilinged), and one-tap judgement. The full canvas stays a tap away; a 40-file raw diff never renders here.`,
    win: `<div class="phones">
      ${col(a, cap('Delta digest', 'Triage a finished review: counts, then the delta rows, then canvas entries.', ['review.load', 'review.deltaDigest', 'review.canvases', 'flagged.review'], []))}
      ${col(b, cap('Finding detail', 'One finding: claim, hunk, disposition, and an adjudication proposal inline.', ['canvas.select', 'canvas.disposition', 'canvas.adjudicateProposal', 'flagged.adjudication'], []))}
    </div>`,
    notes: [
      { h: 'Digest is the read path.', b: 'The phone leads with the delta digest — the desk’s tall canvas becomes counts + rows + one finding at a time.' },
      { h: 'Size ceiling by design.', b: 'Hunks render to a ceiling with “open full canvas”; the survey’s RN perf tail says never stream a big diff into a list.' },
      { h: 'Judgement is one tap.', b: 'Agree / disagree / discuss and proposal adjudication are thumb-sized — the unit acts of triage.' },
      { h: 'Flagged folds in.', b: 'The flagged queue is the same finding surface with its adjudication ask inline.' },
    ],
    css: cssMobile,
  };
}

// ---- frame 22: ask / turn interaction ----
export function frameM4() {
  const a = phone(`
    ${backhead('rennet/rennet · own branch')}
    <div class="streambar"><span class="livedot"></span>refine turn running · lens 3/5 · <span style="color:var(--muted)">reattached ✓</span><span style="margin-left:auto"><span class="stopbtn"><span class="sq"></span>Stop</span></span></div>
    <div class="tl-ev dim"><span class="tico">${ic.spec}</span><div class="tb"><div class="th">decomposition</div>Skeleton settled: 4 requirement groups, 11 findings carried forward.</div></div>
    <div class="tl-ev dim"><span class="tico">${ic.flask}</span><div class="tb"><div class="th">tool · tests</div>pnpm test cache/evict — 2 passed, 1 failed (evict.race.spec)</div></div>
    <div class="tl-ev"><span class="tico">${ic.askharness}</span><div class="tb"><div class="th">assistant · streaming</div>The failing spec reproduces the eviction race. Proposing the lock-scope fix as the primary finding; downgrading the metrics drift to a note…</div></div>
    <div class="sub" style="font-family:var(--mono);font-size:10.5px;color:var(--blue-ink);text-align:center;margin:6px 0">↓ return to tail</div>
    <div class="composer"><span class="ph">Steer the turn…</span><span class="send">${ic.chevronR}</span></div>
    <div class="sendmode">${ic.resteer}send interrupts · hold to queue</div>`);
  const b = phone(`
    ${backhead('rennet/rennet · own branch')}
    <div class="askcard">
      <div class="ah">${ic.question}Turn needs you · 4m</div>
      <div class="aq">Two viable framings for the eviction fix: narrow the lock to the size check, or make eviction fully async with a queue. Which should the review recommend?</div>
      <div class="answers"><span class="ans pick">Narrow the lock</span><span class="ans">Async queue</span><span class="ans">Show trade-offs</span></div>
    </div>
    <div class="tl-ev dim"><span class="tico">${ic.editor}</span><div class="tb"><div class="th">context</div>evict.ts:41 and the failing spec are attached to the ask.</div></div>
    <div class="composer"><span class="ph">Answer with direction… (optional)</span><span class="send">${ic.chevronR}</span></div>
    <div class="sendmode">${ic.check}tap an answer, or add direction first</div>`);
  return {
    head: { badge: '22', title: 'Mobile · live turn & ask', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\nreplies steer, not just approve',
    sub: `The live turn and the ask. The stream is a typed timeline with a return-to-tail anchor and a visible <b>Stop</b>; the composer’s send semantics are explicit (interrupt vs queue). An ask renders as chips plus free text — one reply carries the decision <b>and</b> the redirection. Reattach after backgrounding is the normal case, not recovery.`,
    win: `<div class="phones">
      ${col(a, cap('Live turn', 'Typed stream, reattached after a network change; stop is one visible tap.', ['review.reattach', 'review.refine'], ['onAskStream(reviewId)', 'turn interrupted']))}
      ${col(b, cap('Ask pending', 'Answer chips + optional free-text steering in a single reply.', ['review.ask'], ['onAskStream(reviewId)', 'attention: ask pending']))}
    </div>`,
    notes: [
      { h: 'Reattach is the normal case.', b: 'Wi-Fi→cellular mid-turn: replica paints, cursor reconciles, the ask-stream rebinds (#389), the turn never looks hung.' },
      { h: 'Explicit send semantics.', b: 'Interrupt vs queue is a visible mode, and Stop exists — the survey’s two composer gaps, closed.' },
      { h: 'Asks are never binary.', b: 'Chips answer fast; the text field redirects; both travel as one review.ask reply.' },
      { h: 'Unfocused = filtered.', b: 'High-frequency stream events drop for backgrounded clients; attention-class events always get through.' },
    ],
    css: cssMobile,
  };
}

// ---- frame 23: publish flow ----
export function frameM5() {
  const a = phone(`
    ${backhead('Publish · orbital/atlas #214')}
    <div class="paper">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="verdict">${ic.reqchange}request changes</span><span class="chip">${ic.pr}github.com · PR #214</span></div>
      <div class="pt">Review: eviction race + 2 blocking findings</div>
      <div class="pb"><p>The eviction path reads size outside the lock (evict.ts:41); the failing spec reproduces it. Recommending the narrow-lock fix…</p>
      <p style="color:var(--muted)">…9 judged findings collated · your dispositions · your voice.</p></div>
    </div>
    <div class="mbtn ink" style="margin-top:14px">${ic.sign}Sign &amp; post</div>
    <div class="mbtn">${ic.resteer}Ask for changes</div>`);
  const b = phone(`
    ${backhead('Sign')}
    <div class="faceid">
      <div class="fbox">${ic.eye}</div>
      <div style="font-size:16px;font-weight:650">Confirm it’s you</div>
      <div style="font-size:13px;color:var(--muted);margin-top:5px">Face ID confirms the signature</div>
    </div>
    <div class="paper" style="margin-top:16px">
      <div class="pb">Posts as <b>Rai Butera</b> · request changes on <span class="k" style="font-family:var(--code)">orbital/atlas#214</span></div>
    </div>
`);
  const c = phone(`
    ${backhead('Posted')}
    <div style="text-align:center;padding:30px 0 14px">
      <div class="gly" style="width:54px;height:54px;margin:0 auto 12px;border-radius:14px;color:var(--green)"><span style="transform:scale(1.6);display:flex">${ic.check}</span></div>
      <div style="font-size:18px;font-weight:700">Review posted</div>
      <div class="sub" style="font-family:var(--mono);font-size:12px;color:var(--blue-ink);margin-top:6px">github.com/orbital/atlas/pull/214#review</div>
    </div>
    <div class="mbtn" style="margin-top:18px">Done</div>`);
  return {
    head: { badge: '23', title: 'Mobile · sign & post', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\nthe human act, sofa-sized',
    sub: `The headline: preview → sign → post from anywhere. The paper shows exactly what will appear under Rai’s name; Face ID confirms the signature; the posted screen states the real URL. The own-branch loop ends here too — drafted body, signed, PR created idempotently.`,
    win: `<div class="phones">
      ${col(a, cap('Preview', 'The collated paper before anything moves; not right → ask for changes (a refine turn), never phone-editing.', ['publish.requestConsent', 'review.draftPrBody'], []))}
      ${col(b, cap('Sign', 'Biometric-confirmed signature — the GitHub Mobile approve pattern, made ours.', ['publish.review'], []))}
      ${col(c, cap('Posted', 'Truthful outcome with the real URL. The own-branch loop ends on this same screen: drafted body → sign → exactly one PR.', ['publish.submitPr'], ['attention: publish-ready']))}
    </div>`,
    notes: [
      { h: 'This is the product’s click.', b: 'Publishing stays Rai’s act, in his voice — the phone makes it available from anywhere, it never automates it away.' },
      { h: 'Biometric, not bureaucratic.', b: 'Face ID is the signature confirmation, one gesture — not an approval ceremony.' },
      { h: 'Idempotent by construction.', b: 'Double-tap, retry, flaky network: exactly one review / one PR, and the URL comes back.' },
      { h: 'Publish-ready pushes.', b: 'When a draft is composed and waiting, the phone knows — tap lands on this preview.' },
    ],
    css: cssMobile,
  };
}

// ---- frame 24: notification → deep-link landings ----
export function frameM6() {
  const a = `<div class="phone"><div class="ph-body lock">
    <div class="ltime">21:47</div><div class="ldate">Tuesday 18 August</div>
    <div class="notif">
      <div class="nh"><span class="napp">R</span>Rennet · home-mac<span class="nago">now</span></div>
      <div class="nt">Turn needs you · rennet/rennet</div>
      <div class="nb">Two framings for the eviction fix — narrow the lock, or async queue?</div>
      <div class="nacts"><span class="na ink">Narrow the lock</span><span class="na">Async queue</span><span class="na">Open</span></div>
    </div>
    <div class="notif">
      <div class="nh"><span class="napp">R</span>Rennet · home-mac<span class="nago">12m</span></div>
      <div class="nt">Review finished · orbital/atlas #214</div>
      <div class="nb">17 findings · 3 new since patchset 4 · 1 flagged</div>
    </div>
    <div class="notif">
      <div class="nh"><span class="napp">R</span>Rennet · home-mac<span class="nago">1h</span></div>
      <div class="nt">Ready to sign · orbital/atlas #214</div>
      <div class="nb">Request-changes review drafted — preview and post when you are.</div>
    </div>
  </div><div class="ph-home"></div></div>`;
  const route = (title, sub, on = true) =>
    `<div class="maproute"><div class="me"><div class="mt2">${title}</div><div class="ms">${sub}</div></div><span class="tgl${on ? '' : ' off'}"></span></div>`;
  const b = phone(`
    ${backhead('Notifications', '')}
    <div class="msec">Needs you</div>
    ${route('A turn needs you', 'the question, answerable right here')}
    ${route('Review finished', 'what was found, at a glance')}
    ${route('Something went wrong', 'a turn failed or was interrupted')}
    <div class="msec">Progress</div>
    ${route('Agent finished your asks', 'the follow-up work is ready to re-read')}
    ${route('Ready to sign', 'a drafted review is waiting for you')}
    ${route('Project processed', 'quiet — shows in the app only', false)}
    <div class="honest">You only hear about a review you aren’t already looking at.</div>`);
  return {
    head: { badge: '24', title: 'Mobile · pushes & deep links', pill: 'mobile · phase 6' },
    ref: 'issue #382 · deliverable 2\nblocking events push, day one',
    sub: `The notification taxonomy made visible. Every push carries its substance and lands on the decision surface — the ask push is answerable from the shade (the survey’s clearest lesson: approval requests are user-blocking events, and deferring push was Codex’s biggest miss).`,
    win: `<div class="phones" style="align-items:center">
      ${col(a, cap('Lock screen', 'Ask push with answer actions; finished and publish-ready pushes with real counts.', [], ['attention: ask pending', 'attention: review finished', 'attention: publish-ready']))}
      ${col(b, cap('Notification settings', 'The closed taxonomy as user-facing switches; deep-link targets per event live in the ideation doc’s table.', ['review.ask', 'review.handoff.run', 'project.process'], ['onAskStream(reviewId)', 'onProgress(commandId)']))}
    </div>`,
    notes: [
      { h: 'Answer from the shade.', b: 'The ask push carries the question and its chips — the paseo#306 lesson: opening the app must be optional.' },
      { h: 'Deep links are exact.', b: 'Every push lands on the decision surface, never the home screen.' },
      { h: 'Daemon decides delivery.', b: 'Presence (focus, visibility, device) picks in-app event vs push per client, server-side.' },
      { h: 'The taxonomy is closed.', b: 'Six events push. Everything else stays in-app — notification restraint is a feature.' },
    ],
    css: cssMobile,
  };
}
