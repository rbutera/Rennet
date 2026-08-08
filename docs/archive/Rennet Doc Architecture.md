---
tags: [rennet, documentation, architecture]
categories: [reference]
status: active
created: 2026-08-06
updated: 2026-08-07
related: ["[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Navi Handoff]]"]
---

# Rennet Doc Architecture

The map of every document in `docs/`: which role each plays, how they cross-link, and which are historical. Consolidated 2026-08-06 (Rai: turn the docs and issues "into something coherent and complete in the repo"). If you add a document, add it to this map and to the read order in `docs/README.md`.

## The five roles

| Role | Meaning |
|---|---|
| **Canonical** | The current, authoritative statement. Read first; everything points into it. |
| **Authority register** | Append-only or ruling-numbered records that settle conflicts. Never rewritten, only superseded with markers. |
| **Deep spec** | The full design for one subsystem. Authoritative within its scope, subordinate to the registers. |
| **Status ledger** | Live state: what is proven, built, or pending. Updated as facts change. |
| **Historical / research** | Evidence and rationale. Carries an authority notice naming what supersedes it. Never build instructions. |

## The map

| Document | Role | Notes |
|---|---|---|
| [[Rennet Product and Vision]] | **Canonical** | What Rennet is: vision, the four principles, ordering-is-the-product, the full feature set. The one-read entry point. |
| [[Rennet Contracts and Rulings]] | **Authority register** | *Formerly "Rennet Master Plan" (renamed 2026-08-06).* Supersede stack, rulings R1–R39, feature contracts §2.1–§2.5, frozen core, open questions, M0 cut, spikes, the issue-seeded execution pipeline (§7), strip list (§8). Older "Master Plan Rn/§n" citations resolve here; numbering unchanged. |
| [[Code Review Harness App]] | **Authority register** (Decisions) + historical (rest) | The hub. Its **Decisions** section is the append-only ledger of Rai's product decisions and supreme product authority — new Rai decisions continue to be appended there, then reconciled into Contracts and Rulings + Product and Vision. Its narrative sections (Feature Inventory, market check, lens validation) are 2026-08-04 snapshots: historical. |
| [[Rennet Architecture Contracts]] | **Authority register / deep spec** | Frozen engineering contracts: project context + `.rennet`, immutable patchsets, invalidation, persistence, privacy, publication. Wins within that scope. |
| [[Rennet Dependency Standard]] | **Authority register / deep spec** | Wins on dependencies, versions, licensing of packages, toolchain ownership, overlap. |
| [[Rennet Canvas Paradigm]] | **Deep spec** | The interaction model: canvases, L0–L3 layers, four actors, ops, hybrid MCP decision. Adopted 2026-08-06, amended by Contracts and Rulings §2.3. |
| [[Rennet Orchestrator Context Access]] | **Deep spec** | Primer-as-map, `canvasOps@2`, `context.ask`, protocol card, experiments E1–E5. Adopted 2026-08-06, amended by §2.4. Supersedes the fat-primer sketch in Canvas Paradigm §4.3. |
| [[Rennet Comment Refinement Loop]] | **Deep spec** | The raw→refined disposition lifecycle, refiner contract, inline clarification thread, slices. Gates issue #19. |
| [[Rennet Reactive Streams (RxJS)]] | **Deep spec** | The reactive-streams analysis behind R35: RxJS refused at every site, `AsyncIterable` codified at harness ports, the post-commit change feed specified, the reactive discipline adopted as contract language. Rides issues #10/#31 for the feed build. |
| [[Rennet Model Council]] | **Deep spec** | The named model-assignment subsystem (added 2026-08-07): the versioned job catalogue (~24 deterministic + ~21 model-facing + 6 newly named), the three availability-scenario assignment tables, `resolveAssignment()` + resolution order, the live budget gate (fixes bead p0wwp), the resolution-trace ledger, calibration read. Ratified extraction of the DSL/routing plan §5; its §5.4 ladder amended by R39 (cross-harness routing). |
| [[Rennet User Journey]] | **Canonical** (journey) | The ordered eight-stage journey (added 2026-08-07): first run → home → open → capture/live feed → angles → dispose=stage → destination/paper → delta loop. Owns the ordering constraint; each stage maps its owning issues and built-vs-open. Staging semantics ruled as R36–R38. Carries the standing journey-fit acceptance-criteria convention. |
| [[Rennet Design Doctrine]] | **Deep spec** (doctrine, required reading for UI work) | The design register promoted from the prototype docs (added 2026-08-07): three materials (glass/code/paper), colour law (backlight `#85C4DC`, amber, no fourth hue), fixed-point rule, progressive-disclosure floor, never-a-spinner, smooth-and-quick. Prototype docs remain the full reasoning; this is the ratified floor. |
| [[Rennet Navi Handoff]] | **Canonical** (orientation) | Who/what/why, never-do list, the issue-queue pointer, RAI-ONLY actions, working agreement (ship-to-main). The backlog it once carried is archived (below). |
| [[Rennet Backlog Archive]] | **Historical** | The 2026-08-04 147-bead dependency-ordered backlog, verbatim (extracted from the Handoff 2026-08-06). Design rationale only; issues cite its bead numbers (e.g. #16, #27). The GitHub `openspec-seed` issue queue is the live backlog; where they disagree, the issue wins. |
| [[Rennet Evidence Gate Status]] | **Status ledger** | What is proven vs. assumed; spike gates open/closed/blocked. |
| [[Rennet Decision Integration Tasks]] | **Status ledger** | The 2026-08-05 doc-integration checklist; mostly complete. Fold remaining unchecked items into issues, then this can be archived. |
| [[Rennet Local Review MVP]] | **Status ledger** | Implementation record of the merged MVP slice. |
| [[Rennet Spike - Electron 43 node sqlite]], [[Rennet Spike - Event Store and Publish Failure Injection]], [[Rennet Spike - TypeScript LSP Ladder]] | **Status ledger** (verdicts) | Closed spike verdicts. Never edited after closing. |
| [[T3 Code Integration Research]] | **Historical / research** | The adopt-partial analysis + auth trace. Status note in Contracts and Rulings §2.2: own core, mine T3's parts. |
| [[Overnight Harvest Plan]] | **Historical / research** | The 2026-08-05 overnight operational plan; its measurements (e.g. the AGPL-mention census) are dated evidence. |
| The eight **Wingman** plans (Architecture, Harness Adapter Protocol, GitHub Integration, Distribution and Licensing, Repo Bootstrap, Settings and Setup, LSP Integration, Surfacing DSL and Model Routing) + [[Wingman Spike – Pierre Diff Virtualization]] + [[Wingman Branding Plan]] | **Historical / research** | Each carries an authority notice naming what supersedes its recipes. Retain the Wingman filename prefix — it is itself the marker that these predate the name. Do not rename them. |
| `reviews/` (codex critique + adjudication) | **Historical / research** | The two ratified critiques, cited by rulings. |
| `research/` (market, stack, pairing, lens validation) | **Historical / research** | Discovery-day evidence. |
| [[Code Review App Branding Questions]], [[Code Review App Design Directions]], [[Code Review App UX Concepts]], [[Code Review App UX Research]] | **Historical / research** | Discovery and naming history; authority notices present. |
| `docs/README.md` | Index | The read order. Regenerated 2026-08-06. |
| `CLAUDE.md` (repo root) | Agent contract | Points at the doc set; updated with the rename. |

## Cross-link rules

1. **Everything points into [[Rennet Product and Vision]]** for what/why, and into [[Rennet Contracts and Rulings]] for any ruling. Deep specs cite rulings by number (R8, OQ17) — those ids are stable across the rename.
2. **New Rai decisions** are appended to the hub's Decisions section (the ledger), then reconciled: a ruling/supersession in Contracts and Rulings, narrative in Product and Vision, and a strip-list entry if older text is invalidated.
3. **Supersession is additive, never destructive.** Old text is struck or quoted with a dated marker; nothing is silently deleted. Historical docs get authority notices, not rewrites.
4. **Wikilinks resolve by basename** — a rename is a repo-wide link rewrite (this consolidation did exactly one: Master Plan → Contracts and Rulings). Avoid renames of historical docs.
5. **Work items live on GitHub**, not in docs. A doc may cite an issue (`#19`); an issue cites docs by name + §. Docs carry decisions and designs; issues carry work.

## Known staleness and reconciliation queue (2026-08-06)

- **Issue #27** owns the remaining salience/danger-ordering strip pass across the Backlog Archive (beads 76/104/105) and the DSL plan §2.5 D11 — the strip list is Contracts and Rulings §8.
- **[[Rennet Evidence Gate Status]]** rows marked "Blocked (possible spend)" for Claude CLI probes predate the SDK/subscription decision (R2 reversal): a `claude -p` probe on the user's own subscription may no longer be spend-shaped. **Reconcile, do not silently flip** — the codex half genuinely may cost. One-line review against R2 needed.
- **[[Rennet Decision Integration Tasks]]** has two unchecked items (prototype validation with 5–8 engineers; remaining evidence gates). Fold into issues, then archive the doc.
- **The hub's Feature Inventory (2026-08-04)** predates the canvas paradigm, both loops, and the orchestrator design. It is historical; do not "fix" it — Product and Vision §4 is the current inventory.
- **`packages/ui` hardcoded stale angle set** (Logic/Security/Tests/… placeholders) is a code residue, not a doc one — a rename to lens set v4 rides the canvas UI issue (#11).
