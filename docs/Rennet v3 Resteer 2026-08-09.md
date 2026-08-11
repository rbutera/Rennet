---
tags: [rennet, design, ux, resteers]
categories: [reference]
status: active
created: 2026-08-09
updated: 2026-08-09
related: ["[[Rennet Product and Vision]]", "[[Rennet Design Doctrine]]", "[[Rennet User Journey]]", "[[Rennet Contracts and Rulings]]", "[[Code Review Harness App]]"]
source: Rai verbatim feedback (2026-08-09, Discord) + fable UX/IA advice v2 + two codex code-reads + the v3 prototype
---

# Rennet v3 Resteer 2026-08-09

Durable record of the day Rai resteered Rennet's product surface after seeing the v2 wireframes. This is the CAPTURE, not the full rewrite: a faithful record of his verbatim feedback, the resolved direction per item, the v3 prototype that answers it, the two codex findings about where the drift actually lives, and the four fresh updates he asked for after seeing v3. A broader fable-orchestrated resteer of the whole doc/issue set runs after this and will fold these decisions into the individual authority docs.

Sources (absolute paths):

- Rai's verbatim feedback plus Navi's structured index: `/Users/rai/notes/Rennet wireframes feedback.md`
- Approved direction and the two codex code-reads (file:line citations): `/Users/rai/dev/expedition/reports/rennet-resteer-synthesis.md`
- Detailed UX/IA advice: `/Users/rai/dev/expedition/reports/rennet-resteer-fable-advice-v2.md`
- The v3 prototype (17 frames): gallery at https://nimbus.piranha-wyvern.ts.net:9443/ ; iterable source at `/Users/rai/navi/workspace/media/rennet-wireframes-v3/src/`

## The day's arc: feedback to resolved direction

Rai sent feedback "in no specific order" after living with the v2 wireframes. His two anxieties on waking: "decisions got skewed or mutated somewhere along the way over the last 4 days and lots of things in the prototype point to things I didn't ask for," and a worry that the codebase itself had rotted. Codex read the actual code on the two flagged items and found the mutation is NOT in the code. It is wireframe drift living in the cheap layer, not the architecture. The flip side, told straight: more is unbuilt than the aspirational mockups implied.

Per item, feedback then resolution:

1. **Consent bar to title-bar glyph.** Feedback: kill the consent banner; put an execution-mode icon in the title bar, click for a dropdown of modes, default auto; the "read only" and "nothing touched" chrome bits are "pointless noise." Resolved: one mode glyph in the title bar showing the current mode (auto unadorned, read-only = glyph plus lock for a retrospective review). Click opens a one-word-label dropdown with a one-line fact each and a single standing disclosure line in the footer. Global default with a per-project override remembered per project. Banner, "read only" pill, and "nothing touched" chrome all die. (Superseded: there is no "ask" mode that gates a model run — reviewing code with a model is Rennet's whole job, so it just runs; only publishing a review out to a forge stays an explicitly confirmed external act.)

2. **Scrap the four-noun UI component.** Feedback: "the four nouns as a ui component is quite frankly kinda retarded." Replace with a plain flow: Projects list, Add-a-project (workspace or project repo, find the path, then worktree config), then it processes the repo with a delightful narrated spinner that explains what it is doing in real time. Resolved: there is no wizard. First run is the empty state of the Projects list (one large Add-a-project affordance plus an ambient harness-detection line). The only vocabulary the user meets is "workspace" and "project repo." The processing screen is the initial context dump and the opening act of the tutorial.

3. **Project detail view (IDEAS WANTED).** Feedback: click a project to see all PRs including your own, filterable, plus detected local worktrees and branches shown separately from PRs (same list but logically split, or a switcher: "give me some ideas"). Local ones become a PR (click, review, turn into a local PR or re-steer); remote ones enter "teammate review mode." Resolved (recommendation, still open to iteration): one scrolling surface, two materially distinct zones. Zone 1 "Yours" (local worktrees/branches in backlight, with a captured/reviewed/PR'd trajectory indicator, terminal verbs Make PR and Re-steer). Zone 2 "Team" (all PRs including your own, in ink). A filter bar unifies them; the two zone chips double as a soft switcher (collapse one zone to a one-line header). Dedupe rule: once a branch has a PR, the PR row wins and the local worktree becomes an annotation on it.

4. **Scrap the Stage 2 first screen.** Feedback: "Stage 2 first screen seems a bit shit... Scrap it. I bet I've covered the important bits from up above." Resolved: gone. The old workspace-discovery tree visualisation dies; what survives is only the list of found worktrees as toggle rows inside Add-a-project step 2.

5. **Stage 3 keep.** Feedback: "Stage 3 is good though... That's what you should see once you've clicked a branch worktree or pr... Or when you click refresh. Really like that one." Resolved: kept as the post-click and post-refresh review surface. Its narration is the same component as the processing screen (one narration organ everywhere).

6. **Stage 4 keep, just taller.** Feedback: good except no viewport-fold element; "I was just expecting the wireframe to be taller." Resolved: kept, rendered tall with real scroll and no viewport-fold theatre.

7. **Impl/test button reword.** Feedback: the "implement / test" toggle is silly; it should be a button that says "view test" on the implementation and "view implementation" on the test. Resolved: a single context-labeled button reading `view test` on an implementation hunk and `view implementation` on a test. Honest disabled state `no tests` when nothing references it.

8. **Symbol click UX (IDEAS WANTED).** Feedback: inline definition is "proper weird"; open-in-editor yes, but an in-app preview or inspector makes the most sense. Resolved (recommendation): peek-then-pin. Plain click opens a floating glass-framed card near the symbol (signature, doc comment, first lines of the definition, origin path, tree-sitter-vs-TypeScript honesty label) with open-in-editor, pin, and references actions. Pinning docks it into the right rail as a mini code browser (breadcrumb, back/forward) whose navigation never moves the diff. Never inline, never reflows.

9. **OpenSpec view = structured artifact viewer (IDEAS WANTED).** Feedback: not raw markdown; we know the artifact shape ahead of time, so show it structured and beautiful, and support comment / request-change / ask-question. Use a real rennet openspec proposal set as the worked example. Resolved (recommendation, worked against `build-model-council-v1`): a structured document with a header band, a prose spine (Why / What Changes / Impact), a capability grid, and requirements/scenarios rendered as structured rows. Requirements and scenarios are first-class disposition anchors (the same comment/request-change/question/discuss cluster works on them). Coverage chips wire each requirement to its claiming hunks and tests; a requirement with zero hunks renders an honest `unimplemented` state.

10. **Decisions purified plus the Flagged lens (re-steer).** Feedback: "Claims and decisions are so weird here." Decisions should be the decisions the implementer made, discernible from spec/PR-body/diff, grouped (e.g. "made a dedicated module for the glass theme"). A new Flagged lens should hold the things flagged by the automated LLM review (model council / dual review). Resolved: Decisions is purified to grouped implementer decisions with evidence chips and a reconstructed why; the evidenced/mechanical/contestable triage taxonomy is dropped from the UI (that classification layer is exactly the mutation he flagged). Flagged is a NEW lens: an index of automated-review findings with severity, agreement state, and anchor. The flags still render as marks at their anchors on the code surfaces; the lens is the index that jumps to them.

11. **Question routing.** Feedback: questions should go to the orchestrator by default, with an option to ask both models; the current sidebar auto-fires to codex and does "some weird synthesis" that "feels robotic and it's not what I'm looking for." Resolved: default orchestrator-only. The ask composer gets one small per-message affordance (`ask both models`), remembered per thread, never sticky globally. When both are asked, render two labeled answers side by side. No synthesis paragraph, no merge block, ever.

## The v3 prototype

Seventeen HTML frames (00 to 16), rendered to PNG. Gallery: https://nimbus.piranha-wyvern.ts.net:9443/ . Iterable source (edit these, then rebuild): `/Users/rai/navi/workspace/media/rennet-wireframes-v3/src/` (per-frame `.html` plus the shared kit `kit.mjs`, `finalize.mjs`, `onboarding.mjs`, `review.mjs`, built via `build.mjs`).

| Frame | What it addresses |
|---|---|
| 00 Legend | The reading key: material and register vocabulary (glass, ink = public/what-exists-in-the-world, backlight = private/local), icon vocabulary, chrome-voice rule. Read first. |
| 01 First run | Projects-list empty state IS the onboarding: one large Add-a-project affordance plus the ambient harness-detection line. Kills the wizard (items 2, 4). |
| 02 Add a project | Segmented workspace vs project repo, then a path picker. Replaces the four-noun component (item 2). |
| 03 Worktree config | Detected worktrees as editable toggle rows, one Confirm. What survives of the scrapped Stage 2 (items 2, 4). |
| 04 Processing | The narrated context dump: real-time pipeline narration that becomes the project. The identity moment (item 2). See fresh update 4 below: MVP ships a spinner placeholder. |
| 05 Project detail | Two-zone scroll, Yours (local, backlight) vs Team (all PRs incl. own, ink), filter bar with zone chips as a soft switcher (item 3, IDEAS-WANTED). |
| 06 The review heart | The kept Stage-3 review surface Rai liked, with the disposition cluster (items 5, 6). |
| 07 Spec view | Structured OpenSpec artifact viewer: header band, capability grid, requirements/scenarios as disposition anchors, coverage chips (item 9, IDEAS-WANTED). |
| 08 Decisions | Purified decisions lens: grouped implementer decisions discerned from spec/PR-body/diff, evidence chips, reconstructed why; triage taxonomy dropped (item 10). |
| 09 Flagged | The NEW lens: automated-review / model-council findings with severity, agreement state, anchor (item 10). |
| 10 Symbol inspector | Peek-then-pin: floating glass card on click, pins into the right rail as a mini code browser; never inline, diff never reflows (item 8, IDEAS-WANTED). |
| 11 Collation draft | The accumulated-dispositions draft canvas before publish. |
| 12 Paper / sign | The publish ceremony: the review posted to GitHub as the human's signed verdict. |
| 13 Questions | Orchestrator-only by default, optional per-message "ask both models," two labeled answers side by side, no synthesis block (item 11). |
| 14 Settings | Execution mode and config; the mode also lives as the title-bar glyph (item 1). |
| 15 Command palette | Keyboard-first navigation across the app. |
| 16 Flow overview | The whole shell as one map: projects-list to add to processing to project-detail to review surfaces to draft to paper. |

## The two codex findings (where the drift actually lives)

Both read the real code on main (5040334) and both concluded the "mutation" Rai feared is wireframe drift, not code rot. File:line citations copied from the synthesis report.

### Finding 1: question routing (the "auto-fire to codex plus synthesis block")

Not in the code on main. No dual-fire, no synthesis anywhere.

- `bootOrchestratorSession` / `OrchestratorSession.buildRequest` at `packages/core/src/orchestrator-session.ts:125` selects ONE harness, ONE request.
- `buildOrchestratorRequest` at `packages/core/src/context-update-stream.ts:365` packages only the question plus view context.
- `resolveAssignment` at `packages/core/src/model-council.ts:468` returns one assignment. `orchestrator-chat` and `context-ask-*` exist only in catalogue/tables, with zero execution call sites.
- The sidebar "Question" is an L2 review disposition (`packages/ui/src/components/disposition.tsx:22`), not a model request. Live orchestrator wiring is explicitly follow-up (`collation-draft-canvas.tsx:99`, `canvas-ops.ts:850`).

Recommendation: add `review.ask` to the protocol with `mode: "orchestrator" | "both"`, default `"orchestrator"`. Core always calls the orchestrator session once; only `"both"` additionally invokes Codex. Return a labeled `primary` plus optional `secondOpinion`, with no synthesis call or variant. UI: "ask both" is an unchecked per-message toggle; the Codex answer renders as a compact secondary block.

### Finding 2: decisions lens (the "mutated triage taxonomy")

The projector already matches Rai's intent; the producer never landed. Real reviews emit an EMPTY decisions lens, not a taxonomy.

- `buildReviewCanvases` at `packages/core/src/pipeline.ts:208` admits only `decomposition.proposal`; no `decision.record` or `claim` docs are produced. Test confirms no cohorts: `pipeline.test.ts:718`.
- `projectDecisions` / `DOC_TYPE_ANGLE` at `packages/core/src/canvas.ts:47` routes `decision.record` to decisions and emits `kind:"decision"` grouped by anchored decomposition chunk. Structurally this is already "implementer decisions, grouped" (his intent).
- `projectFlat` at `packages/core/src/canvas.ts:240` routes `claim` docs to a flat claims lens, currently showing only the literal title "claim."
- No triage drift: `mechanical` is deterministic diff/noise classification, `evidenced-by` is a decomposition edge kind, `disposition-triage` is a council catalogue row only. There is no `documentRejected` event (`rejectedItems` are malformed RSP items dropped, not triage). Git blame: decisions routing is unchanged since the original canvas implementation.

Recommendation: (1) capture immutable review-intent inputs with the patchset (PR title/body plus spec snapshots/digests). Today `Patchset` at `packages/types/src/index.ts:43` has none, and `GitHubForgeAdapter` at `packages/adapters/src/github-forge.ts:38` fetches the title but not the body. (2) Add a decision-extraction runner over {spec, PR body, diff} emitting validated `decision.record` items (concise title, diff/chunk anchor, evidence). Keep chunk grouping; no evidenced/mechanical/contestable buckets. (3) Add `flagged` as a new `CanvasAngle` and route admitted `finding` docs to it. The vocabulary exists (`RspDocType "finding"`, council jobs `finding-generation`/`adjudication`/`self-consistency` in `model-council.ts:167`) but is catalogue-only, with no schema, runner, data, or aggregation yet. Never repurpose validator rejections.

## Four fresh updates Rai asked for after seeing v3

These land on the prototype next (the prototype is the iterable surface; edit `src/`):

1. **Add a Noise lens.** A lens for noise (low-signal / suppressed diff churn), distinct from Decisions and Flagged. Definition of what counts as noise vs a flag is an open call (see below).
2. **No monospace as UI chrome.** Monospace is for actual code only, never as interface texture or decoration. Chrome uses the proportional type.
3. **Execution-mode toggle on every in-project frame.** The title-bar mode glyph is present on all in-project screens, not just Settings, so the current mode is always visible and switchable.
4. **Processing = spinner placeholder for MVP.** The delightful "bots fetching context" narrated animation (frame 04, the rotating glass prism with live narration) is post-MVP. The MVP ships a plain spinner placeholder in that slot.

## Open design calls and carried tensions

- **Project detail split mechanism** (frame 05) is still explicitly IDEAS-WANTED. Chips-as-soft-switcher is the recommendation, but Rai said "maybe a switcher or something, I don't know, give me some ideas." Not settled.
- **Noise lens definition** (fresh update 1) needs a crisp boundary against Flagged and Decisions: what is noise, who classifies it, and does it map to the existing `mechanical` deterministic diff/noise classification.
- **Symbol inspector references** (frame 10): ship definition first, references later. The reference-browsing depth is designed but sequenced behind the definition peek.
- **OpenSpec viewer against a real artifact set** (frame 07): fable worked it against `build-model-council-v1`; the real changes live under `/Users/rai/dev/rennet/openspec/changes/` and the structured shape should be validated against a current set before build.
- **Unbuilt more than the wireframes implied** (both codex findings): `review.ask` protocol, the decision-extraction producer, and the flagged runner/schema/aggregation are all catalogue-or-mockup only. The v3 frames show intent; the code is the thing to build.
- **Authorship seam**: the terse-chrome-vs-content-voice split (chrome obeys the four-word rule; model-voiced narration and prose regions breathe) needs to be stated once as doctrine, because it recurs across the processing screen, the spec viewer, and the decision cards.

---

*A fuller content resteer of the individual authority docs (Design Doctrine, User Journey, Contracts and Rulings, Product and Vision, Code Review Harness App) is in progress via the fable-orchestrated pass. This document is the faithful record it draws from.*
