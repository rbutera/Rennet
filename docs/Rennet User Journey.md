---
tags: [rennet, ux, journeys]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-09
related: ["[[Rennet v3 Resteer 2026-08-09]]", "[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Design Doctrine]]", "[[Rennet Collation Draft Canvas]]", "[[Code Review App UX Concepts]]", "[[Code Review Harness App]]"]
source: 2026-08-07 journey synthesis (dashboard report) over the prototype UX docs + issue queue; resteered 2026-08-09 to the v3 prototype
---

# Rennet User Journey

> **Resteer 2026-08-09:** rewritten to the v3 prototype after Rai's wireframe feedback. Authority: [[Rennet v3 Resteer 2026-08-09]] and the v3 frames (gallery https://nimbus.piranha-wyvern.ts.net:9443/). The old wizard-and-home shape is gone; the shape below is the one Rai approved.

**The canonical, ordered account of the user's day in Rennet.** Every step below was designed somewhere (the prototype, the plans, the issue queue), but no single ratified document told the journey *in order*, and the ordering is itself a constraint no single issue owns: the product is a road from pointing at code to **signing the paper**, and every UI slice must know where on that road it sits.

Authority: this document is **authority-ranked with the other ratified docs**; it owns the journey's shape and ordering. Feature depth stays with the feature's own doc ([[Rennet Product and Vision]] and the deep specs); rulings stay in [[Rennet Contracts and Rulings]]. Where an issue and this journey disagree about *where a step sits*, this document wins; file the discrepancy.

## The journey in one line

**Point at code → watch it become a project → land on the two-zone project detail → open a review → read through the lenses → dispose (= stage into the draft, R36/R40) → collate and refine the draft → sign the paper → [re-steer / delta loop].** The destination (the paper that leaves the machine) is reachable from the first review; but the *forming* destination is the editable **collation draft canvas** (R40), and the paper is the frozen sign downstream of it. Everything else exists to fill the draft responsibly, then crystallise it into paper.

The whole shape as one map is the v3 flow overview (frame 17): two entry points, one draft, one sign. Your own local work flows toward **Make PR**; a teammate's PR is the other door, into the same review canvases.

## The stages

### Stage 0: First run: the empty Projects list

**First run is a *state* of the Projects list, not a separate flow.** There is no onboarding wizard and no four-noun component: the empty Projects list *is* the onboarding. The screen is one large **Add a project** affordance ("Point Rennet at a workspace or a repo") plus an ambient backlight line naming the harnesses found on the machine ("Claude, codex, gh, detected"). Detection is felt, not ceremonial; harness discovery does not earn a screen. Nothing here is once-only, so nothing can rot in a surface the user can never revisit. The only explicit teaching is a handful of coach marks that fire at their anchor and dismiss forever.

The only vocabulary the user meets across the whole entry is **workspace** and **project repo**. Everything else is inference.

- **Owned by:** #29 (first run, now the empty-state Projects list, no wizard).
- **Supersedes:** the R43 "stepped onboarding wizard" framing and the four-noun discovery UI; both are dropped per [[Rennet v3 Resteer 2026-08-09]] items 2 and 4.

### Stage 1: Add a project

Two terse steps, the persistent action that exists forever (not once):

**Step 1, type and path.** A segmented choice, **workspace** (a folder holding several repos) or **project repo** (one repo), one line of explanation each. Then a path picker: a native **Browse** dialog plus a "recent / detected nearby" list Rennet cheaply probes once pointed near a directory. One **Continue**.

**Step 2, worktree config.** Discovery shows what it found as **editable defaults, not questions**: detected repos and worktrees as toggle rows (all on; flip off what you do not want), the primary branch confirmed and editable. One **Confirm**. If nothing is odd, this screen is three rows tall. The old stage-2 discovery-tree visualisation is gone; what survives of it is exactly this toggle list.

- **Owned by:** #37 and the add-a-project flow (workspace/repo type, path picker, worktree toggles).

### Stage 2: Processing: the narrated context dump

Confirm kicks off the **initial context dump** for the project, narrated. A real feed of pipeline events in plain speech ("walked 3 repos, 16 worktrees; read the commit graph, 1,204 commits; mapped open PRs; building the context index, 214 files"), completed lines collapsing into a compact done-ledger so a long dump never becomes a wall, the current line always the bottom line. **It ends by becoming the project:** the final frame morphs into the Project detail header (continuity of object, not a cut), so the dump feels like it *produced* the project.

**What it produces (Rai, 2026-08-09):** the project's **Repo Map**, the baseline context pack that lives in `.rennet` (deterministic ProjectSnapshot + evidence-anchored knowledge layer + primer) and that every later review reads from instead of re-scanning the codebase. It is fed, with a per-diff context pack, to the review agents and the orchestrator. Built by fanned-out subagents with distinct jobs, stitched deterministically where possible and joined up by medium/heavy models for the big-picture rollup. **Stored local-only by default**, keyed by repo identity so every worktree shares it; a team can commit a map for others to discover, and mirroring yours in is a per-project opt-in (R55). The nesting, proactive-update, and net-novel directions are adopted (R54); build tracking in #141-#144.

**MVP note (fresh update 4):** the MVP ships a plain **spinner placeholder** in this slot, over the real narration feed. The delightful animated version (little agents fetching each repo's history, the dump literally drawn) is post-MVP, promoted once the rest of the app is worked out. This is **one narration organ**, reused for stage-3 refresh and review-capture narration; the same component works everywhere the machine works.

- **Owned by:** #54 (live pipeline), #71 (the narrated feed).

### Stage 3: Project detail: the two-zone everyday landing

Click a project and land here: **one scroll, two materially distinct zones, no tabs.** This is the everyday landing per project, and it holds the **two entry doors** into a review.

- **Zone 1, "Yours"** (local worktrees and branches, in **backlight** because they have never left this machine): each row is a branch/worktree with its dirty/ahead-behind state and a small three-dot trajectory indicator reading **captured › reviewed › PR'd**, so a row shows where in the local pipeline it sits. The terminal verbs are stage-dependent: **Review** when unreviewed, **Resume** when a review is in flight, then **Make PR** (the paper ceremony, PR-submission variant) or **Re-steer** (hand the changes back to the coding harness). Yours is a pipeline of things becoming PRs, not a list of git refs.
- **Zone 2, "Team"** (every PR, including your own, in **ink** because it exists in the world): number, title, author, files and diff size, review-state glyphs, CI chip, flag count. Clicking one enters **teammate review mode**. Your own open PRs live here, not in Yours: the dedupe rule is **once a branch has a PR, the PR row wins and the local worktree becomes an annotation on it** (a "checked out locally" glyph on the PR row). One item, one row, no double-listing.

A **filter bar** unifies both zones (search, state chips like needs-you and CI, and two zone chips **Yours n / Team n**). The zone chips double as a **soft switcher**: click one to collapse the other. A resume strip sits above both zones when a review is in flight.

**Open call, flagged in the text:** the exact split mechanism (chips-as-soft-switcher versus something else) is still **open to iteration** per [[Rennet v3 Resteer 2026-08-09]]. Material separation (backlight versus ink) is the settled part; the switcher is the recommendation, not the ruling.

- **Owned by:** #37 (the two-zone project detail), #44 (command palette).

### Stage 4: The review heart: the tall sequence canvas

Clicking a Yours row, a Team PR, or **refresh** opens a review. One engine, two sources (R7): your own working tree (local capture: committed, index, unstaged, untracked) or a teammate's PR (GitHub ingest, local-diff-first, head pinning). Either way an immutable **patchset** (R28) and a review are born, and the **paper is reachable** from the review (top-right Preview), naming what it will become.

The review heart is the **sequence canvas**, the surface Rai kept from the old prototype and asked to see everywhere after a click or a refresh. In v3 it is **tall**: it scrolls the whole changeset with real scroll and **no viewport-fold theatre**; the order rail holds your place.

**Diff/code-view affordances [R45].** Each hunk carries a single **context-labeled button**: it reads **`view test`** on an implementation hunk and **`view implementation`** on a test, with an honest disabled **`no tests`** when nothing references it. **Open-in-editor** deep-links to the exact line (copy disclosure before it opens a materialised ref copy).

**The inline conversation cluster [R46].** Reading is not read-only. On any anchor (a diff line, a dragged range, a chunk header, a conversation fragment) the same universal cluster works: **verbs × anchors**, Comment / Change / Question / Discuss, plus **Approve chunk**. The mark lives at its anchor (Design Doctrine); threads live in the **right margin aligned to their line**, and the composer opens there, so **the diff column is a fixed point that never reflows**. **Ink publishes; backlight (blue) stays local** is rendered inside the cluster, so a private note can never be mistaken for a publish-bound one.

- **Owned by:** #11 (canvas UI), #63 (make code visible: view-test/impl button + open-in-editor), #68 (syntax highlighting), #36 and #109 (the inline conversation cluster).

### Stage 5: Read through the lenses

The sequence canvas is one of several lenses over the same patchset; the fixed-point rule holds across them (the hunk under the cursor never moves on lens rotation), and the totality guarantee is always one keystroke away.

- **Spec (the structured OpenSpec viewer).** Not raw markdown: Rennet knows the artifact shape ahead of time, so it renders the *shape*. A header band, a distilled Why, the Why / What-Changes spine, a **capability grid** (new capabilities add-green, modified neutral), and **requirements and scenarios as structured rows**. Requirements, scenarios, and tasks are **first-class disposition anchors**: the same conversation cluster works on a requirement as on a diff line. **Coverage chips** wire each requirement to its claiming hunks and tests; a requirement with zero hunks renders an honest **`unimplemented`** state. Raw markdown is always one keystroke away.
- **Decisions (purified).** The decisions the *implementer* made, discerned from the spec, the PR body, and the diff, **grouped by theme** (for example "one refill-on-read bucket behind a RateStore interface" or a fail-open posture). Each card is the decision in plain language, **evidence chips** (click to jump), a **reconstructed why** marked as such, and the **alternatives not taken** when the diff or PR body make them discernible. The evidenced / mechanical / contestable **triage taxonomy is dropped**: judging a decision is the reviewer's job, not a pre-chewed verdict's. That classification layer was exactly the mutation Rai flagged.
- **Flagged (NEW lens).** The index of everything the automated review layer produced: **model-council findings and dual-review disagreements**, each with a **severity** (high / medium / low), an **agreement state** (both concur, with vote counts, or the models disagree), and an **anchor**. When the models split, both answers sit side by side **here**, labeled, instead of ambushing you mid-conversation. The flags still render as marks at their anchors on the code surfaces; this lens is the index that jumps to them, never the house that holds them. Flagged repairs Decisions by subtraction: everything machine-opinionated lives here.
- **Noise (NEW lens).** A grouped summary of everything the changeset touches that was judged not to need your attention: formatting, lockfile churn, import reordering, generated output, mechanical renames, comment typos. Most is settled **deterministically** (a formatter / lockfile-path / import-order rule), and each group says which; the ambiguous remainder is judged by an **LLM noise job** and marked as such. Nothing is hidden: noise is **collapsed and dismissible, never dropped**, and a **"not noise?"** control pulls a group back into the review. This is the **totality floor**: the review saw all of it.
- **The symbol inspector (peek-then-pin).** A plain click on a symbol opens a **floating glass peek card** at the symbol (signature, doc comment, first lines, origin path, and an honest tier label: a TypeScript answer says *exact*, a tree-sitter guess says *guess* and lists its candidates when degraded). Actions: open-in-editor, pin, references. **Pinning** docks the card into the **right rail as a mini code browser** (breadcrumb, back/forward) whose navigation stays in the rail, so **the diff never moves**. Never inline, never reflowing. References are sequenced behind the definition peek: definition ships first.

- **Owned by:** #33 (spec canvas), #34 (noise lens), a new **flagged CanvasAngle** issue (ISSUES-B), #35 (blast/other canvases), #23 (LSP) plus the symbol inspector, #62 (approachability).

### Stage 6: Ask the orchestrator

Questions go to the **orchestrator by default**. The ask composer carries one small per-message split, **"ask both models"**, remembered per thread and never sticky globally. When both are asked, the answers arrive as **two labeled cards side by side** (Orchestrator / codex), and you read them yourself: **no synthesis block, ever.** The robotic auto-merge that fired to codex behind your back is gone. If the two disagree, that disagreement is itself something you can ask the orchestrator about; Rennet never manufactures the merge for you.

- **Owned by:** #13 (orchestrator) plus a new **review.ask** protocol issue (ISSUES-B; `mode: orchestrator | both`, default orchestrator, no synthesis variant), #15 (context.ask).

### Stage 7: Dispose = stage into the draft

Every disposition (approve / request-change / comment / question, at any granularity) **is staged the moment it is made** (R36): it lands, visibly, in the **forming destination, which is the editable collation draft canvas** (R40), *not* the paper. There is no separate staging act. The refiner cleans raw notes in the background; the orchestrator is on tap; **withdraw is the unstage** (R37), and editing a staged item is withdraw-and-restage in one gesture.

- **Owned by:** #17 (disposition UI; its staged view is the seed of the collation draft per R37/R40).

### Stage 8: The collation draft canvas

The **forming destination** (R40): a **glass** (working, translucent, yours) canvas whose substrate is the L2 disposition set across every lens. Every disposition collates here into one coherent, still-modifiable working draft of the outbound artifact, one click back to each anchor. You collate, reword (the raw note becomes a **refined** comment; the strikethrough keeps what you actually typed visible), reorder, **merge** and **split** dispositions, and withdraw. **Every staged item carries the inline conversation cluster**, so you can question or discuss a staged chunk before signing. **The orchestrator proposes; you dispose:** it can suggest refinements and accept or dismiss, but it never writes the draft. The mode frames the labels: **own-branch** leans composition-heavy (a **handoff** bundle), **other-PR** leans per-item refinement (a review to post). Same canvas, mode-framed.

- **Owned by:** the collation draft canvas owner issue (R40), #17 (seed), #19 (other-PR refinement), #72 (own-branch composition).

### Stage 9: The paper: sign the verdict

The one solid object in a translucent product, downstream of the draft. **Signing is a phase transition: glass crystallises into paper** (R40). The paper is opaque and **previews exactly what will post, nothing editable** (editing lives on the draft, never here). It carries the **verdict, derived from your dispositions** (for example "2 request-changes, 1 comment → Request changes") and shown with its arithmetic. **The derived verdict is a default, not a lock: you can override it before signing** (Approve / Request changes / Comment), and **the review carries whatever you sign**. Rennet never forces a neutral event; the **human sign in the loop is the safety**, and the sign publishes the real verdict. The action is **hold-to-sign**; nothing posts until you do.

Context decides the variant, never the model of action (one disposition model, two destinations):

- **A teammate's PR** → the paper previews the **review it will post**: every line item in its refined form, hold-to-sign, **one batched review event** (R33). **Publish is all-or-nothing per signing act in v1 (R38)**: to ship a subset, withdraw first on the draft, then sign.
- **Your own branch** → the paper previews the **PR submission** (title/body/draft, zero Git mutation, R33) or the frozen **handoff bundle** handed to a coding harness.

- **Owned by:** #22 (the frozen paper + sign; dark-paper theming), #21 (publish pipeline), #74 (PR title/body drafting), #18 (handoff loop).

### Stage 10: The re-steer / delta loop (own-branch)

A Yours branch can loop back to the coding harness with your requested changes **before it ever becomes a PR** (the **Re-steer** verb on a Yours row). The harness addresses the bundle → a new patchset arrives → Rennet presents **only what moved**. Approvals carry by lineage (byte-identical now, fuzzy matcher later, fail-closed); an agent-authored change is never "already read"; the delta summary narrates what the agent did, including anything beyond your asks. The loop returns to the review surfaces on the successor patchset.

- **Owned by:** #18 (handoff loop), #16 (fuzzy carry), #48 (successor carry rule), #73 (delta summarisation).

## Where the build stands against the journey

The v3 frames show *intent*; the code is behind them, and the honest read (both codex code-reads, recorded in [[Rennet v3 Resteer 2026-08-09]]) is that **more is unbuilt than the aspirational mockups implied**. The middle of the road (the review surfaces) is the most real; the beginning (add-a-project, the narrated processing) and the end (the collation draft, the paper) are the current build targets, alongside three pieces that are catalogue-or-mockup only: the **`review.ask`** protocol, the **decision-extraction producer** (real reviews emit an *empty* decisions lens today, not a mutated one), and the **Flagged** runner / schema / aggregation. The "mutation" Rai feared is **wireframe drift living in the cheap layer, not code rot**: the projectors already match his intent; the producers never landed.

## Standing conventions

**The journey-fit line.** Every UI issue's acceptance criteria must include one sentence stating which stage the work sits in and what the user sees of the destination while using it. An issue that cannot state its journey-fit is describing a widget, not a step on the road.

**Vertical scroll; screens are not one viewport [R44].** A screen may be tall; do not cram a stage into one fold or truncate its content to fit. Vertical scroll is the expected shape; the constraints are the doctrine (glass = chrome, code = opaque, terse chrome, icon economy) and the journey-fit, not a viewport height.

**The execution-mode glyph, on every in-project screen.** The consent banner is dead, along with the "read only" and "nothing touched" chrome — and so is any mode that asks permission before running a model: reviewing code with a model is Rennet's whole job, so it just runs. In its place, one **mode glyph** in the title bar shows the current mode (auto unadorned, read-only with a lock for a retrospective review), defaults to **auto**, and opens a dropdown with a one-line fact each and a single standing disclosure line. Scope is a **global default with a per-project override**, remembered per project. The glyph is present on **every in-project frame**, so the current mode is always visible. (Sending a review out to a forge is a separate external act that stays explicitly confirmed — that is not a model-run gate.)

**No monospace as UI chrome.** Monospace is for actual code only, never as interface texture or decoration; chrome uses the proportional type.

---

*Written 2026-08-07 from the journey synthesis over the prototype UX docs and the live issue queue; the contribution then was the order and the ownership map, not invention. Amended 2026-08-08 (R40): the destination split into the collation draft canvas (editable) and the paper (sign). Resteered 2026-08-09 to the v3 prototype and Rai's wireframe feedback (authority: [[Rennet v3 Resteer 2026-08-09]]): first run is a state of the empty Projects list, not a wizard (the four-noun component and the R43 wizard framing are dropped); add-a-project and the narrated processing open the road; the everyday landing is the two-zone Project detail (Yours in backlight, Team in ink, split mechanism still open to iteration); the review heart is tall with the context-labeled view-test/implementation button and the inline conversation cluster; the lenses are Spec (structured), Decisions (purified, no triage taxonomy), Flagged (new), Noise (new), and the peek-then-pin symbol inspector; questions are orchestrator-only by default with an opt-in ask-both and no synthesis; the paper previews a derived-and-overridable verdict whose human sign is the safety; and the execution-mode glyph (auto default, read-only for retrospective reviews — no ask-to-run-a-model mode) replaces the consent banner on every in-project screen.*
