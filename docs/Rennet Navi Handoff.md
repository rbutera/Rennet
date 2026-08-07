---
tags: [rennet, plans, handoffs]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-06
related: ["[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Evidence Gate Status]]", "[[Rennet Backlog Archive]]"]
---

# Rennet Navi Handoff

Navi: this is your orientation for **Rennet**, Rai's personal product. Everything you need to start is here or one link away. [[Rennet Product and Vision]] is what the product is; [[Rennet Contracts and Rulings]] is the authority register (rulings R1–R39, the frozen core, the execution pipeline); [[Rennet Architecture Contracts]] is authoritative for project context, immutable patchsets, invalidation/regeneration, persistence, privacy, and publication. Spike state lives in [[Rennet Evidence Gate Status]].

> [!NOTE] Reworked 2026-08-06 (docs consolidation)
> The 2026-08-06 decisions (MIT throughout; the Claude Agent SDK adopted; roll-up/zoom/lenses as the purpose; decisions never capped; action-defined read state; the handoff loop; the comment-refinement loop; canvas paradigm + orchestrator context access adopted; grouping hard-baked; logical agent-owned ordering; ship-to-main) are now **integrated into the current doc set** rather than flagged as deltas here. The numbered 147-bead backlog this document used to carry is superseded by the **GitHub issue queue** (§3) and preserved verbatim in [[Rennet Backlog Archive]].

## 0. Current implementation checkpoint (2026-08-06)

Merged to `main`: the **local-review MVP** (local immutable Git capture, append-only SQLite review state, action-defined read progress, conservative invalidation, explicit regeneration, typed IPC, sandboxed Electron shell, Forge packaging — read [[Rennet Local Review MVP]]), the **disposition model slice 1** (action-defined read-state + conservative carry), and the **harness adapter protocol + Claude adapter slice 1** (Agent SDK integration, issue #5 closed). Production Nx projects exist for `types`, `protocol`, `core`, `adapters`, `ui`, and `desktop`; the full gate (`pnpm check`) is the bar for every push.

Do not mistake this for the full review harness. Generated angles, RSP documents, canvases, the orchestrator, lineage, LSP, GitHub ingestion/publication, physical purge, signing, updates, and releases remain unimplemented — they are the issue queue (§3).

## 1. Who / what / why

**What it is.** Rennet is an MIT-licensed, local-first Electron desktop **code review harness**: it points the coding harnesses already on the user's machine (Claude Code first; codex, omp later) at a changeset, decomposes it into sub-400-LOC chunks read through **six angles** — **spec, the sequence, decisions, claims-and-evidence, blast radius, noise** — keeps review state that survives a force-push, and lands results as normal GitHub PR reviews or as a batched handoff to a coding agent. LLMs propose structure via a validated document format (the RSP DSL); the human disposes. Zero-config is the North Star; BYOK; no Rennet backend; no telemetry. Selected context may leave the machine through the user's chosen harness/provider and is disclosed per run. Both review modes are product scope. The full narrative, principles, and feature set: [[Rennet Product and Vision]].

**Whose it is.** Rai's personal product. **NOT the enterprise client work. Never use the enterprise client's time, resources, or repos for development, fixtures, calibration, or model-backed dogfood without explicit written approval.** Client mode never mutates the source checkout or its Git metadata. Rai is sole copyright holder.

**Where truth lives.** In order of authority:
1. [[Rennet Contracts and Rulings]] — the authority register. Its §2 conflict rulings (R1–R39) override anything in the plans. Its §3 frozen list is what you may never change without asking Rai. Its §7 is how work gets picked and shipped.
2. [[Rennet Architecture Contracts]] — authoritative within its named scope.
3. [[Rennet Canvas Paradigm]] + [[Rennet Orchestrator Context Access]] — authoritative for the interaction model and orchestrator context architecture (adopted 2026-08-06, as amended by Contracts and Rulings §2.3–§2.4).
4. [[Rennet Dependency Standard]] — authoritative for package selection, versions, licensing, toolchain ownership, and overlap.
5. [[Code Review Harness App]] — the hub; its Decisions section is the append-only ledger of Rai's product decisions and supreme product authority.
6. The eight historical plans: [[Wingman Architecture Plan]], [[Wingman Harness Adapter Protocol]], [[Wingman GitHub Integration Plan]], [[Wingman Distribution and Licensing Plan]], [[Wingman Repo Bootstrap Plan]], [[Wingman Settings and Setup Plan]], [[Wingman LSP Integration Plan]], [[Wingman Surfacing DSL and Model Routing Plan]] — plus [[reviews/wingman-architecture-codex-critique]], [[reviews/wingman-adapter-licensing-codex-adjudication]], [[Wingman Spike – Pierre Diff Virtualization]], [[Wingman Branding Plan]].

**Ratified essentials you must not lose** (all frozen; detail in Contracts and Rulings §1/§3 and Product and Vision §4):
- **Six angles, lens set v4.** Spec is the 0th angle (committed Kiro/OpenSpec/superpowers spec + PR body + ticket; derived-and-marked when absent; the only angle that exists on a zero-hunk changeset). Noise is the floor: the totality/residue guarantee as a surface, with **verified** (deterministic checkers are the ONLY admission authority) and **suspected** (LLM-proposed, visually distinct, skim-required) tiers; the LLM's three roles over noise are narrator, pattern-proposer, anomaly-spotter; one deviating line ejects a hunk from verified noise. Subtraction is retired as a surface; its content lives in `finding.ruleFamily` + noise categories with the propose-deletion affordance on the finding.
- **Decisions angle = the decision LOG.** Everything the author(-agent) decided, each with reconstructed WHY marked as reconstructed; disposition triage **evidenced / mechanical / contestable**. ⛔ **Decisions are NEVER capped or truncated** (a cap can hide the one decision you must answer for). Contestable items are **rolled up into cohorts, in logical comprehension order (agent-produced over the deterministic DAG baseline), and collapsible**: every decision stays reachable, and the roll-up is what makes the set digestible. Ordering is never salience/danger/blast-radius.
- **The four product principles** (aggressive roll-up default; approve at any granularity; free zoom; smooth-and-quick) and **the two loops** (review→agent handoff, Contracts and Rulings §2.1; comment-refinement, §2.5 + [[Rennet Comment Refinement Loop]]).
- **The canvas contract.** Five canvases + blast-radius overlay; L0–L3 layers; **L2 (dispositions) is user-sovereign — no agent writes it**; the actor partition is structural, never prompt-enforced. [[Rennet Canvas Paradigm]].
- **Read state is action-defined** (approve / request-change / ask-question; never scroll/dwell). Read state never auto-carries; ambiguity fails closed.
- **Impl↔tests toggle** on any diff: deterministic mapping first, LLM fills residual marked as inferred; "no tests reference this" is an honest first-class state feeding blast radius.
- **Publish-as-preview, context-dependent.** Own unpushed branch / own PR → the paper sheet previews the **PR submission**; someone else's PR → it previews the **review it will post**, every line item, with the degradation ledger. What posts is the **refined** form of each comment. Route handoff is DEAD; the sheet always renders the actual outbound artifact.
- **LSP**: inline definition chunks below the line (opaque code body, glass header, tier badge, breadcrumb cap 3), degraded-result detector + positive-control readiness probe load-bearing, definitions are context never coverage; **open-in-editor** above every diff with copy disclosure before the click.
- **Settings + instruction layer.** Eight-layer ladder (global → workspace → repo → changeset; personal vs shareable; provenance is the return type; repo files untrusted behind the trust gate; context and guidance read at base ref for others' PRs). Versioned base instructions in `packages/instructions`; user guidance via `instructions.*` keys with `append` merge (R12); assembled prompt always inspectable; the contract is not configurable, the voice is; shared layers may never raise spend.
- **Project context + immutable review state.** Durable config, deterministic default-branch snapshots, and evidence-backed learned knowledge live under `.rennet/`; staging/materialisations/review state live in app-owned storage. Every review targets an immutable patchset. Local edits and remote updates classify old analysis as current, invalid, or potentially invalid; regeneration is explicit. [[Rennet Architecture Contracts]] is the complete contract.
- **DSL + model-tier routing.** JSON documents against versioned schemas in `packages/protocol`; agents never mint identity; quotes verified byte-for-byte; validator is the gate; deterministic/light/heavy routing with the <15s / <5-invocation budget as a mechanical CI-tested gate.
- **Glass design system.** Glass is chrome; code is opaque; **paper is what leaves the machine**; backlight blue (#85C4DC) marks private-to-reviewer only; amber = blast radius/disagreement; no fourth hue; ambient-chat doctrine (threads anchor to reviewable hunks).
- **Licensing: MIT throughout, one licence for every package.** One top-level `LICENSE` (MIT, © 2026 Rai Butera) plus a `NOTICE` for vendored third-party content. The `protocol`/`types` import-nothing rule survives as an ARCHITECTURAL boundary (a mobile or third-party client is a peer of the renderer).
- **Name: Rennet; private monorepo.** Source lives at `/Users/rai/dev/rennet` and `github.com/rbutera/rennet`. `@rennet/*` workspace package names allowed locally. Public GitHub organisation, npm scope, domains, socials, and releases remain RAI-ONLY (§4).

## 2. Never-do list (absolute)

1. **No outside contributions.** No drive-by PR merges, ever, before the contribution policy (R22) lands AND Rai deliberately opens contributions.
2. **No public registrations, publishing, or announcing.** Normal commits and pushes to the approved private `rbutera/rennet` remote are allowed. Making it public, transferring it to an organisation, or creating npm/domain/social/App Store/release surfaces remains RAI-ONLY and needs explicit approval.
3. **Harness adapter boundaries.** The Claude adapter uses `@anthropic-ai/claude-agent-sdk`, spawning the user's **own installed** `claude` (subscription OAuth). ⭐ Still frozen: **never bundle a harness binary of our own, and never read a credential.** Strip the SDK's bundled per-platform executables at packaging; assert `apiKeySource === 'oauth'` and warn if a metered key ever takes over.
4. **Gates run the FULL suite before every push.** Never `--changed`, never `-t`, never `--bail`, never `git push --no-verify`. If the suite is slow, that's an issue to make it fast.
5. **Scoped pkill case law.** Never a bare `pkill`/`kill` by name. Kill only processes you can prove are yours: PIDs you recorded at spawn, or your own env marker. Same for worktree pruning: only rennet-namespaced entries.
6. **Never bare `FileDiff`/`PatchDiff`.** `CodeView` only — virtualization is opt-in and silently absent otherwise (measured: 97,139 nodes, 493ms frame).
7. **Never the enterprise client's resources** (see §1). Never commit screenshots or client data anywhere.
8. **No AI attribution** trailers anywhere in this repo. Rai is sole author.
9. **No auto-approve, no auto-comment, nothing another human sees without the human gate.** Product rule and repo rule.
10. **Frozen core (Contracts and Rulings §3) is not yours to change.** Escalate.

## 3. The backlog is the GitHub issue queue

**The backlog lives on GitHub, not in this document.** Every implementable slice is an issue on `rbutera/rennet` labelled **`openspec-seed`**, with a priority label (`P0`–`P3`), explicit `Depends on: #N` lines, and `blocked` where a dependency is unsatisfiable. Each issue is a self-contained seed for an openspec proposal: what to build, the governing decisions, acceptance criteria, dependencies.

```
gh issue list -R rbutera/rennet --label openspec-seed --state open
```

**How to work it** (the full pipeline is [[Rennet Contracts and Rulings]] §7): pick the highest-priority unblocked issue whose dependencies are closed → `/opsx:propose` seeded from the issue body → implement with `/wave` → full gate green → **commit directly to main** → close the issue with commit SHAs, what was verified, and "What I could not verify:". New scope discovered mid-slice becomes a **new issue**, never scope creep. Spike-shaped issues produce verdict docs, never merged production code.

**The old 147-bead backlog** (2026-08-04, dependency-ordered, sections A–L) is preserved verbatim in [[Rennet Backlog Archive]]. It remains useful as design rationale — several issues cite its bead numbers (e.g. beads 76/104/105 in issue #27) — but it is **not** the work queue and its PR-per-bead workflow is superseded. When an archive bead and an issue disagree, the issue wins.

## 4. RAI-ONLY actions (never yours; nag gently, never do)

1. **Register `rennet.dev` + `rennet.app`** (~$20–25 first year; hand-check the premium tier at Porkbun/Cloudflare first — RDAP does not expose it; avoid Namecheap). P0 for anything public. [[Wingman Branding Plan]] §3.
2. **Before going public, decide whether to claim GitHub org `rennet-dev` and transfer the private `rbutera/rennet` repository.** The personal private working remote already exists. Install `dcoapp/app` and approve branch protection only when the contribution workflow is being opened.
3. **Hand-check and claim npm scope `@rennet` + unscoped `rennet`** while signed in (registry 404 is not proof for org scopes; npmjs 403s programmatic checks).
4. **Claim `@rennetdev` on X; `@rennet.dev` on Bluesky** via domain verification (both bare handles are taken).
5. **Written Anthropic answer on CLI invocation terms.** Anthropic's credential policy says third-party products may not route Free/Pro/Max credentials on behalf of users; Rennet invokes the user's own installed CLI and never touches credentials, but the pattern is close enough to need a written answer **before public release**. [[reviews/wingman-adapter-licensing-codex-adjudication]].
6. **A short legal read before going public**: inbound dependency licences, attribution/NOTICE obligations, and trademark. (The old AGPL analysis is moot under MIT.) [[Wingman Distribution and Licensing Plan]] final warning.
7. **Apple Developer: decide individual vs Ltd, then enrol — before first public release** (restaged from "first signed build", R14; dogfood needs no signing). Migrating a team later is painful, a certificate impossible.
8. **Calendar reminder 2027-01-15: re-run the RDAP check on `rennet.com`** (expires 2026-10-31 but that is a renewal date; watch, do not plan around it).
9. **GitHub App registration** (only if/when the GitHub App device flow is wanted).
10. **Any deploy/publish/announce** of anything (site, releases, RSP spec, posts).

## 5. Working agreement

**Workflow (ship-to-main — Rai, 2026-08-06 ~13:49: "from this point onwards dont do PRs just ship").** Commit directly to `main`; no GitHub PR ceremony. Quality is gated **internally and mandatorily** before every push: an openspec proposal for non-trivial slices, `/wave` dual-agent review (Opus + Codex), the FULL gate suite green (`pnpm check`), never `--no-verify`. Every issue closure carries the verification record: gate output, new tests seen to fail first, budgets stated, claims cited `file:line`, and **"What I could not verify:"** filled in plainly (or "nothing"). "Just ship" removes ceremony, never gates. ⛔ Exception history: PR ceremony was retired 2026-08-06; approval by Rai remains the never-automated act for everything in §4 and the frozen core.

**Escalate to Rai (stop and ask) when:** anything touches the Contracts and Rulings §3 frozen core; anything is external-facing (publishing, posting, deploying, registering, emailing anyone); any licence question at all (including "may I lift this file"); any spend; anything touching the enterprise client's resources beyond read-only product-repo dogfood; a spike verdict contradicts a ratified ruling; a budget is 3x over and the abstraction smells wrong.

**Cadence:** impulse-driven via your dice — the issue queue is dependency-explicit precisely so that **any unblocked issue is fair game** whenever an impulse fires. Prefer: (1) unblocking spikes (Contracts and Rulings §5 — matcher precision gates the most), (2) the dependency chain toward the visible product (angles → canvases → orchestrator → publish), (3) whatever you can verify end-to-end in one session. File follow-up issues instead of scope-creeping; research alone never closes an issue.
