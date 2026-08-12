import { ic, dot } from './kit.mjs';

// legend item
const li = (icon, name, desc, opts = {}) =>
  `<div class="lg">${opts.plain ? `<span class="gly plain">${icon}</span>` : `<span class="gly">${icon}</span>`}<div><div class="lg-n">${name}${opts.new ? ' <span class="tag-new">new</span>' : ''}</div><div class="lg-d">${desc}</div></div></div>`;

const colHead = (t) => `<div class="col-h">${t}</div>`;

export const css00 = `
.legend-grid{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:0 34px; }
.legend-col{ display:flex; flex-direction:column; }
.col-h{ font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--faint); margin:6px 0 4px; padding-top:14px; }
.legend-col > .col-h:first-child{ padding-top:0; }
.lg{ display:flex; align-items:center; gap:13px; padding:9px 0; border-bottom:1px solid var(--line); }
.lg:last-child{ border-bottom:none; }
.lg-n{ font-size:14px; font-weight:600; letter-spacing:-.005em; }
.lg-d{ font-size:12.5px; color:var(--muted); margin-top:1px; line-height:1.35; }
.tag-new{ font-family:var(--mono); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--green); background:var(--green-bg); border:1px solid var(--green-line); border-radius:4px; padding:1px 5px; vertical-align:1px; }
.matlaw{ display:flex; gap:10px; margin-top:10px; }
.matlaw .m{ flex:1; border:1px solid var(--line2); border-radius:9px; padding:11px 12px; }
.matlaw .m.blue{ background:var(--blue-bg); border-color:var(--blue-line); }
.matlaw .m.ink{ background:var(--ink); }
.matlaw .m.ink .mh, .matlaw .m.ink .md{ color:#fff; }
.matlaw .m.ink .md{ opacity:.72; }
.mh{ font-size:13px; font-weight:600; display:flex; align-items:center; gap:7px; }
.md{ font-size:12px; color:var(--muted); margin-top:3px; line-height:1.4; }
.mh .swatch{ width:13px; height:13px; border-radius:4px; }
.blue .swatch{ background:var(--blue); } .ink .swatch{ background:#e7ebf0; }
.modebar{ display:flex; gap:9px; margin-top:9px; }
.mode{ flex:1; display:flex; align-items:center; gap:9px; border:1px solid var(--line2); border-radius:9px; padding:9px 11px; background:#fff; }
.mode .lg-n{ font-size:13px; } .mode .lg-d{ font-size:11.5px; }
.mode-gly{ position:relative; width:30px; height:30px; flex:none; border:1px solid var(--line2); border-radius:7px; display:flex; align-items:center; justify-content:center; }
.mode-gly svg{ width:16px; height:16px; }
.mode-gly .pin{ position:absolute; right:-4px; bottom:-4px; width:15px; height:15px; border-radius:50%;
  background:#fff; border:1px solid var(--line2); display:flex; align-items:center; justify-content:center; }
.mode-gly .pin svg{ width:10px; height:10px; }
`;

export function frame00() {
  const colA = `<div class="legend-col">
    ${colHead('Conversation cluster · verbs')}
    ${li(ic.check, 'Approve', 'accept this line, chunk or roll-up')}
    ${li(ic.reqchange, 'Request change', 'ask for a change, inline or staged')}
    ${li(ic.comment, 'Comment', 'a note that lands as a PR comment')}
    ${li(ic.question, 'Question', 'ask the orchestrator, on the anchor')}
    ${li(ic.discuss, 'Discuss', 'open a thread on a line, range or chunk')}
    ${li(ic.askharness, 'Ask the harness', 'private chat about these lines')}
    ${colHead('Travels vs stays · the material law')}
    <div class="matlaw">
      <div class="m ink"><div class="mh"><span class="swatch"></span>Ink</div><div class="md">publishes. Travels to the PR.</div></div>
      <div class="m blue"><div class="mh"><span class="swatch"></span>Blue</div><div class="md">stays local. Never leaves this machine.</div></div>
    </div>
  </div>`;

  const colB = `<div class="legend-col">
    ${colHead('The lenses')}
    ${li(ic.spec, 'Spec', 'the change intent, structured')}
    ${li(ic.sequence, 'Sequence', 'the reading order: the review heart')}
    ${li(ic.decisions, 'Decisions', 'the calls the implementer made')}
    ${li(ic.flag, 'Flagged', 'what the automated review raised', { new: true })}
    ${li(ic.noise, 'Noise', 'touched, but not for you', { new: true })}
    ${li(ic.coverage, 'Coverage', 'requirement to hunk and test mapping')}
    ${li(ic.peek, 'Symbol peek', 'a floating look at a definition', { new: true })}
    ${colHead('Execution mode · in the title bar')}
    <div class="modebar">
      <div class="mode"><span class="mode-gly">${ic.harness}</span><div><div class="lg-n">Auto</div><div class="lg-d">runs jobs</div></div></div>
      <div class="mode"><span class="mode-gly">${ic.harness}<span class="pin">${ic.dotpause}</span></span><div><div class="lg-n">Ask</div><div class="lg-d">confirms first</div></div></div>
      <div class="mode"><span class="mode-gly">${ic.harness}<span class="pin">${ic.lock}</span></span><div><div class="lg-n">Read-only</div><div class="lg-d">never invokes</div></div></div>
    </div>
  </div>`;

  const colC = `<div class="legend-col">
    ${colHead('Actions & objects')}
    ${li(ic.flask, 'View test / impl', 'flip a hunk to the tests that exercise it', { new: true })}
    ${li(ic.editor, 'Open in editor', '$EDITOR at the exact line')}
    ${li(ic.inspector, 'Symbol inspector', 'pin the peek into the right rail')}
    ${li(ic.orchestrator, 'Orchestrator', 'the one harness you converse with')}
    ${li(ic.harness, 'Harness / LLM', 'an installed coding agent')}
    ${li(ic.makepr, 'Make PR', 'the local review becomes a PR')}
    ${li(ic.resteer, 'Re-steer', 'hand changes back to the harness')}
    ${li(ic.sign, 'Sign', 'the deliberate hold-to-sign act')}
    ${li(ic.pr, 'Pull request', 'one changeset source, one publish target')}
    ${li(ic.branch, 'Branch / worktree', 'a local checkout, becoming a PR')}
    ${li(ic.palette, 'Command palette', 'every action, from the keyboard')}
  </div>`;

  const winBody = `<div class="legend-grid">${colA}${colB}${colC}</div>`;

  return {
    title: 'Rennet v3.3 · 00 Legend',
    head: { badge: '00', title: 'Legend: the icon language', pill: 'Reference' },
    ref: 'v3 · icon-forward chrome\ndefines every glyph used across 01-17',
    sub: 'Rennet’s own chrome speaks in icons where they save noise; the words that remain are terse labels. This key defines every glyph. The <b>LLM-generated canvas content</b> (narration, a model’s answer, a distilled why) is exempt from the terse rule and lives by its own voice.',
    css: css00,
    win: `<div class="win"><div class="tbar"><span class="tls"><span class="tl"></span><span class="tl"></span><span class="tl"></span></span><span class="tname"><span class="gly sm plain" style="width:20px;height:20px">${ic.sun}</span>Legend</span><span class="tmeta">lo-fi greyscale · glyphs are indicative</span></div><div class="content">${winBody}</div></div>`,
    notes: [
      { h: 'This is the vocabulary contract.', b: 'If a glyph is unclear here, it is unclear in the app. Flag any that don’t read instantly.' },
      { h: 'Two tiers.', b: 'About eight glyphs earn standalone use (approve, request-change, the lens tabs, the mode glyph); everything denser carries a one-word label, never a sentence.' },
      { h: 'Flagged and symbol-peek are new.', b: 'Flagged indexes the automated review; peek is the plain-click look at a symbol. Both replace older ideas Rai flagged as drift.' },
      { h: 'The flask replaces the arrow toggle.', b: 'v2’s impl/test arrows collided with other glyphs. One context-labeled button now reads “view test” on impl, “view implementation” on a test.' },
    ],
  };
}
