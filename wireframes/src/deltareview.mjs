// Rennet v4.0 — the delta re-review account with the LLM digest on top.
// Journey stage 7: the agent handed back a new patchset; before you re-read a line,
// the account states what moved. The DETERMINISTIC facts (addressed / untouched /
// beyond-asks) are the ground truth; a light-tier LLM digest sits ON TOP as the
// fast-read. Facts render instantly; the digest auto-generates and streams in a beat
// later; if the model is absent/over-budget the digest line is gone and the facts are
// unchanged. It gates nothing.
import { ic, dot, win, modePill, crumb, navRail, navCtx, patchsetChip } from './kit.mjs';
import { reviewCss } from './review.mjs';

const tmeta = (extra) => `${modePill}${extra ? `<span>${extra}</span>` : ''}`;
const reviewCtx = navCtx([
  { icon: ic.repo, title: 'orbital' },
  { icon: ic.branch, on: true, title: 'feat/rate-limiting' },
]);

// a plain diff line (local copy — review.mjs keeps its own private)
const dl = (n, sign, code) =>
  `<div class="dl ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}"><span class="ln">${n}</span><span class="pm">${sign}</span><span class="code">${code}</span></div>`;

export const deltaCss = `
/* the delta account panel — sits at the very top of the successor review */
.delta{ border:1px solid var(--line2); border-radius:13px; overflow:hidden; margin-bottom:16px; }
.delta-h{ display:flex; align-items:center; gap:10px; padding:11px 16px; background:var(--glass); border-bottom:1px solid var(--line); }
.delta-h .ey{ font-family:var(--mono); font-size:11px; letter-spacing:.11em; text-transform:uppercase; color:var(--faint); }
.delta-h .ctx{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--muted); display:flex; align-items:center; gap:7px; }

/* the LLM digest — the TL;DR fast-read, on top */
.digest{ padding:15px 17px 14px; display:flex; gap:12px; align-items:flex-start; }
.digest .spark{ flex:none; width:24px; height:24px; border-radius:7px; background:var(--blue-bg); border:1px solid var(--blue-line); color:var(--blue-ink); display:flex; align-items:center; justify-content:center; }
.digest .spark svg{ width:14px; height:14px; }
.digest .body{ min-width:0; }
.digest .lead{ font-size:15.5px; line-height:1.55; color:var(--text); }
.digest .lead b{ font-weight:650; }
.digest .lead .warn{ color:var(--amber); font-weight:600; }
.digest .tag{ margin-top:7px; font-family:var(--mono); font-size:11px; color:var(--faint); display:inline-flex; align-items:center; gap:6px; }
.digest .tag .caret{ width:5px; height:12px; background:var(--blue); border-radius:1px; display:inline-block; opacity:.75; margin-left:2px; }

/* the deterministic facts, below a hairline */
.facts{ border-top:1px solid var(--line); }
.facts-h{ font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); padding:11px 17px 3px; }
.fact{ display:flex; align-items:center; gap:13px; padding:9px 17px; border-top:1px solid var(--line); }
.fact:first-of-type{ border-top:none; }
.fact .st{ flex:none; width:150px; display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; }
.fact .st svg{ width:15px; height:15px; }
.fact.addressed .st{ color:var(--green); }
.fact.untouched .st{ color:var(--muted); }
.fact.partial .st{ color:var(--amber); }
.fact .hollow{ width:14px; height:14px; border-radius:50%; border:1.6px solid var(--muted); flex:none; }
.fact .p{ font-family:var(--code); font-size:13px; color:var(--text); flex:none; }
.fact .say{ font-size:13.5px; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fact .jump{ margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--blue-ink); display:inline-flex; align-items:center; gap:5px; flex:none; }
.fact .jump svg{ width:13px; height:13px; }

/* beyond-asks — the scope-creep, surfaced loud */
.beyond{ background:var(--amber-bg); border-top:1px solid var(--amber-line); padding:12px 17px 13px; }
.beyond-h{ font-family:var(--sans); font-size:13px; font-weight:650; color:var(--amber); display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.beyond-h svg{ width:15px; height:15px; }
.beyond .fact{ border-top:none; padding:5px 0; }
.beyond .fact .p{ color:var(--amber); }
.beyond .fact .say{ color:#6f5410; }

.delta-foot{ font-family:var(--mono); font-size:11.5px; color:var(--faint); padding:10px 17px; border-top:1px solid var(--line); background:#fbfbfc; }

/* the patchset trail — a dropdown off the title-bar patchset chip (§4.5) */
.trail{ position:relative; width:280px; margin:0 0 16px auto; border:1px solid var(--line2); border-radius:11px;
  background:#fff; box-shadow:0 20px 44px -26px rgba(20,26,33,.4); overflow:hidden; }
.trail::before{ content:""; position:absolute; right:26px; top:-6px; width:11px; height:11px; background:#fff;
  border-left:1px solid var(--line2); border-top:1px solid var(--line2); transform:rotate(45deg); }
.trail .th{ font-family:var(--mono); font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint);
  padding:9px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.trail .trow{ display:flex; align-items:center; gap:10px; padding:9px 13px; border-bottom:1px solid var(--line); font-size:12.5px; }
.trail .trow:last-child{ border:none; }
.trail .trow.cur{ background:var(--blue-bg); font-weight:600; }
.trail .trow .pn{ font-family:var(--mono); font-weight:600; color:var(--text); }
.trail .trow .pd{ color:var(--muted); font-family:var(--mono); font-size:11.5px; }
.trail .trow .ro{ margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--faint); display:inline-flex; align-items:center; gap:4px; }
.trail .trow .ro svg{ width:11px; height:11px; }
.trail .trow .pin{ margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--blue-ink); }

/* the two OTHER digest states, shown as small stacked variants on the right */
.states{ margin-top:2px; }
.state-card{ border:1px solid var(--line2); border-radius:11px; overflow:hidden; margin-bottom:12px; }
.state-card .sh{ font-family:var(--mono); font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); padding:8px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.state-card .sb{ padding:12px 13px; display:flex; gap:10px; align-items:flex-start; }
.state-card .spark{ flex:none; width:22px; height:22px; border-radius:6px; background:var(--blue-bg); border:1px solid var(--blue-line); color:var(--blue-ink); display:flex; align-items:center; justify-content:center; }
.state-card .spark svg{ width:13px; height:13px; }
.shimmer{ height:11px; border-radius:5px; background:linear-gradient(90deg,var(--line) 25%,var(--glass) 50%,var(--line) 75%); }
.state-card .txt{ font-size:13px; color:var(--muted); line-height:1.5; }
.state-card.muted .spark{ background:#f0f1f3; border-color:var(--line2); color:var(--faint); }
`;

export function frameDeltaReview() {
  // ── the delta account, in its PRESENT state (the digest has streamed in) ──
  const digest = `<div class="digest rel">
    <span class="anno" style="left:-30px;top:8px">${dot(1)}</span>
    <span class="spark">${ic.auto}</span>
    <div class="body">
      <p class="lead">Claude made your <b>org-key rename</b> and added the <b>fail-open bound</b> you asked for, but left the <b>dead-branch cleanup untouched</b>. <span class="warn">It also swapped <code style="font-family:var(--code)">console</code> for a logger dependency in <code style="font-family:var(--code)">metrics.ts</code></span> — a change you never asked for.</p>
      <span class="tag">${ic.auto} written from the facts below · light model<span class="caret"></span></span>
    </div>
  </div>`;

  const facts = `<div class="facts">
    <div class="facts-h">The facts · what moved, per ask</div>
    <div class="fact addressed"><span class="st">${ic.check} Addressed</span><span class="p">src/rate/keys.ts</span><span class="say">rename the key to org:id</span><span class="jump">${ic.chevronR} jump to diff</span></div>
    <div class="fact addressed"><span class="st">${ic.check} Addressed</span><span class="p">src/rate/bucket.ts</span><span class="say">bound the fail-open path at 5× the org limit</span><span class="jump">${ic.chevronR} jump to diff</span></div>
    <div class="fact untouched"><span class="st"><span class="hollow"></span> Untouched</span><span class="p">src/rate/middleware.ts</span><span class="say">drop the dead retry branch — still there</span><span class="jump">${ic.chevronR} jump to diff</span></div>
    <div class="beyond rel">
      <span class="anno" style="left:-30px;top:12px">${dot(4)}</span>
      <div class="beyond-h">${ic.flag} 1 change beyond your asks</div>
      <div class="fact"><span class="st" style="width:150px;color:var(--amber)">${ic.reqchange} Unrequested</span><span class="p">src/metrics/emit.ts</span><span class="say">console.* swapped for a pino logger dep — unrelated to the review</span><span class="jump">${ic.chevronR} jump to diff</span></div>
    </div>
  </div>`;

  const deltaPanel = `<div class="delta rel">
    <span class="anno" style="left:6px;top:-2px">${dot(3)}</span>
    <div class="delta-h"><span class="ey">Since you last reviewed</span><span class="ctx">${ic.resteer} re-review · patchset 9 ⟵ 8 · agent turn</span></div>
    ${digest}
    ${facts}
    <div class="delta-foot rel"><span class="anno" style="right:6px;top:-2px">${dot(5)}</span>Informational — re-review and post proceed without dismissing it. Tap any row to open its diff.</div>
  </div>`;

  // ── a slim slice of the successor review heart, below the account ──
  const heartSlice = `<div class="lensbar"><span class="lens"><span style="color:#5a6069">${'<>'}</span>9</span><span class="lens on">${ic.sequence}Sequence</span><span class="lens">${ic.decisions}3</span><span class="lens">${ic.flag}1</span><span class="lens">${ic.noise}Noise</span><div class="right"><span class="chip green">2 addressed</span><span class="chip amber">1 beyond</span></div></div>
  <div class="file">
    <div class="file-h amber"><span class="p"><span style="color:#5a6069">${'<>'}</span> src/metrics/emit.ts</span><span class="d">+18 −6</span><span class="chip amber">${ic.flag}beyond your asks</span><span class="fa"><button class="btn sm">${ic.flask}view test</button><button class="btn sm">${ic.editor}</button></span></div>
    ${dl('4', '-', 'console.info(`rl.emit ${name}`, fields)')}
    ${dl('4', '+', "import { logger } from '../log/pino'")}
    ${dl('9', '+', 'logger.info({ name, ...fields }, &#39;rl.emit&#39;)')}
    <div class="chunkact"><button class="btn ink sm">${ic.check}Approve chunk</button><button class="btn sm">${ic.reqchange}Change</button><button class="btn sm">${ic.comment}Comment</button></div>
  </div>
  <div class="fold">the rest of the successor changeset scrolls below · the account stays pinned to the top</div>`;

  // ── the two other digest states, as small stacked cards on the right rail ──
  const states = `<div class="states rel">
    <span class="anno" style="left:-30px;top:20px">${dot(2)}</span>
    <div class="sec-label" style="margin-bottom:10px">The digest's other two states</div>
    <div class="state-card">
      <div class="sh">Streaming · the facts are already up</div>
      <div class="sb"><span class="spark">${ic.auto}</span><div style="flex:1;display:flex;flex-direction:column;gap:6px;padding-top:2px"><div class="shimmer" style="width:100%"></div><div class="shimmer" style="width:82%"></div><div class="shimmer" style="width:46%"></div></div></div>
    </div>
    <div class="state-card muted">
      <div class="sh">Model off / over budget</div>
      <div class="sb"><span class="spark">${ic.dotpause}</span><p class="txt">No summary this time — the facts below are complete on their own. Never a blank or a guess.</p></div>
    </div>
    <div class="sec-label" style="margin:16px 0 8px">Why this shape</div>
    <p class="muted" style="font-size:13px;line-height:1.55;margin:0">The digest is a rephrasing of the deterministic account — it can add no fact the facts don't already carry. Remove it and the account is unchanged. So the model can be fast and loose; the truth is underneath.</p>
  </div>`;

  // the patchset trail dropped off the title-bar chip: current pinned, predecessors read-only
  const trail = `<div class="trail rel">
    <span class="anno" style="left:-30px;top:14px">${dot(6)}</span>
    <div class="th">Patchset trail · off the title-bar chip</div>
    <div class="trow cur"><span class="pn">patchset 9</span><span class="pd">re-review · now</span><span class="pin">● current</span></div>
    <div class="trow"><span class="pn">patchset 8</span><span class="pd">your last read</span><span class="ro">${ic.lock}read-only</span></div>
    <div class="trow"><span class="pn">patchset 7</span><span class="pd">first snapshot</span><span class="ro">${ic.lock}read-only</span></div>
  </div>`;

  const body = `<div class="drgrid">${trail}${deltaPanel}${heartSlice}<div class="drside">${states}</div></div>`;

  return {
    title: 'Rennet v4.0 · 06a Delta re-review',
    head: { badge: '06a', title: 'Delta re-review: what the agent did, digested', pill: 'Review' },
    ref: 'stage 7 · after the handoff turn\ndigest on top, facts below',
    sub: 'The agent handed back a new patchset. Before you re-read a line, the <b>delta account</b> states what moved: each staged ask <b>addressed / partially / untouched</b>, and every path it changed <b>beyond your asks</b>, surfaced loud. The facts are deterministic — no model. A light-tier <b>LLM digest</b> sits on top as the one-glance read. The title bar now carries a <b>patchset chip</b>; its <b>trail</b> lists the lineage (9 ‹ 8 ‹ 7), current pinned, predecessors read-only. It gates nothing.',
    css: reviewCss + deltaCss + `
      .drgrid{ display:grid; grid-template-columns:1fr 320px; gap:0 26px; }
      .drgrid > .delta, .drgrid > .lensbar, .drgrid > .file, .drgrid > .fold, .drgrid > .trail{ grid-column:1; }
      .drside{ grid-column:2; grid-row:1 / 999; border-left:1px solid var(--line); padding-left:22px; }
    `,
    win: win({
      name: crumb([
        { label: 'Projects', icon: ic.home, root: true },
        { label: 'orbital', icon: ic.repo },
        { label: 'feat/rate-limiting', icon: ic.branch, cur: true },
      ]),
      meta: `${modePill}${patchsetChip('patchset 9 · re-review', { trail: true })}`,
      body,
      nav: navRail({ back: true, ctx: reviewCtx }),
    }),
    notes: [
      { h: 'Digest on top, facts below.', b: 'The LLM rephrases the deterministic account into one plain-English read. The addressed / untouched / beyond-asks facts stay visible right under it as the authoritative ground truth — the prose can never claim a fact the facts don’t carry.' },
      { h: 'Auto, and never blocking.', b: 'The facts render the instant the re-review opens; the digest generates in the background and streams in a beat later. One light-model call per re-review — a deliberate, infrequent act.' },
      { h: 'Model-free floor.', b: 'If the light seat is down or over budget, the digest line is simply absent and the facts are unchanged — an honest “no summary this time,” never a blank card and never a guess.' },
      { h: 'Beyond-asks stays loud.', b: 'The scope-creep the reviewer must see gets its own amber block; every row jumps to its diff. The account is informational — re-review and post proceed without dismissing it (Rule Zero: no gate).' },
      { h: 'The patchset trail.', b: 'The title-bar patchset chip drops a trail (9 ‹ 8 ‹ 7): the current patchset is pinned, predecessors are read-only look-backs. Regenerate remains the only way a new patchset appears; the trail is how you look back — no browsing of predecessors in v4.0.' },
    ],
  };
}
