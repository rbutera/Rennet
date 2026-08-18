#!/usr/bin/env node
// Generates a self-contained wireframe gallery HTML from the v3 PNGs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canonical home is the repo's wireframes/ dir: PNGs sit beside this script, gallery is emitted here.
const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = __dir;
const OUT = resolve(__dir, 'gallery.html');

const b64 = (f) => `data:image/png;base64,${readFileSync(resolve(DIR, f)).toString('base64')}`;

// screen metadata (flow order), grouped by stage
const SCREENS = [
  { f: '00-legend.png', n: 'Legend', tag: 'Reference', p: 'Every glyph defined. The flask (view test / impl), Flagged and Symbol-peek are new; the ink-vs-blue material law and the title-bar execution-mode glyphs are the vocabulary contract.', feats: [] },
  { f: '01-first-run.png', n: 'First run', tag: 'Onboarding', p: 'The empty projects list. Add-a-project is the whole onboarding; harness detection is one ambient backlight line. No wizard, no ceremony.', feats: [] },
  { f: '02-add-project.png', n: 'Add a project', tag: 'Onboarding', p: 'Two nouns only: workspace or project repo, a path, and a recents / detected list. Everything else is inference.', feats: [] },
  { f: '03-worktree-config.png', n: 'Worktree config', tag: 'Onboarding', p: 'Discovery shown as editable defaults, not questions. Include toggles all on, primary branch confirmed, one Confirm.', feats: [] },
  { f: '04-processing.png', n: 'Processing', tag: 'Onboarding', p: 'The narrated context dump. An honest MVP spinner over a live feed; completed lines collapse into a ledger, then it becomes the project. A more delightful animation is promoted post-MVP.', feats: [] },
  { f: '04a-projects-list.png', n: 'Projects list', tag: 'Home', p: 'The populated front door — the same screen as first-run, now with projects. One row per project, most-recently-active first; a row is a whole project — a single repo or a multi-repo workspace. Add-a-project stays present as its own row; detection stays one ambient line. Row states drawn: active/needs-you, quiet, processing, stale-map, never-opened.', feats: [] },
  { f: '05-project-detail.png', n: 'Project detail', tag: 'Home', p: 'The everyday landing: ONE smart list, no hard zones (the ratified model, matching shipped #37/#216). Every branch, worktree and PR reads by state — local backlight, my-PR accent stripe, teammate PR neutral, needs-you amber, merged read-only + dimmed. Hot sort floats what needs you; filters All / Needs-you / Mine / Local / PRs. v4.0 adds the nav spine: a title-bar breadcrumb (Projects › orbital) and a slim left rail with back/forward — and back from any review lands HERE, the review’s real home, not the front door.', feats: [] },
  { f: '06-review-heart.png', n: 'The review heart', tag: 'Review', p: 'The tall sequence canvas. In-diff dispositions, the inline conversation cluster on every line, view-test + open-in-editor on the sticky header. v4.0 replaces the right margin with ONE unified conversation — a lightweight chat stream (an icon per ask type; line-anchored messages read as a reply to their line, Messenger-style) that gives the orchestrator a visible home, collapses to the sidebar and expands to full screen. The breadcrumb + nav rail frame it. Real scroll, no fold.', feats: [] },
  { f: '06a-delta-rereview.png', n: 'Delta re-review', tag: 'Review', p: 'The successor review after a handoff turn: the delta account states what moved before you re-read a line — each staged ask addressed / partially / untouched, and every path changed beyond your asks, surfaced loud. The facts are deterministic (no model); a light-tier LLM digest sits on top as the one-glance read. v4.0 promotes the patchset to a title-bar chip whose trail lists the lineage (9 ‹ 8 ‹ 7), current pinned, predecessors read-only. It gates nothing.', feats: [] },
  { f: '07-spec-view.png', n: 'Spec view', tag: 'Review', p: 'The openspec artifact set rendered as its shape: distilled why, capability grid, requirement rows with WHEN/THEN scenarios, coverage chips. Reviewable material, not raw markdown. Worked on a real rennet change.', feats: [] },
  { f: '08-decisions.png', n: 'Decisions', tag: 'Review', p: 'The calls the implementer made, grouped by theme, with evidence chips, a reconstructed why, and the alternatives not taken. The evidenced / mechanical / contestable taxonomy is gone.', feats: [] },
  { f: '09-flagged.png', n: 'Flagged', tag: 'Review', p: 'Model-council findings and dual-review disagreements, indexed by severity and agreement state, jumping to the marks at their anchors. The disagreement flare lives here, not in chat.', feats: [] },
  { f: '10-noise-lens.png', n: 'Noise', tag: 'Review', p: 'New. A grouped summary of everything the changeset touches but that was judged not to need attention: most settled by deterministic rule, the remainder by an LLM noise job, each group saying which. The totality floor: collapsed and dismissible, never dropped (issue #34).', feats: [] },
  { f: '11-symbol-inspector.png', n: 'Symbol inspector', tag: 'Review', p: 'Peek, then pin. A floating glass card on plain click (signature, doc, tier label), or a docked mini code-browser that navigates deeper without ever moving the diff.', feats: [] },
  { f: '12-collation-draft.png', n: 'Collation draft', tag: 'Draft', p: 'The one editable draft before sign. Merge, split, reorder, withdraw, and converse on staged chunks. The orchestrator proposes; you dispose. In v4.0 it is a crumb child of the review (… › feat/rate-limiting › Draft) — one crumb-click or Esc ascends back. Editing lives here.', feats: [] },
  { f: '13-paper-sign.png', n: 'Paper', tag: 'Sign', p: 'The one solid object. It previews exactly what will post; the verdict is derived from your dispositions and override-able, and the human sign carries it. A crumb child of the Draft (… › Draft › Paper); back lands on the Draft, where editing lives. The sign in the loop is the safety.', feats: [] },
  { f: '14-questions.png', n: 'Questions', tag: 'Ask', p: 'The unified conversation (frame 06) expanded to full screen — the same one stream, given room for a long back-and-forth. Orchestrator by default, with an opt-in split to ask both models; when both, two labeled answers side by side, never a synthesis block. As an overlay it never moves the crumb.', feats: [] },
  { f: '15-settings.png', n: 'Settings', tag: 'Cross-cutting', p: 'The layered config ladder (global › workspace › repo), per-repo guidance, worktree location, and the mode default. Terse: facts and their source. v4.0 makes it orbital — reachable from every screen and returning to exactly where you were, review and scroll intact, never a detour through the front door.', feats: [] },
  { f: '16-command-palette.png', n: 'Command palette', tag: 'Cross-cutting', p: 'Command-K, the keyboard spine. Every action a named, remappable command — and now a Navigate group on every screen (Go to project…, Open review…, Back / Forward, Go to Draft / Paper, Open Settings) with recent locations on an empty query. The retired claims lens is gone from the offered set.', feats: [] },
  { f: '17-flow-overview.png', n: 'Flow overview', tag: 'The map', p: 'The forward journey as one map: two entry points (your local work toward Make PR, a teammate’s PR into review), one draft, one signed paper, and the material legend. The journey map; frame 18 is the navigation structure that binds it.', feats: [] },
  { f: '18-navigation-model.png', n: 'Navigation model', tag: 'Navigation model', p: 'New (v4.0) — the model this version is named for. The structure map: the hybrid spine (title-bar breadcrumb for “where am I”, a left nav rail with back/forward for “how did I get here”, the palette for “where can I go”), the full destination tree with every place tagged peer / child / overlay, the tab-vs-crumb-vs-overlay law, the history keys (⌘[ / ⌘]), one-review-at-a-time, and the patchset trail. Pure wayfinding: it adds reachable places and never a gate.', feats: [] },
  { f: '19-mobile-pairing.png', n: 'Mobile · connect & pair', tag: 'Mobile', p: 'Phase 6 gate (#382). First run to paired: the desk mints the QR (pairing.mint), the phone scans or types the one-time code (pairing.exchange) and lands on the connections list — multiple daemons, harness disclosure, revocable device token. Tailscale-first, no relay; an unreachable daemon degrades to its last replica.', feats: [] },
  { f: '20-mobile-review-list.png', n: 'Mobile · review list & kickoff', tag: 'Mobile', p: 'Home. Reviews across projects and daemons; running and needs-you pinned, freshness a row fact. Kickoff covers both loops: paste / share-sheet a PR link (review.openPr) or capture your own branch pre-submit (review.capture) — the same end-to-end loop as desktop.', feats: [] },
  { f: '21-mobile-review-detail.png', n: 'Mobile · review detail & digest', tag: 'Mobile', p: 'The canvas digest read path at phone width: delta digest counts, delta rows, then one finding at a time — claim, size-ceilinged hunk, one-tap agree / disagree / discuss, proposal adjudication inline. Full canvas a tap away; a 40-file raw diff never renders here.', feats: [] },
  { f: '22-mobile-ask.png', n: 'Mobile · live turn & ask', tag: 'Mobile', p: 'The typed live stream with return-to-tail, a visible Stop, and explicit interrupt-vs-queue send semantics. An ask is chips + optional free text in one review.ask reply. Reattach after backgrounding is the normal case (onAskStream rebind, #389).', feats: [] },
  { f: '23-mobile-publish.png', n: 'Mobile · sign & post', tag: 'Mobile', p: 'The headline: preview → Face-ID-confirmed sign → posted, from anywhere. The paper shows exactly what appears under Rai’s name; outcome stated truthfully with the real URL; own-branch flow ends the same way (draft body → sign → idempotent PR).', feats: [] },
  { f: '24-mobile-notifications.png', n: 'Mobile · pushes & deep links', tag: 'Mobile', p: 'The closed notification taxonomy made visible: six events push, each carrying its substance and deep-linking to the decision surface; the ask push is answerable from the shade. Presence-aware delivery decided daemon-side; everything else stays in-app.', feats: [] },
];

const CALLS = [
  'The nav rail is a slim 64px icon rail (back/forward · Home · Projects · lineage) sitting beside project detail’s own repo rail. Right weight, or should the two rails merge on the project screen?',
  'Line-anchored chat messages wear a quoted reply chip above the text (Messenger style). Reads as “a reply to this line” — or would a left-edge line-number gutter read cleaner?',
  'Back from a review lands on project detail, and ⌘[ / ⌘] are drawn as rail buttons. Is temporal back/forward worth its chrome, or is hierarchical “up” via the crumb enough?',
  'Processing draws one slow glass prism as the app’s only motion. Enough delight for the identity moment, or does it want more?',
  'Symbol click is drawn as plain-click-peek, with hover reserved for a modifier-hold underline. Or should hover itself peek?',
  'Flagged uses three severities (high / medium / low). Right granularity, or too much?',
  'Decisions are grouped by theme. Group by file / area instead when the change is large?',
  'The spec view surfaces a zero-coverage requirement as a quiet amber "unimplemented" chip. Louder?',
];

const TENSIONS = [
  'Onboarding (02 add-project, 03 worktree-config) still wants its explicit ‹ Projects escape drawn alongside the step counter — deferred from this v4.0 nav pass.',
  'Spec-only reviews (the spec canvas as the whole review, before code exists) are in the flow but not separately mocked.',
  'Watch mode, a live view while an agent edits the working tree, has no ratified UX yet; the processing feed is the closest pattern.',
  'Predecessor patchsets are trail-listed but not browsable in v4.0 (deliberate — the read-only look-back is deferred).',
];

const card = (s, i) => `
  <figure class="screen" id="s${i}">
    <div class="cap">
      <span class="tag">${s.tag}</span>
      <h3>${s.n}</h3>
      ${s.feats.length ? `<span class="feats">${s.feats.map((x) => `<code>${x}</code>`).join('')}</span>` : ''}
    </div>
    <p class="purpose">${s.p}</p>
    <div class="frame"><img loading="lazy" alt="${s.n} wireframe" src="${b64(s.f)}" /></div>
  </figure>`;

const html = `<style>
  :root{
    --ground:#0e1116; --surface:#161b22; --surface-2:#1b222c; --border:#232b36;
    --text:#e6edf3; --muted:#8b98a5; --faint:#5b6572;
    --accent:#8cc0e8; --accent-soft:rgba(140,192,232,.14); --amber:#e3b341;
    --maxw:1180px;
  }
  @media (prefers-color-scheme: light){
    :root{ --ground:#eef1f5; --surface:#ffffff; --surface-2:#f6f8fa; --border:#d5dbe2;
      --text:#161b22; --muted:#57606a; --faint:#8b95a1; --accent:#1f6f9f; --accent-soft:rgba(31,111,159,.10); --amber:#9a6700; }
  }
  :root[data-theme="dark"]{ --ground:#0e1116; --surface:#161b22; --surface-2:#1b222c; --border:#232b36;
    --text:#e6edf3; --muted:#8b98a5; --faint:#5b6572; --accent:#8cc0e8; --accent-soft:rgba(140,192,232,.14); --amber:#e3b341; }
  :root[data-theme="light"]{ --ground:#eef1f5; --surface:#ffffff; --surface-2:#f6f8fa; --border:#d5dbe2;
    --text:#161b22; --muted:#57606a; --faint:#8b95a1; --accent:#1f6f9f; --accent-soft:rgba(31,111,159,.10); --amber:#9a6700; }

  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--ground); color:var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height:1.55; -webkit-font-smoothing:antialiased; }
  .mono{ font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; }
  code{ font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:.82em;
    background:var(--accent-soft); color:var(--accent); padding:.08em .4em; border-radius:5px; }
  .wrap{ max-width:var(--maxw); margin:0 auto; padding:0 clamp(16px,4vw,40px); }

  header.hero{ border-bottom:1px solid var(--border); padding:clamp(40px,7vw,72px) 0 clamp(28px,4vw,40px); }
  .kicker{ font-family:ui-monospace,Menlo,monospace; font-size:12px; letter-spacing:.18em;
    text-transform:uppercase; color:var(--accent); margin:0 0 14px; }
  h1{ font-size:clamp(30px,5vw,46px); line-height:1.05; margin:0 0 14px; letter-spacing:-.02em; text-wrap:balance; font-weight:650; }
  .lede{ font-size:clamp(15px,2vw,18px); color:var(--muted); max-width:70ch; margin:0; }
  .meta{ display:flex; flex-wrap:wrap; gap:8px 10px; margin-top:22px; }
  .meta span{ font-family:ui-monospace,Menlo,monospace; font-size:11.5px; letter-spacing:.04em;
    color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:5px 11px; background:var(--surface); }

  section{ padding:clamp(30px,5vw,52px) 0; }
  .sec-head{ display:flex; align-items:baseline; gap:14px; margin:0 0 6px; }
  .sec-head h2{ font-size:clamp(19px,2.4vw,24px); margin:0; letter-spacing:-.01em; font-weight:640; }
  .sec-head .idx{ font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--faint); }
  .sec-sub{ color:var(--muted); margin:0 0 26px; max-width:60ch; }

  .stage-band{ display:flex; align-items:center; gap:12px; margin:38px 0 18px; }
  .stage-band::after{ content:""; flex:1; height:1px; background:var(--border); }
  .stage-band .lbl{ font-family:ui-monospace,Menlo,monospace; font-size:12px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); }

  .screen{ margin:0 0 40px; }
  .screen .cap{ display:flex; align-items:baseline; flex-wrap:wrap; gap:10px 12px; margin:0 0 6px; }
  .screen .tag{ font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:.09em; text-transform:uppercase;
    color:var(--accent); border:1px solid var(--border); border-radius:5px; padding:3px 8px; background:var(--accent-soft); }
  .screen h3{ font-size:19px; margin:0; font-weight:600; letter-spacing:-.01em; }
  .screen .feats{ display:inline-flex; gap:5px; }
  .screen .purpose{ color:var(--muted); margin:0 0 14px; max-width:72ch; }
  .frame{ border:1px solid var(--border); border-radius:12px; overflow:hidden; background:var(--surface);
    box-shadow: 0 1px 0 rgba(255,255,255,.02), 0 18px 40px -28px rgba(0,0,0,.6); }
  .frame img{ display:block; width:100%; height:auto; }

  .callout{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:clamp(20px,3vw,30px); }
  .callout.amber{ border-color:color-mix(in srgb, var(--amber) 45%, var(--border)); }
  ol.calls{ margin:0; padding-left:1.3em; display:flex; flex-direction:column; gap:14px; }
  ol.calls li{ padding-left:6px; }
  ol.calls li::marker{ color:var(--amber); font-family:ui-monospace,Menlo,monospace; font-weight:600; }
  ul.tensions{ margin:0; padding-left:1.1em; display:flex; flex-direction:column; gap:12px; color:var(--muted); }
  ul.tensions li::marker{ color:var(--faint); }

  footer{ border-top:1px solid var(--border); padding:34px 0 60px; color:var(--faint); font-size:13px; }
  a{ color:var(--accent); }
  :focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }
</style>

<header class="hero"><div class="wrap">
  <p class="kicker">Rennet &middot; lo-fi wireframes &middot; v4.1</p>
  <h1>The whole app, one scroll — desktop, and now the phone.</h1>
  <p class="lede">Twenty-seven screens in flow order. v4.1 adds the mobile set (frames 19–24, the phase 6 gate’s wireframe pass, #382): pairing, review list + kickoff, the digest read path, live turn + ask, sign &amp; post, and the push taxonomy — every phone screen naming the protocol commands and event topics it consumes. v4.0 was v3.3 plus a coherent navigation model: a hybrid wayfinding spine — a title-bar breadcrumb for “where am I,” a slim left nav rail with back/forward (⌘[ / ⌘]) for “how did I get here,” and the command palette’s Navigate group for “where can I go.” Back from a review lands on project detail, its real home. The review’s right side is now one unified, chat-style conversation (an icon per ask type, line-anchored messages that read as replies) that gives the orchestrator a home. The patchset gets a title-bar chip and trail; Settings goes orbital; and a new frame 18 draws the whole structure — peers, children, overlays, and the history. Pure wayfinding, no gates.</p>
  <div class="meta">
    <span>27 screens</span><span>mobile set (19–24)</span><span>breadcrumb + nav rail</span><span>back/forward · ⌘[ ⌘]</span>
    <span>unified chat panel</span><span>palette Navigate group</span><span>patchset trail</span><span>settings orbital</span><span>one review at a time</span><span>no gates</span>
  </div>
</div></header>

<main class="wrap">
${(() => {
  let out = '';
  let lastTag = null;
  SCREENS.forEach((s, i) => {
    if (s.tag !== lastTag) { out += `<div class="stage-band"><span class="lbl">${s.tag}</span></div>`; lastTag = s.tag; }
    out += card(s, i);
  });
  return out;
})()}

  <section>
    <div class="sec-head"><h2>Open design calls</h2><span class="idx mono">decide as you scroll</span></div>
    <p class="sec-sub">Judgment calls this pass made. Each is a genuine fork worth a react.</p>
    <div class="callout amber"><ol class="calls">${CALLS.map((c) => `<li>${c}</li>`).join('')}</ol></div>
  </section>

  <section>
    <div class="sec-head"><h2>Carried, undrawn</h2><span class="idx mono">named but not mocked</span></div>
    <p class="sec-sub">Design tensions that survive into v4.0 without a screen yet.</p>
    <div class="callout"><ul class="tensions">${TENSIONS.map((t) => `<li>${t}</li>`).join('')}</ul></div>
  </section>
</main>

<footer><div class="wrap">Rennet wireframes v4.1 &middot; the mobile set (phase 6 gate) &middot; v3.3 plus a coherent navigation model &middot; HTML sources in wireframes/src, iterable further.</div></footer>`;

writeFileSync(OUT, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`wrote ${OUT} (${kb} KB, ${(kb / 1024).toFixed(1)} MB)`);
