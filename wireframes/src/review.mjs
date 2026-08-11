import { ic, dot, win, modePill } from './kit.mjs';

/* shared review-surface CSS (06/07/08/09/10) */
export const reviewCss = `
.lensbar{ display:flex; align-items:center; gap:8px; margin-bottom:16px; }
.lens{ display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:12.5px; color:var(--muted);
  border:1px solid var(--line2); border-radius:8px; padding:7px 11px; background:#fff; }
.lens.on{ background:var(--ink); color:#fff; border-color:var(--ink); }
.lens .n{ font-weight:600; }
.lensbar .right{ margin-left:auto; display:flex; align-items:center; gap:8px; }
.grid3{ display:grid; grid-template-columns:186px 1fr 320px; gap:0; }
.orderrail{ border-right:1px solid var(--line); padding-right:18px; margin:-4px 0; }
.orderrail .oh{ font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.orow{ display:flex; align-items:center; gap:9px; padding:7px 0; font-size:13.5px; color:var(--muted); }
.orow.on{ color:var(--text); font-weight:600; }
.orow .cnt{ margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--faint); }
.orow .rd{ width:8px; height:8px; border-radius:50%; border:1.5px solid var(--muted); }
.orow.on .rd{ background:var(--muted); }
.orow .half{ background:linear-gradient(90deg,var(--muted) 50%,transparent 50%); }
.orail-t{ margin-top:16px; font-family:var(--mono); font-size:11.5px; color:var(--faint); }
.center{ padding:0 20px; min-width:0; }
.margin{ border-left:1px solid var(--line); padding-left:18px; margin:-4px 0; }
.margin-h{ font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; margin-bottom:12px; }

.chunk-h{ display:flex; align-items:center; gap:10px; margin:0 0 8px; }
.chunk-h .nm{ font-size:16px; font-weight:650; }
.chunk-desc{ font-size:14px; color:var(--muted); line-height:1.5; margin:0 0 14px; }
.chunk-desc .more{ font-family:var(--mono); color:var(--blue-ink); font-size:12.5px; }

.file{ border:1px solid var(--line2); border-radius:11px; overflow:hidden; margin-bottom:14px; }
.file-h{ display:flex; align-items:center; gap:10px; padding:11px 14px; background:var(--glass); border-bottom:1px solid var(--line); position:sticky; top:0; }
.file-h .p{ font-family:var(--mono); font-weight:600; font-size:13.5px; display:flex; align-items:center; gap:8px; }
.file-h .d{ font-family:var(--mono); font-size:12.5px; color:var(--muted); }
.file-h .fa{ margin-left:auto; display:flex; gap:8px; }
.file-h.amber{ background:var(--amber-bg); border-color:var(--amber-line); }
.dl{ display:flex; align-items:center; gap:12px; padding:2px 14px; font-family:var(--code); font-size:13px; line-height:1.9; }
.dl .ln{ width:26px; text-align:right; color:var(--faint); flex:none; }
.dl .pm{ width:10px; flex:none; }
.dl .code{ white-space:pre; flex:1; min-width:0; }
.dl.add{ background:#eef6ef; } .dl.add .pm{ color:var(--green); }
.dl.del{ background:#fbeef0; } .dl.del .pm{ color:#a8434f; }
.dl.on{ box-shadow:inset 2px 0 0 var(--orange); }
.cluster{ display:inline-flex; gap:4px; margin-left:6px; }
.cluster i{ width:20px; height:20px; border:1px solid var(--line2); border-radius:5px; display:flex; align-items:center; justify-content:center; color:#7c828a; background:#fff; }
.cluster i svg{ width:12px; height:12px; }
.cluster i.hot{ border-color:var(--orange); color:var(--orange); }
.threadtag{ font-family:var(--mono); font-size:12px; color:var(--muted); display:inline-flex; align-items:center; gap:6px; margin-left:6px; }
.reach{ border:1px dashed var(--blue-line); background:#f4f9fc; border-radius:9px; margin:8px 14px; padding:8px 12px; }
.reach .rh{ font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--blue-ink); display:flex; align-items:center; gap:7px; margin-bottom:4px; }
.reach .rl{ font-family:var(--code); font-size:12.5px; color:var(--muted); }
.chunkact{ display:flex; gap:9px; margin:12px 14px 4px; }
.fold{ text-align:center; font-family:var(--mono); font-size:12px; color:var(--faint); margin:16px 0; }

.tcard{ border:1px solid var(--line2); border-radius:11px; padding:12px 13px; margin-bottom:11px; background:#fff; }
.tcard.blue{ box-shadow:inset 3px 0 0 var(--blue); }
.tcard .who{ font-size:12.5px; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:6px; }
.tcard .who .k{ font-family:var(--mono); font-weight:400; color:var(--muted); font-size:11.5px; margin-left:auto; }
.tcard .msg{ font-size:13px; color:var(--text); line-height:1.5; }
.tcard.amber{ background:var(--amber-bg); border-color:var(--amber-line); }
.tcard .fragrow{ display:flex; gap:6px; margin-top:9px; flex-wrap:wrap; }
.fragbtn{ font-family:var(--mono); font-size:11px; color:var(--muted); border:1px solid var(--line2); border-radius:6px; padding:4px 7px; display:inline-flex; align-items:center; gap:5px; background:#fff; }
.composer{ display:flex; align-items:center; gap:9px; border:1px solid var(--line2); border-radius:9px; padding:9px 11px; margin-top:4px; }
.composer .ph{ color:var(--faint); font-size:13px; flex:1; }
`;

const cl = (hot) => `<span class="cluster"><i${hot === 'c' ? ' class="hot"' : ''}>${ic.comment}</i><i${hot === 'r' ? ' class="hot"' : ''}>${ic.reqchange}</i><i${hot === 'q' ? ' class="hot"' : ''}>${ic.question}</i><i${hot === 'd' ? ' class="hot"' : ''}>${ic.discuss}</i></span>`;
const dl = (n, sign, code, extra = '') =>
  `<div class="dl ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}${extra.includes('on') ? ' on' : ''}"><span class="ln">${n}</span><span class="pm">${sign}</span><span class="code">${code}</span>${extra.replace('on', '')}</div>`;

// title-bar meta = the mode glyph (auto) then whatever else the frame states
const tmeta = (extra) => `${modePill}${extra ? `<span>${extra}</span>` : ''}`;
// the standard 5 lens tabs, one active: Spec · Sequence · Decisions · Flagged · Noise
const lensTab = (icon, label, active, count) => `<span class="lens${active ? ' on' : ''}">${icon}${label}${count ? ` <span class="n">${count}</span>` : ''}</span>`;
const lensTabs = (active) => `${lensTab(ic.spec, 'Spec', active === 'spec')}${lensTab(ic.sequence, 'Sequence', active === 'sequence')}${lensTab(ic.decisions, 'Decisions', active === 'decisions')}${lensTab(ic.flag, 'Flagged', active === 'flagged')}${lensTab(ic.noise, 'Noise', active === 'noise')}`;

/* ---------- 06 The review heart ---------- */
export function frame06() {
  const rail = `<div class="orderrail">
    <div class="oh"><span>Order</span><span style="display:flex;gap:6px;color:#aab0b8">spine${ic.chevron}</span></div>
    <div class="orow"><span class="rd"></span>Limit schema<span class="cnt">96</span></div>
    <div class="orow on"><span class="rd"></span>Token bucket<span class="cnt">121</span></div>
    <div class="orow"><span class="rd"></span>Middleware<span class="cnt">214</span></div>
    <div class="orow"><span class="rd"></span>Call sites<span class="cnt">187</span></div>
    <div class="orow"><span class="rd"></span>Tests<span class="cnt">640</span></div>
    <div class="orow"><span class="rd half"></span>Noise<span class="cnt">592</span></div>
    <div class="orail-t">held 47m · your place</div>
  </div>`;

  const center = `<div class="center rel">
    <span class="anno" style="left:6px;top:-2px">${dot(1)}</span>
    <div class="chunk-h"><span class="nm">Token bucket</span><span class="chip">opaque</span></div>
    <p class="chunk-desc">One refill-on-read bucket per org, stored behind RateStore. No timers, so state advances only when a request arrives. <span class="more">full reasoning ▾</span></p>

    <div class="file">
      <div class="file-h"><span class="p"><span style="color:#5a6069">${'<>'}</span> src/rate/bucket.ts</span><span class="d">+74 −0</span>
        <span class="fa rel"><span class="anno" style="right:112px;top:-30px">${dot(2)}</span><button class="btn sm">${ic.flask}view test</button><button class="btn sm">${ic.editor}</button></span>
      </div>
      ${dl('14', '+', 'async take(key: string, cost = 1): Promise&lt;TakeResult&gt; {', 'on' + cl('c'))}
      ${dl('15', '+', '  const now = Date.now()')}
      ${dl('16', '+', '  const prior = (await this.store.get(key)) ?? this.full(now)', cl())}
      ${dl('17', '+', '  const tokens = Math.min(this.capacity, prior.tokens + elapsed * this.refillPerSec)')}
      ${dl('20', '+', '    return { allowed: false, retryAfterMs: ((cost - tokens) / this.refillPerSec) * 1000 }')}
      <div class="reach rel"><span class="anno" style="left:-30px;top:6px">${dot(3)}</span><div class="rh">${ic.coverage}reach · unchanged · referenced · src/rate/store.ts</div><div class="rl">get(key): Promise&lt;BucketState | null&gt;   ·   set(key, state): Promise&lt;void&gt;</div></div>
      ${dl('23', '+', '  return { allowed: true, remaining: Math.floor(tokens - cost) }')}
      <div class="chunkact"><button class="btn ink sm">${ic.check}Approve chunk</button><button class="btn sm">${ic.reqchange}Change</button><button class="btn sm">${ic.comment}Comment</button><button class="btn sm">${ic.question}Question</button></div>
    </div>

    <div class="file">
      <div class="file-h amber"><span class="p"><span style="color:#5a6069">${'<>'}</span> src/rate/keys.ts</span><span class="d">+31 −13</span><span class="chip amber">${ic.flag}public contract</span><span class="fa"><button class="btn sm">${ic.flask}view test</button><button class="btn sm">${ic.editor}</button></span></div>
      ${dl('17', ' ', 'export function orgKey(ctx: RequestContext): string {')}
      ${dl('18', '-', '  return `rl:${ctx.apiKey.id}`')}
      ${dl('18', '+', '  return `rl:org:${ctx.org.id}`', `<span class="threadtag">${ic.discuss} thread · 2</span>` + cl('d'))}
      ${dl('19', ' ', '}')}
    </div>
    <div class="fold rel"><span class="anno" style="left:6px;top:-2px">${dot(4)}</span>more files below · call sites, tests, noise · this surface scrolls the whole changeset</div>
  </div>`;

  const margin = `<div class="margin rel">
    <span class="anno" style="left:-2px;top:-2px">${dot(5)}</span>
    <div class="margin-h">${ic.lock}Thread · fail-open path <span style="margin-left:auto" class="chip">L44-47</span></div>
    <div class="tcard"><div class="who"><span style="width:8px;height:8px;border-radius:50%;background:#8a9099;display:inline-block"></span>You</div><div class="msg">Why fail open? If the store is down, doesn’t this switch off limiting exactly when load is weirdest?</div></div>
    <div class="tcard blue"><div class="who"><span style="color:var(--blue)">${ic.harness}</span>Claude Code</div><div class="msg">It follows the plan: “limiter outage must never become API outage.” Failing closed turns every store blip into a 5xx storm for all 4,112 orgs. The window is observable via rate.store_error.</div><div class="fragrow"><span class="fragbtn">${ic.flag}finding</span><span class="fragbtn">${ic.comment}draft comment</span><span class="fragbtn">${ic.discuss}sub-thread</span></div></div>
    <div class="tcard amber"><div class="who">${ic.flag}Harnesses disagree</div><div class="msg">Unbounded fail-open is not defensible: an outage lets any org scrape without limit. A process-local bucket at 5x the org limit caps it.</div><div class="fragrow"><span class="chip">claude 3/3</span><span class="chip">codex 3/3</span><span class="chip amber">substantive</span></div></div>
    <div class="composer">${ic.askharness}<span class="ph">Ask about these lines</span><button class="btn sm ink">${ic.askharness}</button></div>
  </div>`;

  const body = `<div class="lensbar"><span class="lens"><span style="color:#5a6069">${'<>'}</span>12</span><span class="lens on">${ic.sequence}Sequence</span><span class="lens">${ic.decisions}4</span><span class="lens">${ic.flag}2</span><span class="lens">${ic.noise}Noise</span><div class="right"><span class="chip blue">● 4 private</span><button class="btn">${ic.paper}Preview</button></div></div><div class="grid3">${rail}${center}${margin}</div>`;

  return {
    title: 'Rennet v3 · 06 The review heart',
    head: { badge: '06', title: 'The review heart: the sequence canvas', pill: 'Review' },
    ref: 'the tall, scrolling surface\nno viewport-fold element',
    sub: 'The code, in-diff dispositions, and the inline conversation cluster on every line. The surface is genuinely <b>tall</b> and scrolls the whole changeset, with no fold theatre. Threads live in the right margin aligned to their line; the diff column never reflows. The sticky chunk header keeps “view test” and open-in-editor reachable.',
    css: reviewCss,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.branch}</span>atlas · feat/rate-limiting`, meta: tmeta('patchset 8 · snapshot'), body }),
    notes: [
      { h: 'Tall and real, no fold.', b: 'The viewport-fold element is gone (Rai’s note). The surface scrolls the whole changeset; the order rail holds your place.' },
      { h: 'View test, context-labeled.', b: 'One button reads “view test” on an implementation hunk and “view implementation” on a test; disabled “no tests” when none reference it.' },
      { h: 'The cluster is verbs times anchors.', b: 'Comment / request-change / question / discuss, on a line, a dragged range, a chunk header, or a fragment. Ink publishes; blue stays local.' },
      { h: 'Threads in the margin.', b: 'Conversation aligns to its line in the right margin and the composer opens there, so the diff column is a fixed point that never moves.' },
    ],
  };
}

/* ---------- 07 Spec view ---------- */
export const css07 = `
.specband{ border:1px solid var(--line2); border-radius:12px; padding:16px 18px; margin-bottom:16px; background:var(--glass); }
.specband .name{ font-family:var(--mono); font-size:16px; font-weight:650; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.specband .counts{ font-family:var(--mono); font-size:12.5px; color:var(--muted); }
.specband .why{ font-size:14.5px; color:var(--text); line-height:1.55; margin:10px 0 0; }
.specband .why b{ font-weight:600; }
.spine{ display:grid; grid-template-columns:1.4fr 1fr; gap:20px; margin-bottom:18px; }
.spine h4{ font-family:var(--mono); font-size:11.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin:0 0 8px; }
.spine p{ font-size:14px; color:var(--muted); line-height:1.55; margin:0 0 10px; }
.wc{ list-style:none; padding:0; margin:0; }
.wc li{ font-size:13.5px; color:var(--text); padding:6px 0; border-bottom:1px solid var(--line); display:flex; gap:9px; align-items:flex-start; }
.wc li:last-child{ border:none; }
.wc .capchip{ font-family:var(--mono); font-size:11px; color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:5px; padding:2px 6px; flex:none; margin-top:1px; }
.impact{ border:1px solid var(--line); border-radius:10px; padding:12px 13px; font-size:13px; color:var(--muted); }
.impact b{ color:var(--text); }
.grid-h{ font-family:var(--mono); font-size:11.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin:6px 0 10px; }
.capgrid{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; }
.capcard{ border:1px solid var(--line2); border-radius:10px; padding:12px 13px; }
.capcard.new{ box-shadow:inset 3px 0 0 var(--add); }
.capcard.open{ grid-column:1 / -1; }
.capcard .cn{ font-family:var(--mono); font-weight:650; font-size:13.5px; display:flex; align-items:center; gap:8px; }
.capcard .cn .tg{ font-family:var(--mono); font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); border-radius:4px; padding:1px 5px; }
.capcard .cm{ font-family:var(--mono); font-size:12px; color:var(--muted); margin-top:4px; }
.req{ border-top:1px solid var(--line); padding:13px 2px 4px; margin-top:11px; }
.req .rt{ font-size:14px; font-weight:600; display:flex; align-items:center; gap:9px; }
.req .added{ font-family:var(--mono); font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); border-radius:4px; padding:1px 6px; }
.req .unimpl{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }
.req .shall{ font-size:13.5px; color:var(--muted); line-height:1.5; margin:6px 0 8px; }
.scn{ display:flex; gap:9px; font-family:var(--mono); font-size:12.5px; color:var(--muted); padding:3px 0; }
.scn .tri{ color:var(--faint); }
.reqfoot{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.covchip{ font-family:var(--mono); font-size:11.5px; color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); border-radius:6px; padding:4px 8px; display:inline-flex; align-items:center; gap:6px; }
.covchip.zero{ color:var(--amber); background:var(--amber-bg); border-color:var(--amber-line); }
.tasks{ border:1px solid var(--line2); border-radius:11px; overflow:hidden; margin-top:4px; }
.tasks .th{ font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:9px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.trow{ display:flex; align-items:center; gap:10px; padding:9px 13px; border-bottom:1px solid var(--line); font-family:var(--mono); font-size:12.5px; }
.trow:last-child{ border:none; }
.trow .bar{ margin-left:auto; width:120px; height:6px; border-radius:3px; background:var(--green-bg); position:relative; overflow:hidden; }
.trow .bar i{ position:absolute; left:0; top:0; bottom:0; background:var(--green); }
.trow .ct{ color:var(--muted); width:44px; text-align:right; }
`;
export function frame07() {
  const band = `<div class="specband rel">
    <span class="anno" style="left:-30px;top:14px">${dot(1)}</span>
    <div class="name">${ic.spec}build-model-council-v1 <span class="counts">· 2 new capabilities · 3 modified · tasks 34/34 ✓</span></div>
    <p class="why"><b>Why:</b> the council exists only as prose, and the R10 budget ceiling is dead code. This slice gives it a body: the versioned job catalogue, the deterministic resolver, the live runtime budget that counts every invocation including retries, and a resolution trace that can always answer why a job ran on a given model.</p>
  </div>`;

  const spine = `<div class="spine">
    <div>
      <h4>What changes</h4>
      <ul class="wc">
        <li><span class="capchip">model-council</span>A versioned JOB_CATALOGUE plus three availability tables and a pure resolveAssignment resolver.</li>
        <li><span class="capchip">budget-gate</span>A shared runtime budget whose tryConsume counts retries and refuses over the ceiling.</li>
        <li><span class="capchip">pipeline</span>buildReviewCanvases seeds one shared budget and stamps the resolved model into provenance.</li>
      </ul>
    </div>
    <div>
      <h4>Impact</h4>
      <div class="impact"><b>packages/core</b> + types + protocol. <b>No new package</b>, no new dependency, no dependency-arrow change. The council is pure data plus pure functions; the budget is a pure closure. Out of scope: the settings UI keys (#28), the CodexUtilityPort (#66).</div>
    </div>
  </div>`;

  const grid = `<div class="grid-h">Capabilities</div>
  <div class="capgrid">
    <div class="capcard new"><div class="cn">model-council <span class="tg">new</span></div><div class="cm">4 requirements · 7 scenarios</div></div>
    <div class="capcard new"><div class="cn">invocation-budget-gate <span class="tg">new</span></div><div class="cm">2 requirements · 3 scenarios</div></div>
    <div class="capcard"><div class="cn">review-pipeline</div><div class="cm">modified · 1 requirement</div></div>
    <div class="capcard open rel">
      <span class="anno" style="left:-30px;top:14px">${dot(2)}</span>
      <div class="cn">model-council <span class="tg">new</span> <span class="cm" style="margin:0 0 0 auto">expanded</span></div>
      <div class="req">
        <div class="rt">resolveAssignment is pure and deterministic <span class="added">added</span></div>
        <div class="shall">SHALL resolve in order: task-override › tier-override › council table (by availability) › harness default. A partial override keeps the table’s unset fields.</div>
        <div class="scn"><span class="tri">▸</span>the table resolves each job under both / claude-only / codex-only</div>
        <div class="scn"><span class="tri">▸</span>task beats tier beats table, and the trace records the winner</div>
        <div class="scn"><span class="tri">▸</span>a deterministic-tier job resolves to no model</div>
        <div class="reqfoot rel"><span class="anno" style="left:-30px;top:2px">${dot(3)}</span><span class="covchip">${ic.coverage}covered by 5 hunks · 4 tests</span><span class="chip">resolver.test.ts</span></div>
      </div>
      <div class="req">
        <div class="rt">Cross-harness routing places light work off the reviewer (R39) <span class="added">added</span></div>
        <div class="shall">Under both, light-tier work SHALL resolve to a different installed harness than the heavy review sessions.</div>
        <div class="scn"><span class="tri">▸</span>chunk-titles resolves to codex while the reviewer resolves to claude-code</div>
        <div class="reqfoot"><span class="covchip zero">${ic.coverage}unimplemented · 0 hunks</span></div>
      </div>
    </div>
  </div>`;

  const tasks = `<div class="grid-h">Tasks · 34 / 34</div>
  <div class="tasks">
    <div class="th">tasks.md · grouped progress</div>
    <div class="trow">1 · Shared types<span class="bar"><i style="width:100%"></i></span><span class="ct">6/6</span></div>
    <div class="trow">2 · The resolver<span class="bar"><i style="width:100%"></i></span><span class="ct">5/5</span></div>
    <div class="trow">4 · Wire the budget onto the live runners<span class="bar"><i style="width:100%"></i></span><span class="ct">3/3</span></div>
    <div class="trow">7 · Tests + gates<span class="bar"><i style="width:100%"></i></span><span class="ct">10/10</span></div>
  </div>`;

  const body = `<div class="lensbar">${lensTabs('spec')}<div class="right"><button class="btn">raw markdown ⌘R</button></div></div>${band}${spine}${grid}${tasks}`;

  return {
    title: 'Rennet v3 · 07 Spec view',
    head: { badge: '07', title: 'Spec view: the structured artifact viewer', pill: 'Review' },
    ref: 'the openspec shape, rendered\nworked on build-model-council-v1',
    sub: 'The artifact set has a known shape, so Rennet renders the <b>shape</b>, not the raw markdown: a header band, the distilled why, the why / what-changes spine, a capability grid, and requirements as structured rows with their WHEN/THEN scenarios and coverage. Requirements, scenarios and tasks are all disposition anchors. Raw markdown is one keystroke away.',
    css: reviewCss + css07,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.spec}</span>build-model-council-v1`, meta: tmeta('spec · ⌘R raw'), body }),
    notes: [
      { h: 'Render the shape, not the markdown.', b: 'Header band, distilled why, spine, capability grid, requirement rows. The raw files are always one keystroke away, never the default.' },
      { h: 'The spec is reviewable material.', b: 'The same conversation cluster works on a requirement, a scenario, a task, or a why paragraph. A request-change on a requirement collates like any other disposition.' },
      { h: 'Coverage wires it to the diff.', b: 'Each requirement shows “covered by N hunks · N tests” from the existing mapping; click jumps to the claiming hunk. Zero hunks renders an honest “unimplemented”.' },
      { h: 'New capabilities are add-green.', b: 'A green edge on the card, matching the diff’s add semantics, so new versus modified reads without a word.' },
    ],
  };
}

/* ---------- 08 Decisions ---------- */
export const css08 = `
.dgroup{ margin-bottom:20px; }
.dgroup-h{ font-family:var(--mono); font-size:11.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin:0 0 11px; }
.dcard{ border:1px solid var(--line2); border-radius:12px; padding:15px 17px; margin-bottom:11px; }
.dcard .stmt{ font-size:15px; font-weight:600; line-height:1.45; margin-bottom:10px; }
.dcard .ev{ display:flex; gap:7px; flex-wrap:wrap; margin-bottom:11px; }
.evchip{ font-family:var(--mono); font-size:11.5px; color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:6px; padding:4px 8px; display:inline-flex; align-items:center; gap:6px; }
.why-recon{ border-left:2px solid var(--line2); padding-left:12px; margin-bottom:10px; }
.why-recon .wl{ font-family:var(--mono); font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--faint); margin-bottom:3px; }
.why-recon .wt{ font-size:13.5px; color:var(--muted); line-height:1.5; }
.alt{ font-size:12.5px; color:var(--faint); }
.alt b{ color:var(--muted); font-weight:600; }
.dcard-foot{ display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:11px; border-top:1px solid var(--line); }
`;
export function frame08() {
  const grp1 = `<div class="dgroup rel">
    <span class="anno" style="left:-30px;top:24px">${dot(1)}</span>
    <div class="dgroup-h">Storage & state</div>
    <div class="dcard">
      <div class="stmt">One refill-on-read bucket per org, stored behind a RateStore interface. No timers.</div>
      <div class="ev"><span class="evchip">${ic.coverage}bucket.ts L14-23</span><span class="evchip">${ic.coverage}store.ts</span><span class="evchip">${ic.spec}proposal · What Changes</span></div>
      <div class="why-recon rel"><span class="anno" style="left:-30px;top:0">${dot(2)}</span><div class="wl">why · reconstructed</div><div class="wt">State advances only when a request arrives, so idle orgs cost nothing and there is no sweep to schedule. The interface keeps Redis out of the core.</div></div>
      <div class="alt"><b>Not taken:</b> a timer-driven refill loop; a single shared global bucket.</div>
      <div class="dcard-foot"><button class="btn sm">${ic.comment}Comment</button><button class="btn sm">${ic.reqchange}Request change</button><button class="btn sm">${ic.question}Question</button><button class="btn sm">${ic.discuss}Discuss</button></div>
    </div>
  </div>`;

  const grp2 = `<div class="dgroup">
    <div class="dgroup-h">Failure posture</div>
    <div class="dcard">
      <div class="stmt">Fail open on store error, bounded by a process-local fallback bucket at 5x the org limit.</div>
      <div class="ev"><span class="evchip">${ic.coverage}rate-limit.ts L44-47</span><span class="evchip">${ic.spec}PR body</span><span class="evchip">${ic.flag}flagged · 1</span></div>
      <div class="why-recon"><div class="wl">why · reconstructed</div><div class="wt">A limiter outage must never become an API outage; failing closed turns every store blip into a 5xx storm. The local cap keeps a full outage from becoming unlimited scraping.</div></div>
      <div class="alt"><b>Not taken:</b> fail closed; unbounded fail-open (the flagged disagreement).</div>
      <div class="dcard-foot"><button class="btn sm">${ic.comment}Comment</button><button class="btn sm">${ic.reqchange}Request change</button><button class="btn sm">${ic.question}Question</button><button class="btn sm">${ic.discuss}Discuss</button></div>
    </div>
  </div>`;

  const body = `<div class="lensbar">${lensTabs('decisions')}<div class="right"><span class="chip">2 groups · 4 decisions</span></div></div>${grp1}${grp2}`;

  return {
    title: 'Rennet v3 · 08 Decisions',
    head: { badge: '08', title: 'Decisions: the calls the implementer made', pill: 'Review' },
    ref: 'purified, per Rai’s re-steer\nno triage taxonomy',
    sub: 'The decisions the implementer made, discernible from the spec, the PR body and the diff, grouped by theme. Each is the decision in plain language, the evidence it is drawn from, a <b>reconstructed</b> why (marked as such), and the alternatives not taken. The evidenced / mechanical / contestable buckets are gone; judging a decision is the reviewer’s job, not a pre-chewed verdict’s.',
    css: reviewCss + css08,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.decisions}</span>#482 · Decisions`, meta: tmeta('per-org rate limiting'), body }),
    notes: [
      { h: 'The calls only you can weigh.', b: 'Decisions discerned from spec, PR body and diff, grouped by theme (for example a dedicated module for the glass theme, or a fail-open posture).' },
      { h: 'The why is reconstructed, and says so.', b: 'The rationale is inferred and labeled reconstructed, in the model’s voice. It is a starting read, not a claim of fact.' },
      { h: 'Alternatives not taken.', b: 'When the diff or PR body makes them discernible, the roads not travelled are named, so the decision is a decision and not just a description.' },
      { h: 'No triage buckets.', b: 'The evidenced / mechanical / contestable classification is dropped: it was exactly the mutation Rai flagged. Grouping plus evidence is enough.' },
    ],
  };
}

/* ---------- 09 Flagged ---------- */
export const css09 = `
.flagrow{ border:1px solid var(--line2); border-radius:12px; padding:14px 16px; margin-bottom:11px; display:flex; gap:14px; }
.flagrow.disagree{ background:var(--amber-bg); border-color:var(--amber-line); }
.sev{ flex:none; display:flex; flex-direction:column; align-items:center; gap:5px; width:56px; }
.sev .badge2{ font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase; border-radius:5px; padding:3px 6px; }
.sev .high{ color:#a8434f; background:#fbeef0; border:1px solid #e6c3c9; }
.sev .med{ color:var(--amber); background:#f6efdb; border:1px solid var(--amber-line); }
.sev .low{ color:var(--muted); background:#fff; border:1px solid var(--line2); }
.flagbody{ flex:1; min-width:0; }
.flagbody .ft{ font-size:14.5px; font-weight:600; line-height:1.45; margin-bottom:8px; }
.flagbody .meta{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.agree{ font-family:var(--mono); font-size:11.5px; display:inline-flex; align-items:center; gap:6px; border-radius:6px; padding:4px 8px; }
.agree.concur{ color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); }
.agree.split{ color:var(--amber); background:#fff; border:1px solid var(--amber-line); }
.anchor{ font-family:var(--mono); font-size:12px; color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:6px; padding:4px 8px; display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.split-answers{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
.sa{ border:1px solid var(--amber-line); border-radius:9px; padding:10px 12px; background:#fff; }
.sa .h{ font-family:var(--mono); font-size:12px; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:5px; }
.sa .b{ font-size:12.5px; color:var(--muted); line-height:1.45; }
`;
export function frame09() {
  const f1 = `<div class="flagrow rel">
    <span class="anno" style="left:-30px;top:16px">${dot(1)}</span>
    <div class="sev">${ic.flag}<span class="badge2 high">high</span></div>
    <div class="flagbody">
      <div class="ft">Unbounded fail-open lets any org scrape without limit during a store outage.</div>
      <div class="meta"><span class="agree concur">${ic.check}both models concur · 3/3</span><span class="chip">model council</span><span class="anchor">${ic.coverage}rate-limit.ts L44 →</span></div>
    </div>
  </div>`;

  const f2 = `<div class="flagrow disagree rel">
    <span class="anno" style="left:-30px;top:16px">${dot(2)}</span>
    <div class="sev">${ic.flag}<span class="badge2 med">medium</span></div>
    <div class="flagbody">
      <div class="ft">Retry-After semantics: is the header in seconds or milliseconds?</div>
      <div class="meta"><span class="agree split">${ic.flag}models disagree</span><span class="anchor">${ic.coverage}rate-limit.ts L50 →</span></div>
      <div class="split-answers">
        <div class="sa"><div class="h"><span style="color:var(--blue)">${ic.harness}</span>Claude</div><div class="b">Spec says seconds (RFC 7231). The value here is ms, so clients back off 1000x too long.</div></div>
        <div class="sa"><div class="h"><span style="color:var(--amber)">${ic.harness}</span>codex</div><div class="b">The client wrapper divides by 1000 on read, so ms is correct end to end. No bug, just an unclear name.</div></div>
      </div>
    </div>
  </div>`;

  const f3 = `<div class="flagrow">
    <div class="sev">${ic.flag}<span class="badge2 low">low</span></div>
    <div class="flagbody">
      <div class="ft">metrics.count label “rate.store_error” is not in the registered metric set.</div>
      <div class="meta"><span class="agree concur">${ic.check}both concur · 3/3</span><span class="chip">self-consistency</span><span class="anchor">${ic.coverage}rate-limit.ts L45 →</span></div>
    </div>
  </div>`;

  const body = `<div class="lensbar">${lensTabs('flagged')}<div class="right rel"><span class="anno" style="right:150px;top:-30px">${dot(3)}</span><span class="chip">3 flags · 1 disagreement</span></div></div>${f1}${f2}${f3}`;

  return {
    title: 'Rennet v3 · 09 Flagged',
    head: { badge: '09', title: 'Flagged: what the automated review raised', pill: 'Review · new' },
    ref: 'the new lens\nfindings + disagreements, indexed',
    sub: 'Everything the automated review layer produced: model-council findings and dual-review disagreements. Each flag carries a severity, the agreement state (both concur, or the models disagree), and its anchor. The disagreement flare lives here, in the index, instead of ambushing you in the chat.',
    css: reviewCss + css09,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.flag}</span>#482 · Flagged`, meta: tmeta('model council · dual review'), body }),
    notes: [
      { h: 'One index for the machine’s opinions.', b: 'Model-council findings and dual-review disagreements, in one queue. This is the lens that repairs Decisions by subtraction: everything machine-opinionated leaves it.' },
      { h: 'Severity plus agreement state.', b: 'Each flag says how bad and how sure: both models concur, or they disagree, with the vote counts.' },
      { h: 'Disagreement lives here.', b: 'When the models split, both answers sit side by side in this lens, labeled. It no longer flares up mid-conversation in the chat.' },
      { h: 'The lens is an index, not a house.', b: 'The flags still render as marks at their anchors on the code surfaces; this lens is the thing that jumps you to them.' },
    ],
  };
}

/* ---------- 10 Symbol inspector ---------- */
export const css10 = `
.grid-insp{ display:grid; grid-template-columns:1fr 300px; gap:0; }
.insp-center{ padding-right:20px; min-width:0; position:relative; }
.peek{ position:absolute; z-index:8; width:340px; left:250px; top:150px;
  background:#fff; border:1px solid var(--line2); border-radius:11px; box-shadow:0 24px 50px -20px rgba(20,26,33,.4); overflow:hidden; }
.peek::before{ content:""; position:absolute; left:-7px; top:26px; width:12px; height:12px; background:#fff; border-left:1px solid var(--line2); border-bottom:1px solid var(--line2); transform:rotate(45deg); }
.peek .ph{ display:flex; align-items:center; gap:9px; padding:10px 13px; background:var(--glass); border-bottom:1px solid var(--line); }
.peek .sig{ font-family:var(--code); font-size:12.5px; font-weight:600; }
.peek .tier{ margin-left:auto; font-family:var(--mono); font-size:10.5px; color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); border-radius:5px; padding:2px 6px; }
.peek .pbody{ padding:11px 13px; }
.peek .doc{ font-size:12.5px; color:var(--muted); line-height:1.5; margin-bottom:8px; }
.peek .pcode{ font-family:var(--code); font-size:12px; line-height:1.7; color:var(--text); white-space:pre; }
.peek .pact{ display:flex; gap:8px; padding:10px 13px; border-top:1px solid var(--line); }
.insp-rail{ border-left:1px solid var(--line); padding-left:18px; margin:-4px 0; }
.insp-h{ font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; margin-bottom:11px; }
.crumb{ display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11.5px; color:var(--muted); margin-bottom:10px; flex-wrap:wrap; }
.crumb .cur{ color:var(--text); font-weight:600; }
.navbtns{ display:flex; gap:6px; margin-bottom:10px; }
.miniprev{ border:1px solid var(--line2); border-radius:9px; overflow:hidden; }
.miniprev .mh{ font-family:var(--mono); font-size:12px; font-weight:600; padding:9px 11px; background:var(--glass); border-bottom:1px solid var(--line); display:flex; align-items:center; gap:7px; }
.miniprev .ml{ font-family:var(--code); font-size:12px; line-height:1.75; padding:3px 11px; color:var(--text); white-space:pre; }
.miniprev .ml .sy{ color:var(--blue-ink); text-decoration:underline; text-decoration-style:dotted; }
`;
export function frame10() {
  const center = `<div class="insp-center rel">
    <div class="chunk-h"><span class="nm">Token bucket</span><span class="chip">opaque</span></div>
    <div class="file">
      <div class="file-h"><span class="p"><span style="color:#5a6069">${'<>'}</span> src/rate/bucket.ts</span><span class="d">+74 −0</span><span class="fa"><button class="btn sm">${ic.flask}view test</button><button class="btn sm">${ic.editor}</button></span></div>
      ${dl('15', '+', '  const now = Date.now()')}
      ${dl('16', '+', '  const prior = (await this.<span class="sy-hit">store.get</span>(key)) ?? this.full(now)', 'on')}
      ${dl('17', '+', '  const tokens = Math.min(this.capacity, prior.tokens + elapsed * this.refillPerSec)')}
      ${dl('20', '+', '    return { allowed: false, retryAfterMs: ((cost - tokens) / this.refillPerSec) * 1000 }')}
      ${dl('23', '+', '  return { allowed: true, remaining: Math.floor(tokens - cost) }')}
    </div>
    <div class="peek rel">
      <span class="anno" style="left:-30px;top:8px">${dot(1)}</span>
      <div class="ph"><span style="color:#5a6069">${ic.peek}</span><span class="sig">RateStore.get</span><span class="tier">TypeScript · exact</span></div>
      <div class="pbody">
        <div class="doc">Read the persisted bucket for a key, or null if the org has never been seen.</div>
        <div class="pcode">get(key: string):
  Promise&lt;BucketState | null&gt;
// backed by Redis in prod,
// an in-memory map in tests</div>
      </div>
      <div class="pact"><button class="btn sm">${ic.editor}Open in editor</button><button class="btn sm ink">${ic.inspector}Pin</button><button class="btn sm">${ic.coverage}refs</button></div>
    </div>
  </div>`;

  const rail = `<div class="insp-rail rel">
    <span class="anno" style="left:-2px;top:-2px">${dot(2)}</span>
    <div class="insp-h">${ic.inspector}Inspector · pinned</div>
    <div class="crumb"><span>take</span>${ic.chevronR}<span>RateStore.get</span>${ic.chevronR}<span class="cur">BucketState</span></div>
    <div class="navbtns"><button class="btn sm">${ic.chevron.replace('M8 10l4 4 4-4', 'M14 6l-6 6 6 6')}back</button><button class="btn sm">fwd ${ic.chevronR}</button><button class="btn sm">${ic.editor}editor</button></div>
    <div class="miniprev">
      <div class="mh"><span style="color:#5a6069">${'<>'}</span>store.ts · BucketState</div>
      <div class="ml">interface <span class="sy">BucketState</span> {</div>
      <div class="ml">  tokens: number</div>
      <div class="ml">  updatedAt: number</div>
      <div class="ml">  capacity: <span class="sy">Capacity</span></div>
      <div class="ml">}</div>
    </div>
    <div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-top:12px">navigation stays here · the diff never moves</div>
  </div>`;

  const body = `<div class="lensbar">${lensTabs('sequence')}<div class="right"><span class="chip">${ic.peek}peek · then pin</span></div></div><div class="grid-insp">${center}${rail}</div>`;

  return {
    title: 'Rennet v3 · 10 Symbol inspector',
    head: { badge: '10', title: 'Symbol inspector: peek, then pin', pill: 'Review' },
    ref: 'the answer to “what is this?”\nnever inline, never reflowing',
    sub: 'A plain click on a symbol opens a floating glass peek card at the symbol: signature, doc, the first lines, and a tier label (a tree-sitter guess versus a TypeScript answer). Pin it and the card docks into the right rail as a tiny code browser you navigate with a breadcrumb and back / forward. The navigation happens inside the inspector, so the diff never moves.',
    css: reviewCss + css10,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.branch}</span>atlas · feat/rate-limiting`, meta: tmeta('snapshot'), body }),
    notes: [
      { h: 'Plain click peeks.', b: 'A floating glass card points at the symbol and never covers the clicked line. Clicking another symbol retargets the same peek; Esc dismisses it.' },
      { h: 'The tier label is honest.', b: 'A TypeScript answer says exact; a tree-sitter guess says guess and, when degraded, lists its candidates. The LSP-honesty doctrine, surfaced.' },
      { h: 'Pin docks it into the rail.', b: 'The pinned inspector is a mini code browser: symbols inside its preview are clickable and navigate it deeper, with a breadcrumb chain and back / forward.' },
      { h: 'The diff is a fixed point.', b: 'All inspector navigation stays in the rail; the code column never moves. Cmd-click skips the peek and opens the editor directly.' },
    ],
  };
}

/* ---------- Noise lens (new, issue #34) ---------- */
export const cssNoise = `
.noisesum{ display:flex; align-items:center; gap:11px; border:1px solid var(--line2); border-radius:11px; padding:12px 15px; margin-bottom:14px; background:var(--glass); }
.noisesum .nt{ font-size:14px; font-weight:600; }
.noisesum .nn{ font-size:13px; color:var(--muted); }
.noisesum .floor{ margin-left:auto; font-size:12px; color:var(--faint); display:flex; align-items:center; gap:7px; }
.noiserow{ display:flex; align-items:center; gap:14px; border:1px solid var(--line2); border-radius:11px; padding:13px 15px; margin-bottom:10px; }
.noiserow .nb{ flex:1; min-width:0; }
.noiserow .row-t{ font-size:14.5px; font-weight:600; display:flex; align-items:center; gap:9px; }
.noiserow .nc{ font-family:var(--sans); font-size:12.5px; color:var(--muted); font-weight:400; }
.noiserow .nr{ font-size:13px; color:var(--muted); margin-top:4px; line-height:1.45; }
.noiserow .nj{ flex:none; display:flex; align-items:center; gap:9px; }
.judge{ font-size:11.5px; border-radius:6px; padding:4px 9px; display:inline-flex; align-items:center; gap:6px; }
.judge svg{ width:13px; height:13px; }
.judge.det{ color:var(--muted); background:#fff; border:1px solid var(--line2); }
.judge.llm{ color:var(--blue-ink); background:var(--blue-bg); border:1px solid var(--blue-line); }
.noiserow .expand{ color:#aab0b8; }
`;

const noiseRow = (icon, title, count, reason, judgeKind, judgeLabel, judgeIcon, annoN) => `<div class="noiserow rel">${annoN ? `<span class="anno" style="left:-30px;top:16px">${dot(annoN)}</span>` : ''}<span class="gly sm">${icon}</span><div class="nb"><div class="row-t">${title} <span class="nc">${count}</span></div><div class="nr">${reason}</div></div><div class="nj"><span class="judge ${judgeKind}">${judgeIcon}${judgeLabel}</span><button class="btn sm">not noise?</button><span class="expand">${ic.chevron}</span></div></div>`;

export function frameNoise() {
  const summary = `<div class="noisesum rel"><span class="anno" style="left:-30px;top:14px">${dot(1)}</span><span class="nt">Noise</span><span class="nn">36 hunks across 14 files · collapsed</span><span class="floor">${ic.check} totality floor · nothing dropped</span></div>`;

  const rows = [
    noiseRow(ic.noise, 'Formatting &amp; whitespace', '14 hunks', 'Reflowed by the formatter; no semantic change.', 'det', 'rule · formatter', ic.check, 2),
    noiseRow(ic.repo, 'Lockfile churn', 'pnpm-lock.yaml · 1,204 lines', 'Dependency graph unchanged; the lockfile was regenerated.', 'det', 'rule · lockfile path', ic.check),
    noiseRow(ic.sequence, 'Import reordering', '8 files', 'Only the order of imports changed, by the AST check.', 'det', 'rule · import-order', ic.check),
    noiseRow(ic.spec, 'Generated output', '3 files · source maps', 'Build artifacts, regenerated from source.', 'det', 'rule · generated', ic.check),
    noiseRow(ic.flask, 'Test fixture renames', '6 files', 'A mechanical rename; behaviour is identical across the suite.', 'llm', 'noise job', ic.harness, 3),
    noiseRow(ic.comment, 'Comment typos', '4 hunks', 'Spelling fixes inside comments; no code was touched.', 'llm', 'noise job', ic.harness),
  ].join('');

  const body = `<div class="lensbar">${lensTabs('noise')}<div class="right"><span class="chip">6 groups · 36 hunks</span></div></div>${summary}${rows}`;

  return {
    title: 'Rennet v3 · Noise',
    head: { badge: '10', title: 'Noise: touched, but not for you', pill: 'Review · new' },
    ref: 'issue #34 · cut the noise\ngrouped, judged, dismissible',
    sub: 'A grouped summary of everything the changeset touches but that was judged not to need your attention. Most of it is settled deterministically (the formatter, lockfile paths, import order); the ambiguous remainder is judged by an LLM noise job, and each group says which. Nothing is hidden: noise is collapsed and dismissible, never dropped. It is the totality floor.',
    css: reviewCss + cssNoise,
    win: win({ name: `<span class="gly sm plain" style="width:20px;height:20px">${ic.noise}</span>#482 · Noise`, meta: tmeta('the floor · nothing hidden'), body }),
    notes: [
      { h: 'Touched, not hidden.', b: 'Everything the changeset touches is here; noise is grouped and collapsed, never dropped. This is the totality floor: the review saw all of it.' },
      { h: 'How it was judged.', b: 'Each group says whether a deterministic rule (the formatter, the lockfile path, an import-order AST check) or the LLM noise job decided it was noise.' },
      { h: 'Deterministic first.', b: 'Most noise is mechanical and settled by rule; only the ambiguous remainder goes to a noise job, and it is marked as such rather than hidden among the rules.' },
      { h: 'Still yours to reopen.', b: 'Disagree with a call? “Not noise” pulls a group back into the review. Noise is dismissible, never invisible.' },
    ],
  };
}
