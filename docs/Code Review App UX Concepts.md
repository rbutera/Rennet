---
categories: [project]
tags:
  - code-reviews
  - ux
  - design
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Code Review App UX Concepts

> [!IMPORTANT] Exploration, not current specification
> Use [[Rennet Master Plan]] and [[Rennet Architecture Contracts]] for implementation. Current product is Rennet with six angles and immutable occurrences/patchsets. Subtraction and route handoff are removed. Local edits create a new draft patchset, mark affected analysis invalid or potentially invalid, and offer explicit affected-only regeneration; the live tree never silently mutates an active review.

Round-two discovery for [[Code Review Harness App]]: interaction concepts for the decisions made 2026-08-04 (multi-lens decomposition, diff chat, mobile as remote control, zero-config North Star). Builds on [[Code Review App UX Research]]. Thinking on paper, not specification.

Framing anchor throughout: the positioning is accountability and exposure ("you stopped writing the code, you still have to answer for it"). Every interaction below is tested against that: does it increase the reviewer's honest command of the changeset, or does it help them fake it?

---

## A. The lens interaction model

### The core question: what IS a lens, mechanically?

Four candidate mental models, one recommendation.

- **Lens as tab**: five parallel workspaces, each with its own grouping of the diff. Rejected. Tabs mean five copies of the changeset, five scroll positions, five partial coverage states, and the reviewer doing mental joins between them. This is how you lose your place five times instead of once.
- **Lens as filter**: one flat hunk list, lenses hide and show subsets. Rejected as the primary model. Filters answer "show me less"; chapters and decision points answer "show me differently ordered and differently annotated". A filter can't express sequence.
- **Lens as axis**: a matrix view (chapters x risk). Rejected. Nobody reviews code in a pivot table.
- **Lens as projection over one shared model**: RECOMMENDED. There is exactly one underlying object: the hunk graph (every hunk of the changeset, versioned Gerrit-style across pushes, each carrying its read/coverage state and its annotations). A lens is a projection of that graph: a way of ordering, grouping, and annotating the same hunks. The email analogy is Gmail labels versus folders: a hunk has many labels (chapter 3, high blast radius, decision point, test evidence for chapter 2), it is never IN a lens the way a file is in a folder. Photos apps are the other precedent: one library, projected as Albums, People, Places, Memories; nobody worries that viewing a photo in People "uses it up" for Albums.

### Not all lenses are the same kind of thing

Trying to make all 4-5 lenses the same UI component would be a mistake. The confirmed and candidate lenses fall into three interaction species:

1. **Sequence lenses** (chapters): produce a reading ORDER. Rendered as the primary rail: a chapter list with progress, next/previous navigation, the dependency-ordered narrative. Only one sequence lens is needed; it is the default way to traverse.
2. **Queue lenses** (decision points, findings): produce a WORKLIST of discrete items to discharge. Rendered as a drainable queue, each item deep-linking into the diff at its anchor. A queue item is not "read", it is "decided" or "dismissed"; the verb differs from reading.
3. **Overlay lenses** (risk/blast-radius, familiarity, claims-vs-evidence): produce ANNOTATION on hunks: scores, badges, gutter heat. Rendered as toggleable layers over whatever view you are in, plus a sortable index ("show me the changeset ranked by this lens") for hypothesis-driven entry.

This taxonomy answers "is a lens a tab, a projection, a filter, or an axis": it is a projection, and its rendering depends on its species. The chapters rail, the decision queue, and the risk overlay can all be on screen at once without competing, because they occupy different UI slots (left rail, right panel, gutter).

### Moving between lenses without losing your place: the fixed-point rule

The invariant: **the hunk under the cursor is the fixed point; the lens rotates around it.** Switching lens never navigates away. If I am reading hunk H in chapter 3 and I switch to the risk lens, H stays exactly where it is on screen; what changes is the frame: the left rail now shows H's position in the risk ranking, the surrounding context reorganizes, the gutter heat lights up. Switching back restores the chapter frame, again centred on H.

Practical consequences:

- Lens switching is a keyboard rotation (one key cycles, or number keys jump: 1 chapters, 2 decisions, 3 risk...), cheap enough to flick between mid-thought, like toggling blame in an editor.
- Every lens must be able to answer "where is this hunk in MY projection?" instantly. That is a data-model requirement (the hub note already makes lenses first-class in core): every lens is a total function over hunks, no hunk unmapped. This is also the residue check: a hunk no lens can place is a loud error state, not a silent omission.
- Breadcrumb per lens: each lens remembers its own last position, so "return to the chapters rail" resumes the narrative where you left it even after a detour through the risk index.

### Coverage under overlapping lenses: two layers, never double-counted

Coverage must not be per-lens, or a 5-lens product asks the reviewer to read everything five times, which is absurd and kills the "so much easier" feeling. But pure hunk-level coverage lets reading discharge obligations that need more than reading. The resolution is a two-layer model:

- **Layer 1: read state, universal.** "Read" is a property of the hunk-version, set once, visible in every lens. Reading a hunk while traversing chapters marks it read in the risk lens too. One changeset, one reading effort.
- **Layer 2: obligations, lens-specific.** Some lenses attach obligations that reading does not discharge. A decision point requires an explicit decision (accept / reject / raise with author), recorded with a note. A high-risk hunk may require an explicit acknowledgement ("I looked at this AS a risk, not just as prose in chapter 3"). Obligations are few by design; they are the accountability layer, and each one is a recordable act with provenance.

"Done" is then composable and honest: the changeset is reviewed when all hunks are read AND all obligations are discharged. A lens is "complete" when the hunks it surfaces are read and its own obligations are done. The coverage map (a small always-visible mosaic of the hunk graph, coloured by read/obligation state) is the same map in every lens; only its arrangement changes with the projection.

Edge rule worth deciding early: reading a hunk inside a collapsed "mechanical" group (skimmed as a summary row, never expanded) should count as SKIMMED, not READ, and the coverage map should show the difference. Accountability positioning demands the distinction exist; kindness demands skimming mechanical bulk be legitimate and guilt-free.

### What prior art teaches, and where this is genuinely new

- [[Gerrit]]: coverage state must attach to hunk-VERSIONS, so a force-push re-opens only what changed, per lens for free (since lenses project the same versioned hunks). Gerrit also proves per-file "reviewed" checkmarks work as a habit; we generalize the checkmark to the hunk and derive everything else.
- [[Graphite]]: a forced sequence works, but only as ONE path. Their stack is effectively a single sequence lens constructed at authoring time; our chapters lens is the same UX constructed post hoc. Their inbox teaches that the queue species of lens is already familiar to reviewers.
- [[CodeRabbit]]: Change Stack proves demand for the grouping, and proves that a grouping delivered OUTSIDE the diff surface (as a comment) stays prose. The lesson is that the lens must BE the navigation, which is exactly the projection model.
- [[GitButler]]: drag-a-hunk-between-lanes is the correction gesture for mis-grouping, and it generalizes: dragging a hunk to a different chapter, or flagging "this should be a decision point", is how the human corrects a lens. Corrections are recorded and feed back to the harness.
- **No prior art exists** for: concurrent projections with shared coverage over one changeset; the fixed-point lens rotation; lens-specific obligations layered over universal read state. Photo libraries and email labels are the closest analogies and neither carries review accountability. This is the novel interaction claim of the product, and it is worth prototyping first because it is also the riskiest.

### Proposed candidate lenses (2-3 to fill the set)

Confirmed: **chapters** (sequence), **decision points** (queue). Candidates, in recommended priority order:

1. **Blast radius** (overlay; working label, "risk" is blander, "hotspots" is taken by the profiling world). Ranks hunks by potential damage: security surfaces (auth, input boundaries, secrets, injection sinks), irreversible operations (migrations, deletions, external side effects), public API and contract changes, dependency fan-in (how much of the codebase calls this). Rationale: the SmartBear/Cisco attention budget is finite; this lens is HOW the product "surfaces the right decisions", and it cross-checks the chapters lens (a high-blast hunk sitting in a mechanical chapter flares as lens disagreement, which is the strongest available answer to the mis-filed-risky-hunk problem). Strong research support, harness-computable, valuable from day one. TAKE.
2. **Claims and evidence** (overlay/pairing; the tests-vs-implementation lens, reframed). Pairs every behavioural claim in the changeset with its evidence: this logic change with its test delta, this bugfix with the regression test, this refactor with the proof nothing changed. Surfaces unpaired claims (changed behaviour, no test touched) and unpaired evidence (tests changed, behaviour supposedly identical: a classic LLM tell). Rationale: LLM-generated PRs are precisely where tests exist but test nothing; no tool presents claim-evidence pairing as a review surface; it converts "did you check the tests" from a vague virtue into a drainable list. TAKE.
3. **Familiarity** (historical candidate overlay). Colours the changeset by the reviewer's own history with the code. It is not in the ratified six-angle set; preserve the research for a later optional overlay rather than treating it as a seventh angle.
4. **Weight** (mechanical vs substantive) considered and folded IN: rather than a standalone lens, mechanical bulk (renames, lockfiles, generated code, formatting) should be a property the chapters lens uses to build appendix chapters that arrive pre-collapsed with a summary row. A "lens" whose entire content is "ignore this" is not worth a slot in the rotation; it is a behaviour of the sequence.
5. **Security surface** considered and folded into blast radius: as a filter preset on that lens rather than a fifth rotation stop. Keeps the rotation at four to five stops without ceremony.

Recommended v1 set: **chapters, decision points, blast radius, claims and evidence** (four), with **familiarity** as the designed-for fifth. Four is enough to prove the model; the fixed-point rotation gets crowded past five.

### Design tensions #1 and #2 under multi-lens

- **#1 (trust the grouping vs verify coverage)** changes shape favourably. With one grouping, a mis-filed hunk is invisible. With concurrent lenses, every hunk is projected 4-5 independent ways, and the lenses audit each other: the residue check guarantees no hunk escapes ALL lenses, and lens disagreement (mechanical chapter + high blast radius; no decision point + unpaired claim) is a computable flare. The trust question narrows from "is the grouping right" to "is the flare logic right", which is a smaller, testable surface. Remaining UX work: how a flare looks without becoming another notification stream.
- **#2 (rail vs agency)** is substantially resolved. Chapters is the default rail for reviewers who want to be carried; the overlay and queue lenses are legitimate hypothesis-driven entry points (start from the blast-radius ranking, start from the decision queue) for seniors who resent rails. Because read state is path-independent, every path drains the same coverage map, so agency costs nothing in honesty. The rail is a route, not a cage; the map is the contract.

---

## B. Diff chat placement

### Placement: anchored threads in a margin panel, palette for the unanchored case

Three placements considered:

- **Inline-expanding chat bubbles** (chat opens inside the diff between lines): rejected as primary. It destroys the reading rhythm the chapters lens exists to create, reflows the diff (poison for a 5k-line virtualized surface), and makes long conversations fight the code for vertical space.
- **Detached side panel** (one global chat, Cursor-style): rejected as primary. A chat that is "about the PR" in general reproduces the wall-of-prose problem; answers arrive divorced from the code they discuss, which is the exact failure CodeRabbit's comment-walkthrough has.
- **Anchored threads, presented in a right-hand conversation panel**: RECOMMENDED. Select a range, a hunk, a file, or a chapter (or nothing, for changeset scope) and hit one key. A thread opens in the right panel, carrying an anchor chip (file:lines, or "chapter 3") that stays pinned as you type. The diff gains a small margin marker where threads exist, like review comments, and clicking either side focuses both. Threads are review-state objects: they persist across sessions and pushes (anchored to hunk-versions like everything else), and they are visible from every lens because they hang off hunks, not views.

The command palette handles the unanchored and navigational cases: "ask about this changeset", "why does chapter 4 exist", jump-to-thread. Keyboard grammar: select, key, type, Enter; hands never leave home row. Answers stream into the panel, never into the diff.

### The harness switcher without a config surface

The switcher is a **composer chip, not a settings page**. On each thread's input box sits a small chip showing who will answer (Claude Code / codex / oh-my-pi), populated ONLY by auto-detected harnesses (zero-config North Star: no add-harness ceremony here, detection already happened at onboarding). Defaults: the harness that produced the current analysis answers by default; a thread remembers its harness; switching is per-message via the chip or palette.

Two affordances stop it becoming config:

- **"Second opinion"** as an action on any answer: re-ask the same thread with a different harness, rendering the answers side by side in the thread. This is harness disagreement (open question Q12) surfacing organically inside chat before it is a headline feature: when two harnesses disagree about a hunk, that thread is itself review signal.
- No per-harness options, models, or temperatures in the chat surface. The chip is a name, nothing more. Power configuration lives with the BYOK power path, elsewhere.

### Chat answers and findings: promotion, with provenance, behind the gate

Chat is **private workspace by default**: nothing said in chat touches GitHub. But answers are drafts in the draft-then-approve economy, so any answer (or a selected excerpt of one) can be PROMOTED:

- **Promote to finding**: enters the impact-ranked finding queue, subject to the same rubric/severity discipline as harness-generated findings, marked with provenance ("from chat, codex, prompted by you").
- **Promote to draft comment**: becomes a draft GitHub review comment at the thread's anchor, editable, sent only when the review is submitted through the normal gate. The reviewer's own words can replace or wrap the LLM text; provenance is kept locally, not posted.
- **Promote into PR preview**: attaches an explicitly selected local note to the author-side PR title/body preview. It does not create a shared route and does not publish without a separate explicit GitHub action.

The inverse also matters: a finding can be demoted INTO a chat thread ("discuss this finding"), so triage and conversation are one fabric. One rule holds the whole surface together: **anchored objects (threads, findings, comments, decisions) are the same species**, differing only in status, and status changes are explicit human acts.

---

## C. Mobile remote-control UX

Architecture (decided): desktop is the server and does all analysis; the phone is a mobile-first presenter and proxies LLM chat through the desktop. Paid app, no cloud backend.

### What the phone shows while the desktop is generating

Not a spinner. The harness's decomposition run is itself narratable, and the phone should show it as a **live narrative feed**: "reading the changeset... 214 hunks... finding the chapter structure... chapter 3 looks like the risky one... 2 decision points so far". Each line becomes tappable as the corresponding artifact lands. Three reasons: it makes desktop-as-server legible (you can SEE your machine working, which is the local-first story made visceral); it converts wait time into a head start (by the time generation finishes you already know the shape); and it is honest about what the LLM did, which the accountability positioning needs. If generation is long, the feed degrades gracefully into a progress summary you can leave and return to, with a push notification when the breakdown is ready.

### The pairing moment (and Q16)

Pairing is a one-time trust ceremony and should feel like one: **desktop shows a QR code, phone scans it, and the phone lands INSIDE the current review**, not on a settings screen. The QR carries the pairing secret plus enough state reference that the first thing the phone renders is the changeset you were just looking at on the desktop: the same chapter, the same position. "Point your phone at your review and your review is in your hand" is a demo-able signature moment and the correct first impression for a remote control: it controls something you can see.

On Q16, the decision is now explicit: local review state does not automatically cross into GitHub. The repeated signature gesture is inspecting the exact PR submission or review preview, then invoking a separate explicit mutation. Pairing remains a setup gesture and mobile remains later.

Transport (design open, noting constraints only): same-LAN discovery (mDNS) for the common case, with an optional user-supplied tunnel (Tailscale-shaped) for remote use. Anything that requires our cloud in the middle contradicts the decided architecture and the procurement story.

### When the desktop is asleep or offline

The phone holds a **cached snapshot** of the last sync: narratives, chapter summaries, findings, decision queue, coverage map, thread history. The rule set:

- **Read verbs survive offline**: read narratives, browse chapters and summaries, re-read threads, inspect the coverage map. This is most of the "review on the train" value and costs nothing.
- **Reversible write verbs go to an outbox**: dismiss findings, draft replies, mark decisions provisionally, queue a "start analyzing PR #431" instruction. The outbox syncs on reconnect, with conflicts resolved in the desktop's favour and surfaced, never silently dropped.
- **Irreversible verbs require a live desktop and a SHA bind**: approval above all. An approval queued offline against a PR that receives another push before sync is exactly the accountability failure the product exists to prevent. Approve is disabled offline, with the reason stated plainly ("desktop unreachable; approval binds to the exact version you reviewed"). This limitation is not apologized for; it is the trust model, visible.
- Desktop wake: where the platform allows, the phone can request wake (Wake-on-LAN on the same network); otherwise the UI states the desktop is asleep and what will resume when it returns. Never pretend liveness.

### Which researched phone verbs survive the remote-control architecture

From [[Code Review App UX Research]] section 5, re-tested against the architecture:

| Verb | Survives? | Mode |
|---|---|---|
| Read narratives and chapter summaries | Yes, strengthened | Cached, offline-capable |
| Triage findings (dismiss/escalate) | Yes | Outbox |
| Reply to threads | Yes | Outbox (drafts), live for send-to-GitHub |
| Approve small pre-chunked groups | Yes, constrained | Live only, SHA-bound |
| Nudge/redirect the harness | Yes | Live only (harness runs on desktop) |
| Diff chat | Yes | Live only, proxied through desktop |
| NEW: prep-ahead | Added | Outbox/live: tell the desktop to start analyzing a PR so the breakdown is waiting when you sit down. The remote-control architecture makes this the most remote-control verb of all, and it feeds the "I never review without this" feeling: the review is pre-chewed before you reach the desk |

The general principle: the phone is for the layer ABOVE the diff (narratives, queues, decisions, conversation) plus command of the machine that owns the diff. Sustained diff reading remains a desktop act, by design, and the product should say so without embarrassment.

---

## D. The eight design tensions, revisited

Status against the 2026-08-04 decisions:

1. **Trust the grouping vs verify coverage: CHANGED SHAPE, mostly answered.** Residue check is in the feature inventory; multi-lens adds cross-lens auditing (lens disagreement flares) which is a structurally better answer than any single-grouping fix. Remaining: flare presentation without notification fatigue; skimmed-vs-read distinction for collapsed mechanical groups.
2. **Rail vs agency: RESOLVED in principle by multi-lens.** Chapters is the default route, queue/overlay lenses are legitimate entry points, path-independent read state makes any path honest. Remaining detail: lens-complete semantics and the coverage map design.
3. **Where review state lives: RESOLVED for desktop.** Rennet owns immutable patchsets, occurrences, events, and private analysis in application storage; durable project context lives in `.rennet/`. GitHub receives only an explicitly signed projection. Mobile transport remains later.
4. **Summary-first vs diff-first: OPEN, and sharpened.** The accountability positioning raises the stakes: approving from prose is now the villain in our own story. Candidate mechanism from this note: read vs skimmed states, obligations that reading cannot discharge, and diff exposure required before a chapter's read state completes. Pace surveillance remains genuinely unresolved (exposure meter for yourself vs surveillance feel).
5. **Finding volume vs false-positive budget: LARGELY RESOLVED by decisions.** Rubric lift, verifier cull, severity floors, sticky dismissal are all in the inventory. Remaining: default knob positions and who owns them per repo.
6. **Approve button blast radius: RESOLVED in principle.** Coverage remains self-visible and private. The publish sheet shows exactly what will travel; pace/read-state never does. Submission remains SHA-bound and explicit.
7. **Native purity vs iteration speed: RESOLVED.** Electron with portable core and commodity shell, Tauri as a realistic port, performance bar stated. Remaining: Pierre rendering spike, which is now an engineering question, not a design tension.
8. **Live review vs settled review: RESOLVED.** Each local capture or remote-head update creates a new immutable patchset. Exact unaffected analysis may remain current; directly affected analysis becomes invalid, related analysis potentially invalid, and model-backed regeneration is explicit. Prior analysis stays visible until replacement succeeds.

Net: 2 resolved, 3 largely or partially resolved, 2 changed shape with clear recommendations, 2 genuinely open (#4 summary-vs-diff integrity mechanics, #8 live-vs-settled state model). Both open ones are state-model questions, which argues for settling them before the first engineering spike rather than after.
