---
tags: [rennet, ux, journeys]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-07
related: ["[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Design Doctrine]]", "[[Code Review App UX Concepts]]", "[[Code Review Harness App]]"]
source: 2026-08-07 journey synthesis (dashboard report) over the prototype UX docs + issue queue
---

# Rennet User Journey

**The canonical, ordered account of the user's day in Rennet.** Every step below was already designed somewhere — the prototype docs, the plans, the issue queue — but no ratified document told the journey *in order*, and the ordering is itself a constraint no single issue owns: the product is a road from opening a changeset to **signing the paper**, and every UI slice must know where on that road it sits.

Authority: this document is **authority-ranked with the other ratified docs** — it owns the journey's shape and ordering. Feature depth stays with the feature's own doc ([[Rennet Product and Vision]] §4 and the deep specs); rulings stay in [[Rennet Contracts and Rulings]] (the staging semantics are R36–R38). Where an issue and this journey disagree about *where a step sits*, this document wins; file the discrepancy.

## The journey in one line

**Open → read through the lenses → dispose (= stage, R36) → watch the destination fill → sign.** The destination — the paper that leaves the machine — is visible from minute one; everything else exists to fill it responsibly.

## The eight stages

### Stage 0 — First run

One screen, asks nothing, reports. Harnesses already on the machine are auto-detected (zero-config North Star); the four-noun discovery (repos, worktrees, branches, PRs) runs; no API-key ceremony, no questions the app can answer itself.

- **Owned by:** #29 (workspace discovery + first-run).
- **Status: OPEN** — not built.

### Stage 1 — Home

Repos, worktrees, branches, and PRs with their review state. The two entry doors are both here: a working-tree changeset on your own branch, or someone's PR. Harness inventory shows as live status, private thread-count badges in backlight.

- **Owned by:** #37 (home surface), #44 (command palette).
- **Status: OPEN** — not built.

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

- **Owned by:** #11 (canvas UI — ✅ merged), #63 (make the code visible), #68 (syntax highlighting), #33/#34/#35 (spec/noise/blast canvases), #23 (LSP), #36 (threads + diff chat), #62 (approachability).
- **Status: MIXED** — core canvases merged to demo quality; several canvases and the code-visibility work OPEN.

### Stage 5 — Dispose = stage

Every disposition (approve / request-change / comment / question, at any granularity) **is staged the moment it is made** (R36) — it lands, visibly, in the forming destination. There is no separate staging act. The refiner cleans the raw draft in the background (§2.5 loop); the orchestrator is on tap for questions; **withdraw is the unstage** (R37), and editing a staged item is withdraw-and-restage in one gesture.

- **Owned by:** #17 (disposition UI — ✅ merged; its "batch view" is renamed the **staged view** per R37), #19 (comment-refinement build), #15 (context.ask), #13 (orchestrator — ✅ merged).
- **Status: MIXED** — disposing works; refinement loop and the staged-view rename OPEN.

### Stage 6 — The destination: the paper

The one solid object in a translucent product. Context decides the variant, never the model of action (one disposition model, two destinations — Contracts §2.1):

- **Someone else's PR** → the paper previews the **review it will post**: every line item in its refined form, the degradation ledger, the two-column travels-vs-stays split, hold-to-sign, ONE batched review event (R33). **Publish is all-or-nothing per signing act in v1 (R38)** — to ship a subset, withdraw first, then sign.
- **Your own branch** → the paper previews the **PR submission** (title/body/draft, zero Git mutation, R33) or the **handoff bundle** — N refined dispositions composed into one coherent task narrative handed to a coding harness.

- **Owned by:** #22 (publish sheet), #21 (publish pipeline), #18 (handoff loop), #64 (the frame), #74 (PR title/body drafting) and #72 (handoff-bundle composition).
- **Status: OPEN** — the destination is designed everywhere and built nowhere. This is the build's current center of gravity.

### Stage 7 — The delta re-review loop (own-branch mode)

The coding harness addresses the bundle on the branch → a new patchset arrives → Rennet presents **only what moved**. Approvals carry by lineage (byte-identical now; fuzzy matcher #16 later, fail-closed); an agent-authored change is never "already read"; the delta summary narrates what the agent did — including anything beyond your asks. The loop returns to Stage 4 on the successor canvas.

- **Owned by:** #18 (handoff loop), #16 (fuzzy carry), #48 (successor carry rule — RAI DECISION), #73 (delta re-review summarisation).
- **Status: OPEN.**

## Where the build stands against the journey (2026-08-07)

**Built: stages 3–5** (to demo quality). **Open: stages 0–1 and 6–7.** The app today is a middle with no beginning and no end — which is exactly why it "shows canvases, not a journey" (#62's "feels intimidating" is a symptom: without the destination on screen, the canvases have no for-the-sake-of). The steering consequence, ratified 2026-08-07: **build the destination next** — #22 + a minimal #21 + #64 executed as a layout frame (the paper renders empty at review-open and every disposition visibly lands in it), ahead of further canvas polish.

## Standing convention: the journey-fit line

**Every UI issue's acceptance criteria must include a journey-fit line**: one sentence stating which stage the work sits in and what the user sees of the destination while using it. An issue that cannot state its journey-fit is describing a widget, not a step on the road. (Convention adopted 2026-08-07; apply it to new issues at filing time and to existing UI issues as they are picked up.)

---

*Written 2026-08-07 from the journey synthesis over [[Code Review App UX Concepts]] (§B staging semantics, §C live feed, the fixed-point rule), [[Code Review App Design Directions]] (the paper/glass register), [[Wingman GitHub Integration Plan]] (§3 the signing ceremony), [[Wingman Settings and Setup Plan]] (§5.1 first run), and the live issue queue. Nothing here is invented; the contribution is the order and the ownership map.*
