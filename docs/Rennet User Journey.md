---
tags: [rennet, ux, journeys]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-09
related: ["[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Design Doctrine]]", "[[Rennet Collation Draft Canvas]]", "[[Code Review App UX Concepts]]", "[[Code Review Harness App]]"]
source: 2026-08-07 journey synthesis (dashboard report) over the prototype UX docs + issue queue
---

# Rennet User Journey

> **Resteer 2026-08-09:** see [[Rennet v3 Resteer 2026-08-09]] and the v3 prototype (gallery https://nimbus.piranha-wyvern.ts.net:9443/). A fuller content resteer of this doc is in progress.

**The canonical, ordered account of the user's day in Rennet.** Every step below was already designed somewhere — the prototype docs, the plans, the issue queue — but no ratified document told the journey *in order*, and the ordering is itself a constraint no single issue owns: the product is a road from opening a changeset to **signing the paper**, and every UI slice must know where on that road it sits.

Authority: this document is **authority-ranked with the other ratified docs** — it owns the journey's shape and ordering. Feature depth stays with the feature's own doc ([[Rennet Product and Vision]] §4 and the deep specs); rulings stay in [[Rennet Contracts and Rulings]] (the staging semantics are R36–R38). Where an issue and this journey disagree about *where a step sits*, this document wins; file the discrepancy.

## The journey in one line

**Open → read through the lenses → dispose (= stage into the draft, R36/R40) → collate & refine the draft → sign the paper → [delta loop].** The destination — the paper that leaves the machine — is visible from minute one; but the *forming* destination is the editable **collation draft canvas** (R40), and the paper is the frozen sign downstream of it. Everything else exists to fill the draft responsibly, then crystallise it into paper.

## The nine stages

### Stage 0 — First run (the onboarding wizard) [R43]

**First run and home are two distinct screens** (R43, Rai's 2026-08-09 wireframe markup). First run is a proper **stepped onboarding wizard / tutorial**, not a static reporting screen: it walks the first-time user through what Rennet is and how to read a review. It still asks nothing the app can answer itself (harnesses already on the machine are auto-detected per the zero-config North Star, and the four-noun discovery over repos, worktrees, branches, and PRs runs underneath), but the *screen* is a guided introduction, seen once, not the everyday landing. From the second run onward the user lands on Home (Stage 1).

- **Owned by:** #29 (first run, now the onboarding wizard; home is a separate screen, #37).
- **Status: OPEN.** Not built.

### Stage 1 — Home (the control center) [R43]

**The everyday landing, second run onward**, a distinct screen from first run (R43). Home is the **control center / projects overview**: repos, worktrees, branches, and PRs with their review state. The two entry doors are both here: a working-tree changeset on your own branch, or someone's PR. Harness inventory shows as live status, private thread-count badges in backlight.

- **Owned by:** #37 (home surface / control center), #44 (command palette).
- **Status: OPEN.** Not built.

### Stage 2 — Open a review

One engine, two sources (both v1, R7): **your own branch** (local working-tree capture — committed, index, unstaged, untracked) or **someone else's PR** (GitHub ingest, local-diff-first, head pinning). Either way an immutable patchset (R28) and a review are born. **The destination is visible from this moment**: the paper renders *empty* at review-open, top-right, and the mode names what it will become — a PR review to post, or a PR submission / handoff bundle.

- **Owned by:** #20 (GitHub source — ✅ merged), core capture (✅ merged), #64 (the staging-toward-a-destination frame), #58 (consent gate before any harness runs).
- **Status: MIXED** — both sources merged; the visible-destination frame is OPEN.

### Stage 3 — Capture + decompose, narrated live

The fleet decomposes the changeset while the surface shows a **live narrative feed** — "reading the changeset… 214 hunks… chapter 3 looks like the risky one" — **never a spinner** ([[Rennet Design Doctrine]]; UX Concepts §C). The deterministic floor paints ≤15s to first useful chunk; each feed line becomes tappable as its artifact lands; the wait converts into a head start.

- **Owned by:** #54 (live pipeline wire-up — ✅ merged), decomposition floor (✅ merged), #71 (live narrative feed — filed 2026-08-07; no prior owner), #59 (render race).
- **Status: MIXED** — the pipeline is real; the narrated feed is OPEN.

### Stage 4 — Read through the angles

Six angles, five canvases + the blast-radius overlay. Free zoom in and out; roll-up narration at every altitude; the comprehension ordering (agent over the DAG baseline); the **fixed-point rule** — the hunk under the cursor never moves on lens rotation. The residue/totality guarantee is always one keystroke away: trust dies the moment the summary is the only view.

**Diff/code-view affordances [R45].** Every diff/code view carries an **implementation↔test toggle** (on an implementation hunk, flip to the tests that exercise it; on a test, flip back; "no tests reference this" is an honest first-class state) and **open-in-editor** (VS Code / Cursor / $EDITOR, deep-linked to the exact line, with copy disclosure before the click when it opens a materialised ref copy). These were ratified 2026-08-04 and re-affirmed as diff-view requirements in Rai's 2026-08-09 wireframe markup.

**Rich inline conversation [R46].** Reading is not a read-only act: the reviewer can **question, comment, request a change, or start a discussion inline**, anchored directly on a diff line, on a review-staged chunk, or on a conversation fragment, **not only in a separate chat surface**. The mark lives at its anchor (Design Doctrine §3.5); the per-diff back-and-forth is the disposition's inline `thread` (the comment-refinement loop, Contracts §2.5). This is the same interaction the reviewer carries into Stage 5 (dispose) and Stage 6 (the collation draft).

- **Owned by:** #11 (canvas UI, ✅ merged), #63 (make the code visible; impl↔test toggle + open-in-editor), #68 (syntax highlighting), #33/#34/#35 (spec/noise/blast canvases), #23 (LSP), #36/#109 (inline conversation: question/comment/request-change/discuss on line, chunk, or fragment), #62 (approachability).
- **Status: MIXED** — core canvases merged to demo quality; several canvases and the code-visibility work OPEN.

### Stage 5 — Dispose = stage

Every disposition (approve / request-change / comment / question, at any granularity) **is staged the moment it is made** (R36) — it lands, visibly, in the **forming destination, which is the editable collation draft canvas** (R40), *not* the paper. There is no separate staging act. The refiner cleans the raw draft in the background (§2.5 loop); the orchestrator is on tap for questions; **withdraw is the unstage** (R37), and editing a staged item is withdraw-and-restage in one gesture.

- **Owned by:** #17 (disposition UI — ✅ merged; its "batch view" is renamed the **staged view** per R37, and is the seed of the collation draft canvas per R40), #19 (comment-refinement build), #15 (context.ask), #13 (orchestrator — ✅ merged).
- **Status: MIXED** — disposing works; refinement loop and the staged-view rename OPEN.

### Stage 6 — The collation draft canvas (the real draft, editable)

The **forming destination** (R40): a canvas of its own, whose substrate is the L2 disposition set across every angle. Every disposition from every lens collates here into one coherent, **still-modifiable** working draft of the outbound artifact — the first time the whole account is visible as one object. It is **glass** (working state, translucent, yours), not paper. Here you collate, reword, retype, reorder, **merge** and **split** dispositions, withdraw (R37), watch the refiner clean raw notes in the background, and ask the orchestrator about the forming draft (it may *propose* on L3; you accept into L2 — it never writes the draft itself). The mode frames the work: **own-branch** leans composition-heavy (merge/reorder N dispositions into one coherent handoff bundle, #72); **other-PR** leans per-item-refinement-heavy (refine wording, group, drop — #19). Same canvas, same machinery, mode-framed labels.

- **Owned by:** the **collation draft canvas** owner issue (filed 2026-08-08 per R40 — promotes #17's staged view into a first-class glass canvas; absorbs the homes of #19 and #72), #17 (seed — ✅ merged), #19 (other-PR refinement), #72 (own-branch composition).
- **Status: OPEN** — the seed (staged view) is merged; the collation canvas itself is the new build target.

### Stage 7 — The paper (sign, frozen)

The one solid object in a translucent product, downstream of the collation draft. **Signing is a phase transition: glass crystallises into paper** (R40). The paper previews exactly what leaves and its only actions are **sign** and **back-to-draft** — editing lives on the draft (Stage 6), never here. Context decides the variant, never the model of action (one disposition model, two destinations — Contracts §2.1):

- **Someone else's PR** → the paper previews the **review it will post**: every line item in its refined form, the degradation ledger, the two-column travels-vs-stays split, hold-to-sign, ONE batched review event (R33). **Publish is all-or-nothing per signing act in v1 (R38)** — to ship a subset, withdraw first (on the draft), then sign.
- **Your own branch** → the paper previews the **PR submission** (title/body/draft, zero Git mutation, R33) or the **handoff bundle** — the collated task narrative composed on the draft, now frozen and handed to a coding harness.

- **Owned by:** #22 (publish sheet — **narrowed to the frozen paper + sign only** per R40; dark-paper theming lands here), #21 (publish pipeline), #18 (handoff loop), #64/#76 (the frame — now opens the draft, not the sheet), #74 (PR title/body drafting).
- **Status: OPEN** — the paper is designed everywhere and built nowhere. With the collation draft canvas it is the build's current center of gravity.

### Stage 8 — The delta re-review loop (own-branch mode)

The coding harness addresses the bundle on the branch → a new patchset arrives → Rennet presents **only what moved**. Approvals carry by lineage (byte-identical now; fuzzy matcher #16 later, fail-closed); an agent-authored change is never "already read"; the delta summary narrates what the agent did — including anything beyond your asks. The loop returns to Stage 4 on the successor canvas.

- **Owned by:** #18 (handoff loop), #16 (fuzzy carry), #48 (successor carry rule — RAI DECISION), #73 (delta re-review summarisation).
- **Status: OPEN.**

## Where the build stands against the journey (2026-08-08)

**Built: stages 3–5** (to demo quality). **Open: stages 0–1 and 6–8.** The app today is a middle with no beginning and no end — which is exactly why it "shows canvases, not a journey" (#62's "feels intimidating" is a symptom: without the destination on screen, the canvases have no for-the-sake-of). The steering consequence, ratified 2026-08-07 and sharpened 2026-08-08 (R40): **build the destination next**, now as two surfaces — the **collation draft canvas** (Stage 6, the editable forming destination) and the **paper** (Stage 7, the frozen sign) — with #64/#76 executed as a layout frame that opens the draft (every disposition visibly lands in it), ahead of further canvas polish.

## Standing convention: the journey-fit line

**Every UI issue's acceptance criteria must include a journey-fit line**: one sentence stating which stage the work sits in and what the user sees of the destination while using it. An issue that cannot state its journey-fit is describing a widget, not a step on the road. (Convention adopted 2026-08-07; apply it to new issues at filing time and to existing UI issues as they are picked up.)

## Standing convention: vertical scroll, screens are not one viewport [R44]

**Screens are not constrained to a single viewport; use vertical scroll.** A screen may be tall; do not cram a stage into one fold or truncate its content to fit. Vertical scroll is the expected shape; the constraints are the doctrine (glass=chrome, code=opaque, terse chrome, icon economy) and the journey-fit, not a viewport height. (Rai's 2026-08-09 wireframe markup, R44.)

---

*Written 2026-08-07 from the journey synthesis over [[Code Review App UX Concepts]] (§B staging semantics, §C live feed, the fixed-point rule), [[Code Review App Design Directions]] (the paper/glass register), [[Wingman GitHub Integration Plan]] (§3 the signing ceremony), [[Wingman Settings and Setup Plan]] (§5.1 first run), and the live issue queue. Nothing here is invented; the contribution is the order and the ownership map. Amended 2026-08-08 (R40, Rai blessed): stage 6 split into the collation draft canvas (editable) + the paper (sign); old stage 7 (delta) becomes stage 8. See [[Rennet Collation Draft Canvas]]. Amended 2026-08-09 (R43-R46, Rai's wireframe markup): stage 0 first run is a stepped onboarding wizard distinct from stage 1 home/control-center (R43); vertical scroll is a standing convention (R44); stage 4 gains the impl↔test toggle + open-in-editor affordances (R45) and the rich inline conversation model, question/comment/request-change/discuss on line, staged chunk, or fragment (R46).*
