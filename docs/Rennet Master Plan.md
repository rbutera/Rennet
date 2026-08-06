---
tags: [rennet, architecture, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
related: ["[[Code Review Harness App]]", "[[Rennet Architecture Contracts]]", "[[Rennet Navi Handoff]]"]
---

# Rennet Master Plan

[[Rennet Architecture Contracts]] freezes the project-context, patchset, persistence, privacy, and publication contracts decided after this reconciliation. It wins within that scope. Remaining integration work is tracked in [[Rennet Decision Integration Tasks]], and empirical gate state in [[Rennet Evidence Gate Status]].

The private product monorepo is `/Users/rai/dev/rennet`, published to `github.com/rbutera/rennet`. This records source privately; it does not claim the future public GitHub organization, npm scope, domains, social accounts, or release channels.

The single authoritative reconciliation of the 2026-08-04 planning sprint for [[Code Review Harness App]]. This is a **spine, not an encyclopedia**: it states the product, rules on every known conflict between the eight plans and two Codex critiques, freezes what may not be relitigated, and points into the plans for depth. An autonomous agent builds from this document plus [[Rennet Navi Handoff]]; where this document and any plan disagree, **this document wins**, and where this document is silent, the supersede stack in §2 decides.

Zero new architecture is invented here. Every ruling cites its authority. Rulings marked **synthesis call** had no settling authority and may be overridden by Rai.

---

## 1. The product in one page

**Rennet** (rennet.dev) is an MIT-licensed, local-first Electron desktop app: a **review harness**. A coding harness points a model at your codebase so it can write; a review harness points the coding harnesses already on your machine at a change so you can read. It decomposes changesets too big to hold in your head into sub-400-LOC chunks read through six concurrent **angles**, keeps review state that survives a force-push and a night's sleep, and lands the result as a normal GitHub PR review. The LLM proposes structure and findings; the human disposes. No auto-approve, no auto-comment, no Rennet backend, no telemetry, BYOK via the user's own installed harnesses (Claude Code, codex, omp), zero-config as the North Star. Material sent through a selected harness may leave the machine for that harness's provider; every run discloses and records its assembled context.

**Positioning headline (settled):** *You stopped writing the code. You still have to answer for it.*

**The six angles (lens set v4, ratified):**

| # | Angle | Species | One line |
|---|---|---|---|
| 0 | **Spec** | queue over requirements | What this change was *supposed* to be: committed spec (Kiro/OpenSpec/superpowers), PR body, ticket; derived-and-marked when nothing is committed. The only angle that exists on a zero-hunk (spec-only) changeset. Upstream source of requirements for claims-and-evidence and of the decisions angle's `evidenced` disposition. |
| 1 | **The sequence** | sequence | Post-hoc reading order, named switchable strategies (layered / tests-first / spine-first), prose collapsed. |
| 2 | **Decisions** | queue | The calls only you can make. The **decision log is the angle's spine**: everything the author(-agent) decided, each with a reconstructed WHY marked as reconstructed; disposition triage **evidenced / mechanical / contestable**. ⛔ **Decisions are NEVER capped or truncated** (Rai, 2026-08-06, superseding the capped-queue design): a cap can hide the one decision you must answer for, and "you did not see it" is not a defence you can offer about your own branch. Contestable items are instead **rolled up into cohorts, ordered by salience, and collapsible** — every decision remains reachable, and the roll-up is what makes the set digestible. |
| 3 | **Claims and evidence** | queue | Bidirectional hunk↔requirement and claim↔test mapping, explicit polarity, UNCLAIMED bucket as the scope-creep detector. "Would that test have failed." |
| 4 | **Blast radius** | overlay | Cheap explainable signals only (irreversibility, contract surface, deletions, fan-in, CODEOWNERS, safety-net-weakening preset). Never churn-heat. |
| 5 | **Noise** | floor | Everything that earned no place above, grouped, categorised, summarised. **Deterministic checkers are the only admission authority for VERIFIED noise**; the LLM narrates, proposes patterns (→ SUSPECTED tier, skim-required), and spots anomalies. The totality/residue guarantee made visible: at any moment the user can see exactly what they have not looked at. |

**Subtraction is not an angle.** Its content (over-engineering, defensive scaffolding, redundancy-vs-repo) survives as `finding.ruleFamily` values and noise categories, with the propose-deletion affordance riding the finding. (Hub, lens set v4.)

**Both review modes are v1** (hub, 2026-08-04 evening): reviewing a diff an LLM just generated locally (working-tree changeset source) AND reviewing someone else's PR (GitHub changeset source). One engine, one review-state model, two sources, two publish-sheet variants: reviewing your own unpushed branch or your own PR → the sheet previews the **PR submission**; reviewing someone else's PR → the sheet previews the **review it will post**, line by line, with the degradation ledger. Paper is what leaves the machine.

**Route handoff is DESCOPED** (Rai: "too many permissions issues with data protection and privacy"). Only the cross-person shared-route artifact died; self-review, the signature ceremony, and explicit publish all survive. **The alibi against the "this enables 3,000-line AI slop PRs" objection is re-derived from the author-side mode itself**: Rennet fronts "review your agent's diff before it becomes anyone else's problem." The author does the work first; the publish-as-PR-submission variant means the artifact of self-review is a *better PR* (surfaced decisions, honest description), not a shared route. Launch copy leads with the confession form ("I kept opening PRs my agent wrote and could not honestly say I had read them"), never with "makes 3,000 lines pleasant".

**The purpose (Rai, 2026-08-06 — this supersedes the previous "engineering thesis" framing):** **Rennet exists to make a large diff digestible, and the mechanism is ROLL-UP.** A changeset too big to hold in your head is rolled up into **logical cohorts** — groups of related changes that can be understood as one thing — and the decisions inside it are rolled up the same way, into digestible segments. **Grouping is the core mechanism; digestibility is the point.** Everything else in this document is in service of that, and anything that makes a large diff *less* digestible is wrong however elegant it is.

The supporting engineering, which is means and not purpose: (1) **a surfacing format/DSL** any coding agent uses to surface the right areas — validated deterministically, rendered by us, published as an open spec (RSP, MIT) — and (2) **model-tier routing**: heavy models where they reason (decomposition graph, decision reconstruction, adjudication), light models where they fetch (test mapping, labels, noise summaries), deterministic code wherever a tool can be 100% right. Plus the third leg: **the instruction layer** — versioned base instructions shipped with the app, user guidance layered through the settings ladder, the exact assembled prompt always inspectable. Deterministic validation of model output remains a **mechanism** we rely on; it is never the reason the product exists, and it must never be stated as the headline.

Also ratified into v1: **LSP code intelligence** (Tier 0 tree-sitter index everywhere + Tier 1 TypeScript against ephemeral materialized worktrees, degraded-result detector load-bearing, inline definition bands below the line, opaque), **open-in-editor** with copy disclosure, **impl↔tests toggle**, **glass identity** (glass is chrome, code is opaque, paper leaves the machine; backlight blue = private; amber = blast radius/disagreement only).

---

## 2. The supersede stack and conflict rulings

Authority order, top outranks bottom:

1. **Rai's 2026-08-04 late-evening ratifications** in the hub Decisions ([[Code Review Harness App]]): Rennet on rennet.dev; lens set v4; route handoff descoped; both modes v1; publish-as-preview; DSL/routing/instruction thesis; LSP + inline definitions + open-in-editor; impl↔tests toggle; omp as third harness; decisions-angle refinement (ratified in principle).
2. **[[Rennet Architecture Contracts]]**, within project context, review snapshots, persistence, harness access, and publication.
3. **The two ratified Codex critiques**: [[reviews/wingman-architecture-codex-critique]] and [[reviews/wingman-adapter-licensing-codex-adjudication]].
4. **The eight plans** (Architecture, Harness Adapter Protocol, GitHub Integration, Distribution and Licensing, Repo Bootstrap, Settings and Setup, LSP Integration, Surfacing DSL and Model Routing), later-written and more-verified beats earlier where they conflict among themselves.
5. **Measured spike verdicts** recorded in [[Rennet Evidence Gate Status]], including [[Wingman Spike – Pierre Diff Virtualization]].
6. [[Wingman Branding Plan]] for naming mechanics and the RAI-ONLY registration checklist.

### Conflict rulings

| # | Conflict | Ruling | Authority |
|---|---|---|---|
| R1 | Architecture plan's `@wingman/*` naming | Name is **Rennet**; packages are `@rennet/*` in-workspace from day one. Rai explicitly authorised the private personal monorepo `rbutera/rennet` on 2026-08-05. That is the working source remote, not a public namespace claim. The future GitHub organisation, npm scope, domains, socials, and releases remain deferred and RAI-ONLY; no npm publish before the scope is hand-verified and claimed. | Rai, 2026-08-05; hub decision (name); branding plan (remaining registrations) |
| R2 | Bundled/linked `@anthropic-ai/claude-agent-sdk` (arch D12/B4/B18, adapter plan §2.1) | ⛔ **SUPERSEDED by Rai's decision, 2026-08-06 — the SDK is ADOPTED.** *The original ruling (retained for the record): "Retired. The SDK is proprietary and AGPL-incompatible; the Claude adapter is a clean-room process-per-turn wrapper… never importing the SDK or its types."* Both of its premises are gone. The AGPL incompatibility died with the MIT flip (R3). And the pricing worry was never real: **`query()` spawns the user's own installed `claude` binary** via `pathToClaudeCodeExecutable` — the SDK's own types document the option as *"Path to the Claude Code executable. Uses the built-in executable if not specified"*, and *"the subprocess inherits `process.env`"* — so it authenticates through the user's **Claude subscription OAuth**, exactly as a clean-room wrapper spawning the same binary would. `ApiKeySource` includes `'oauth'` as a first-class value and is reported back per turn, so the adapter can assert subscription auth and warn if a metered key ever takes over. **Per-token cost is identical either way; build cost is not.** The Claude adapter is therefore an SDK integration. Pass the user's installed binary explicitly, and **strip the SDK's bundled per-platform executables at packaging time** (T3 Code's `DESKTOP_FILE_EXCLUSIONS` is the worked precedent), which keeps the notarization surface manageable. The "zero compiled artifacts" line is retired with the rest of the ruling. | Rai, 2026-08-06; auth trace in [[T3 Code Integration Research]] |
| R3 | Protocol/types inside AGPL `core` (arch D1 subpath exports) | ⛔ **MOOT — superseded by Rai's decision, 2026-08-06: everything is MIT.** *The original ruling split `packages/protocol` and `packages/types` to Apache-2.0 while core/adapters/ui/desktop stayed AGPL-3.0-only.* **That split existed solely to keep the interoperability surface permissive while the application was copyleft. With MIT everywhere there is nothing to keep permissive from, so the split has no remaining purpose and is collapsed.** ⭐ **The packages themselves survive unchanged** — `types` and `protocol` remain separate packages for architectural reasons (a mobile or third-party client is a peer of the renderer, per R19/R20), and the **dependency-direction rule is retained on its own merits**: protocol may depend on types, and neither imports anything else in-repo, CI-enforced. Only the *licence* rationale is dropped. | Rai, 2026-08-06 |
| R4 | Instructions licensing: DSL plan §6.1 puts `packages/instructions` **AGPL** while the DSL itself is Apache | ⛔ **MOOT — superseded by Rai's decision, 2026-08-06: everything is MIT**, so there is no AGPL/Apache seam for `packages/instructions` to sit across. ⭐ **The non-licence half of the ruling survives and still matters:** base instructions are product voice, change weekly, and are deliberately **not part of the RSP spec** (DSL plan §7 — a third party implementing RSP writes their own instructions and still interoperates). Keep the CI rule that `instructions` is never a dependency of `protocol`, `types`, or mobile; it is now an architectural boundary rather than a licensing one. | Rai, 2026-08-06; DSL plan §7 for the surviving half |
| R5 | AGPL-3.0-**or-later** (bootstrap plan §0, CLAUDE.md draft) vs AGPL-3.0-**only** (distribution plan) | ⛔ **MOOT — superseded by Rai's decision, 2026-08-06.** The question only existed inside the AGPL family; **the licence is MIT**, which has no `-only`/`-or-later` axis. Nothing replaces this ruling. | Rai, 2026-08-06 |
| R6 | Arch plan defers disagreement (v1 table LATER) vs hub "disagreement ships in v1" | **Both true, reconciled**: "ships in v1" means the first public release, not the first adapter. The **shape** ships now (claim polarity, `adjudication` docType with no `rejectedBy`, `notEmittedBy` for silence, provenance `sampleGroupId`/`sampleIndex`); **emission** waits for a second adapter by construction. N=3 is a **trigger**, never a default; disagreement flares only after explicit evidence-based adjudication. | Adapter plan §7; adjudication pt 3 |
| R7 | Arch plan's post-PR-only dogfood cut (§3, contested call 1) | **Overridden: both modes are v1 MUST** (working-tree + GitHub PR changeset sources). The settings and DSL plans are already written against both; the arch v1 table row flips. | Hub decision 2026-08-04 evening |
| R8 | Arch D4 three-tier content-addressed hunk identity | **Superseded by the lineage-graph direction**: immutable occurrence IDs + lineage graph (exact/one-to-one/split/merge/move/ambiguous/rejected), path/symbol/content hashes demoted to weighted evidence, max-weight bipartite matching, **read state never auto-carries through similarity** (possible-continuation → require reread), **ambiguity fails closed**, contextual disambiguator for duplicate bodies. The matcher-precision spike is pre-build spike #1; auto-carry requires ~100% measured precision. `hunkKey`-style content hashes survive as matcher features and as the `dismissalKey` basis, not as identity. | Architecture critique (a) |
| R9 | Arch D7 deterministic-**authoritative** chunking | **Hybrid ratified**: deterministic pass owns totality, classification, limits, and the always-present offline fallback (the floor, not the authority); the harness proposes a **complete versioned decomposition graph** with rationale (never per-hunk regroup events); a deterministic validator rejects omissions/duplication/oversize/invalid anchors; the user accepts/edits. Quality is tested by invariants + labelled dependency pairs + blinded preference, not golden text. The DSL plan's `decomposition.proposal` + V100–V110 is the implementation. | Architecture critique (d); DSL plan §2.4, §4 |
| R10 | Adapter plan's `harness-degenerate` as utility default | **Rejected → batching + budget ratified**: deterministic local code for non-semantic work → **batched** utility prompts per meaningful unit → optional direct-API port → **never process-per-hunk**. Hard product budget: **<15s to first useful chunk, <5 harness invocations for initial decomposition**, enforced by the `RoutePlan` budget gate with a CI test. `decomposition.skeleton` exists to beat the 15s. | Adjudication pt 2; DSL plan §5.3 |
| R11 | Subtraction-angle artifacts (arch `AngleId`, arch v1 table, branding site §5 and voice vocabulary) | **Absorbed**: `AngleId` becomes `spec \| sequence \| decisions \| claims \| blast-radius \| noise`; subtraction content lives in `finding.ruleFamily` (`over-engineering`, `defensive-scaffolding`, `redundancy`) and noise categories, propose-deletion affordance preserved on the finding. Branding copy (site section 5, protected-vocabulary list) is corrected at build time. | Hub lens set v4; DSL plan D25 |
| R12 | DSL plan's request: `append` as a fourth merge strategy (settings plan §1.3 says "three, no fourth") | **RATIFIED.** `append` joins the settings registry as a fourth strategy, **scoped to guidance-prose keys** (`instructions.general/task/angle`): concatenation in ladder order with layer-labelled delimiters. The settings plan's "no fourth" sentence is amended; the registry test asserts `append` is only used by instruction keys. | This synthesis, per dispatch brief; DSL plan §6.2/D29 |
| R13 | DSL plan's two new capability flags (`supportsPerCallModelSelection`, `advertisedModels`) | **RATIFIED into the adapter protocol** (§1.1), under the three-layer capability model, starting `false`, earned by the conformance suite. | This synthesis, per dispatch brief; DSL plan §5.4/D16 |
| R14 | Apple Developer timing: licensing plan pins individual-vs-Ltd to "before the first signed build" | **Restaged: before first public release.** Dogfood runs unsigned local dev builds (arch v1 table already says so), so nothing blocks on Apple. The individual-vs-Ltd decision + enrolment remain RAI-ONLY with the migrating-is-painful warning intact. | Rai, 2026-08-04 discussion |
| R15 | Route-handoff residue: arch v1 row "self-review route handoff (the keystone)", `route.drafted` event, GitHub plan's "makes the route handoff work", branding's "the route handoff is the alibi" | **All deleted/re-anchored.** The event type is removed from the taxonomy; the review body remains the carrier for structural degradations (that rationale stands on its own); the alibi is the author-side mode itself (§1). | Hub decision 2026-08-04 evening |
| R16 | `@tanstack/react-virtual` on the diff surface (stack note must-use; arch D14 fallback) | **Retired as plan B.** Measured verdict: **`CodeView` as-is, never bare `FileDiff`/`PatchDiff`** (virtualization is opt-in and silently absent otherwise; 899 vs 97,139 DOM nodes, 15.4ms vs 493ms worst frame at 5k lines). react-virtual survives only for non-diff lists (rails, queues, inbox). Pin `@pierre/diffs` exactly; depend on `@pierre/theme` directly. | Pierre spike verdict |
| R17 | Event sourcing/publish underspecification (arch D8/D15/2.3) | **Codex prescriptions ratified**: missing event types added (patch failed/cancelled/truncated; match ambiguous/confirmed/rejected/split/merged; review abandoned/superseded/attached; decomposition proposed/accepted/rejected atomically; external GitHub changes; publish cancelled/superseded/retry/**outcome-unknown**/reconciled; command dedup). Upcasts chain v1→v2→v3 with golden event streams; unknown future types fail safe. **Telemetry split from state** with property-tested noninterference (vary/insert/delete/reorder private events → byte-identical outbound payload). Publish gets `outcome: unknown` + deterministic marker in the pending review + query-before-retry, tested with failure injection at every remote boundary. | Architecture critique (b) |
| R18 | Diff-pipeline cliffs (arch D10/2.2) | **Ratified**: keep bytes as bytes (Uint8Array/spool, never byte ranges into JS strings); binary/submodule/mode-only/truncated inputs are first-class and **done/publish block on incomplete ingestion**; oversize hunks must be splittable to honour the 400-LOC thesis; tree-sitter parse-once-dispose; O(k²) similarity guarded on generated files. | Architecture critique (c) |
| R19 | Portable boundary assumes Electron (arch D11/2.4) | **Ratified**: the frozen portable contract is **transport-neutral** (JSON Schema/IDL generated from the zod maps, wire fixtures tested both sides); MessageChannelMain topology belongs to the Electron host; protocol gains version negotiation, capabilities, structured errors, reconnect/replay, flow control before mobile; `RepoId = realpath(git-common-dir)` is machine-local → durable identity is the **RepoRecord** (uuidv7 + aliases: common-dir, forge identity, root-commit hint) per settings plan §2.3; path-bearing models never go to remote clients; subscriptions send recipient-specific projections, never raw `EventEnvelope`s; `SecretStorePort` exists. | Architecture critique (f); settings plan §2.3 |
| R20 | `ui` imports `core` (arch D2) vs `ui` imports protocol+React only (bootstrap plan) | **Bootstrap wins**: `ui` imports `protocol` + `types` only, never `core` — the renderer reaches the engine exclusively through the IPC command map, making the mobile client a peer of the renderer. With R3's split there is nothing in `core` the renderer legitimately needs. **Synthesis call — Rai may override.** | Bootstrap plan §1 (stricter, consistent with D11) |
| R21 | Repo layout variants (arch 5 packages / bootstrap 6 / distribution 3+apps) | **Bootstrap layout adopted** (it carries the gates, tsconfig bases, and commit sequence), **plus** `packages/types` split out of protocol (R3) and `packages/instructions` added (R4). Final: `packages/{types, protocol, core, adapters, ui, instructions, tsconfig}` + `apps/{desktop, mobile-placeholder}` + `scripts/`, `spikes/` (non-workspace). **Synthesis call** on the exact merge; the dependency arrows and gates are frozen regardless. | Bootstrap plan §1; distribution plan §4.1 |
| R22 | Contribution policy: bootstrap's generic "lightweight CLA" vs distribution's concrete mechanism | **Distribution plan wins**: DCO (`dcoapp/app`) + `CONTRIBUTORS.md` explicit grant line in the first PR + ~12-line CI action + ICLA-derived email grant for >50-line or core contributions; cla-assistant is dead tooling, do not use. **Policy files land before the repo is ever public; until then code PRs are not accepted at all.** | Distribution plan §4.3 |
| R23 | Third harness slot: brief's npm `oh-my-pi` | **omp ratified**: `@oh-my-pi/pi-coding-agent` (bin `omp`, can1357/oh-my-pi, MIT), `pi` as compatible subset; npm `oh-my-pi` is an abandoned namesake, never target it. Capability flags start `false`, earned by conformance. | Hub decision (adapter plan D3 ratified) |
| R24 | `GithubPort` (bootstrap CLAUDE.md) vs `ForgePort` (arch/GitHub plans) | **`ForgePort`**, forge-neutral with capability flags, degradation written against capabilities, never `if (forge === 'github')`. | GitHub plan §5 |
| R25 | Arch B3 "spike: measure Pierre" | **Done and measured** (spike doc). Residual work: re-measure on 1.3.2 (npm cooldown forced 1.3.0-rc.1), CPU-throttled/low-end run, annotations-survive-recycling prototype, Shiki bundle trim, AST-LRU pinning. | Pierre spike |
| R26 | Glass identity LATER (arch v1 table) vs dispatch cut including glass UI | **Tokens and chrome ship in v1** (the token file exists in the mood board; cheap), visual polish stays LATER. Rough edges allowed; doctrine (glass=chrome, code=opaque, paper=publish) absolute from the first screen. **Synthesis call.** | Hub ratified identity; dispatch brief |
| R27 | Repository-local context vs app-owned staging | Durable project configuration, deterministic snapshots, and evidence-backed learned knowledge live under `.rennet/`; temporary source materialisations, prompt staging, review state, provider frames, and LSP caches live in Rennet-owned application storage. `projectContext.visibility` is `local` by default or `git-visible`; Rennet never stages or commits. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §2 |
| R28 | Live working-tree and mutable PR-head review models | Every review targets an immutable `Patchset`. Local capture includes committed branch changes, index, unstaged tracked changes, and non-ignored untracked files. A local edit or remote head/base update creates a new patchset; it never rewrites the active one. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §3 |
| R29 | Analysis after local edits or a remote PR update | Exact unaffected analysis remains current. Directly affected analysis becomes `invalid`; dependency-, context-, or ambiguity-affected analysis becomes `potentially-invalid`. Old output remains visible until explicit affected-only, angle, or item regeneration succeeds; model-backed regeneration is never automatic. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §4 |
| R30 | Stale project-map reuse | Project snapshots are deterministic and pinned to the resolved default-branch OID plus config, generator, schema, and toolchain fingerprints. Default-branch movement incrementally rebuilds affected shards, with full-build byte equivalence. A non-current artifact is refreshed, visibly omitted, or blocks the dependent operation; it is never silently trusted. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §2.3–2.4 |
| R31 | Ambient harness authority and universal no-cloud copy | Harnesses receive an app-owned immutable materialisation plus explicitly assembled current context by default. Unproven ambient sources make the manifest non-exhaustive. Product copy says **no Rennet backend** and discloses provider egress, authority, model source, and spend; it never promises universally that nothing leaves the machine. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §7.2 |
| R32 | Append-only history vs erasure and unknown-event skipping | Append-only applies within a retained review. Delete-review physically purges every Rennet-controlled event, projection, receipt, artifact, blob, prompt, backup, WAL, and cache copy. Unknown events are preserved byte-for-byte but block projection, completion, regeneration, and publish; skip-and-continue is forbidden. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §7.3–7.4 |
| R33 | Author-side self-review publication | Local completion creates a pure PR title/body/draft/base/head preview and performs zero Git or GitHub mutation. Any create/update operation is separate and explicit; Rennet never pushes source code. Reviewer publication remains inspect, sign, and one idempotent submit pinned to the reviewed head. | Rai, 2026-08-05; [[Rennet Architecture Contracts]] §9 |

### 2.1 The review→agent handoff loop (NEW, Rai 2026-08-06)

This is a **new core feature** and it previously appeared in no plan. It is what turns Rennet from a
reading tool into a **review-driven coding loop**.

**The disposition is the one data model.** A disposition is:

```
disposition = {
  anchor: line | hunk | symbol,
  type:   approve | change-request | comment | question,
  body:   text
}
```

⭐ **One model, two destinations — the mode decides where it goes, never what it is:**

| Mode | Where dispositions land |
|---|---|
| Reviewing **someone else's PR** | GitHub review comments, published as one batched review (unchanged from R33) |
| Reviewing **your own branch** | A **batched task bundle handed to a coding harness**, which addresses them on the branch → produces a **new patchset** → Rennet **re-reviews only the DELTA** |

⭐⭐ **The delta re-review is cheap because the existing architecture already pays for it.** Immutable
patchsets (R28), occurrence-ID + lineage identity (R8), and force-push survival mean **an approved hunk
that did not change stays approved** — so the second pass presents only what actually moved. That is
the whole reason the loop is affordable, and it is why R8's matcher-precision gate is now doubly
load-bearing: it protects read state *and* gates this loop.

⛔ **The safety properties do not relax inside the loop.** The human still disposes; the agent
addresses dispositions and nothing else. Rennet still never pushes source code (R33). A new patchset
is a new patchset — it never rewrites the active one (R28) — and the delta re-review is subject to the
same totality/residue guarantee as a first pass. Read state is evidenced by an action (OQ4), so an
agent-authored change is never "already read" because a human once read the code it replaced.

**Implementation lead — mine T3 Code's checkpointing.** [[T3 Code Integration Research]] found a
production answer to exactly the mechanism this loop needs: bracket the agent's turn with workspace
checkpoints stored as **hidden Git refs**, then extract the turn diff. See `CheckpointStore.ts`,
`CheckpointDiffQuery.ts`, and `CheckpointReactor.ts` in `pingdotgg/t3code` (MIT). Read it before
designing this; do not build on a T3 core.

### 2.2 T3 Code: adopt-partial (2026-08-06)

Full analysis in [[T3 Code Integration Research]]. The short version, because it bears on several
rulings above:

- **Adopt-partial, not a core.** T3 Code is a control surface for *writing* code; Rennet is a harness
  for *reading* it. Angles, review state, lineage identity, decomposition, findings, and publish have
  no counterpart there.
- **Mine two things:** the checkpointing family above (for §2.1), and `DrainableWorker` (a
  transactional queue paired with a transactional outstanding-count, so tests await a real drain
  instead of sleeping) as a **vendoring candidate** — MIT, small, self-contained.
- **Its event-sourced spine corroborates R17.** Command → durable receipt → pure decider → one SQL
  transaction → projector → post-commit read-model swap, running under 100,000 users. Independent
  convergence on our design is evidence R17 is right; read it, do not import it.
- **It does not do orchestration.** See OQ9 — T3 multiplexes providers and hides which one is behind a
  thread. The orchestrator model is ours to build.

---

## 3. Frozen core, adjustable, open

### Frozen — no agent may change these without escalating to Rai

**Identity and licence**
- Name **Rennet**. Private source lives in `rbutera/rennet`; public organisation, npm, domain, social, and release registrations remain RAI-ONLY. No public publishing or announcing.
- **MIT throughout, one licence for every package** (Rai, 2026-08-06). No AGPL, no Apache-2.0 carve-out, no per-package licence variation. The `protocol`/`types` **import-nothing rule survives as an architectural boundary**, not a licensing one. SPDX headers and REUSE lint are no longer required by the licence structure; a single top-level `LICENSE` plus a `NOTICE` for vendored third-party content is sufficient.
- Rai is sole copyright holder: **no outside code contributions before the policy lands (R22), no AI-attribution trailers, ever.**
- The Claude adapter **uses `@anthropic-ai/claude-agent-sdk`**, passing the user's installed `claude` binary so auth stays on their subscription (R2, superseded 2026-08-06). Still frozen: **never read a credential** (adapter plan D6) and **never bundle a harness binary of our own** — the SDK's bundled per-platform executables are stripped at packaging, and the user's installed harness is always the one that runs.
- This is Rai's personal product. **Never the enterprise client time/resources/repos for development, fixtures, calibration, or model-backed dogfood without explicit written approval.** Client mode never mutates the source checkout or its Git metadata.

**Data model and state**
- Four nouns (repo/worktree/workspace/changeset); state keys on repo identity + changeset, never a path; durable identity is the RepoRecord (R19).
- Occurrence-ID + lineage-graph hunk identity; read state never auto-carries; ambiguity fails closed (R8).
- Reviews contain append-only immutable patchsets. Local capture includes branch, index, unstaged, and non-ignored untracked state; a local edit or remote PR update creates a new patchset (R28).
- Exact unaffected analysis may remain current. Direct changes invalidate it; dependency/context changes make it potentially invalid. Prior output remains visible until explicit model-backed regeneration succeeds (R29).
- `.rennet/` owns durable project config, deterministic default-branch snapshots, and evidence-backed learned knowledge only. Freshness is input-fingerprint based and stale context is never consumed (R27/R30).
- Events append-only; upcasts at read; projections disposable; schema-version gate + downgrade refusal on boot; pre-migration backups.
- Delete-review physically purges every Rennet-controlled copy. Unknown event types preserve their bytes but block projection, completion, regeneration, and publishing (R32).
- Private events structurally excluded from publish, proven by noninterference property tests (R17). Pace/coverage privacy is not a setting.
- Publish is a three-phase explicit human act, idempotent, with outcome-unknown reconciliation; one batched GitHub review event; degradations visible in the sheet before signing.
- Done/publish block on incomplete ingestion; totality/residue guarantee; the noise angle is the floor.

**Engine and protocol**
- Hybrid chunking (R9); deterministic floor always present and offline-capable.
- The DSL: agents surface, the validator decides; **agents never mint identity**; quotes verified byte-for-byte; closed vocabularies; validator is a pure function that structurally cannot see guidance.
- Utility batching + the <15s / <5-invocation budget as a mechanical gate (R10). Never process-per-hunk.
- Three-layer capability flags, earned by conformance, never declared from docs. No `if (harness === X)` above the adapter boundary.
- Harnesses run against app-owned immutable materialisations with explicit current context; writes, execution, ambient MCP/hooks/settings, and reads outside the offered roots are denied where enforceable. Any unproven ambient authority is disclosed and makes the context manifest non-exhaustive (R31).
- Instruction layer: the contract is not user-configurable, the voice is; shared layers may assert facts and reduce work, never raise spend; repo files are untrusted input behind the trust gate; context and guidance read at base ref for others' PRs.
- Zero-config North Star: discovery never requires config to be correct; no key ceremony; login-shell PATH harvest, never `which`.

**LSP**
- Materialisation is the mechanism; two refs → two app-cache-owned source trees → two servers. Never use `git worktree add` against the source repository or link writable server paths into user-owned dependencies. Every answer is tier-labelled; degraded-result detector + positive-control readiness probe are load-bearing; detect-never-install; definitions are context, never coverage; open-in-editor discloses the copy before the click.

**UI doctrine**
- Glass is chrome; code is opaque; paper is what leaves the machine. Backlight blue = private-to-reviewer only; amber = blast radius/disagreement; no fourth hue. Serif only on paper. `CodeView`, never bare `FileDiff`/`PatchDiff` (R16).

**Process**
- Protected `main`, PR-per-bead, gates run the FULL suite before every push, never `--no-verify`, Rai merges. Spikes produce verdicts, never merged code. A check that cannot fail has not passed: every gate ships with failing fixtures and a self-test.

### Adjustable — defaults Navi may revise with recorded evidence

Similarity/matcher thresholds and features (post-spike); chunk budget (400) and order strategies; decisions-cap number (measure first, S17); discovery caps (depth 4 / nodes / wall-clock); context budgets (96KB/32KB); instruction budget (8KB); validator size limits; batch sizes in the routing matrix (post-spike); LSP idle/server/RSS/disk budgets, band cap (40 lines), breadcrumb depth (3); app-cache dependency materialisation policy; ephemeral-delta coalescing (16ms); projection table set; backup rotation (5); Tier-0 ranking heuristic; `--find-renames` threshold.

### Open questions (consolidated; each is a bead or lives inside one)

1. JSON Schema subset accepted by `claude -p --json-schema` / codex `outputSchema` (spike; flattening fallback pre-designed).
2. Occurrence-manifest fit in a heavy turn's budget; two-phase file→hunk offering vs last-resort provisional anchors.
3. ✅ **CLOSED (Rai, 2026-08-06): `angles.decisions.maxItems` does not exist.** Decisions are never capped or truncated — they are rolled into cohorts, ordered, and collapsible. The measurement this question asked for is no longer needed to pick a number; it is still worth doing to tune *cohort* size and ordering.
4. ✅ **CLOSED (Rai, 2026-08-06): a chunk is READ when the reviewer takes an ACTION on it** — approve, request-change, or ask-question. **Never by scroll position or dwell time.** Reading is evidenced by a disposition, not inferred from behaviour; anything the reviewer merely scrolled past is at most *skimmed*, and the totality/residue guarantee reports it as unread.
5. Quote-match rejection rate on real diffs; normalisation width.
6. **Reframed by the never-cap decision (2026-08-06).** Ranking no longer decides *what survives a cap*, only **what the reviewer meets first** and how cohorts are ordered internally — a presentation question, not a suppression one, and therefore much lower risk. Still open: salience versus deterministic blast-radius as the ordering signal.
7. `done` for a spec-only changeset; spec-drift view across patchsets. On **how far spec derivation may reach** — ⚠️ **LEADING RECOMMENDATION, PENDING RAI'S FINAL PICK, not a decision**: *derive-and-mark, falsifiably*. Where no committed spec, PR body, or ticket exists, infer intent from the diff, **label it `reconstructed / unconfirmed` wherever it is shown**, and ⛔ **never silently feed a derived requirement into the scope-creep detector** — an inferred requirement that quietly marks real code as UNCLAIMED manufactures a finding out of a guess. Rai to confirm or reject.
8. Claim identity: does semantic matching need a model call at all.
9. ✅ **REFINED into the orchestrator-harness model (Rai, 2026-08-06).** The user always talks to **ONE orchestrator harness and session, which the user picks**; that orchestrator synthesises findings across the other harnesses and roles, including multi-harness reviews. Under the hood Rennet may string together many harnesses and model sizes for different needs. **Fresh sessions are the default**; rehydrate only where dropping context is expensively wasteful. ⚠️ Note this is the one place Rennet must build for itself — [[T3 Code Integration Research]] measured that T3 Code *multiplexes* providers (one thread, one provider, identity deliberately hidden) and never makes them collaborate.
10. ✅ **CLOSED (Rai, 2026-08-06): nearest-ancestor first.** Monorepo sub-package settings resolve from the nearest ancestor outward; nested repo files are consulted only where that is insufficient.
11. Config schema versioning detail (needed before the first key rename).
12. ✅ **CLOSED (Rai, 2026-08-06): redetect on every launch.** Editor `auto` re-resolves per launch rather than binding once, so a newly installed or changed editor is picked up without the user clearing state. Running-bundle precedence remains a detail of that resolution.
13. Trust-gate per-key granularity (watch, do not build).
14. Home query composition (`involves:@me` is probably wrong alone); draft-PR APPROVE; multi-line anchor validity rules (GitHub spike answers most).
15. Whether `exhaustive` context manifests can ever be true per harness (isolation spike).
16. Windows/Linux signing cost (research only); docs/ licence choice. *(Commercial-licence trigger wording is moot under MIT.)*
17. ⚠️ **NEW, unresolved (2026-08-06): is grouping hard-baked or project-configurable?** Roll-up into cohorts is now the core mechanism (§1), which makes "who decides the grouping" a first-order question rather than a detail. Configurable grouping is obviously more powerful per-repo and obviously in tension with the **zero-config North Star** — and the North Star is not a preference we may quietly trade away for flexibility. **Deliberately left open**; do not resolve it by defaulting.

---

## 4. M0 Dogfood cut (reconciled)

Target: Rai daily-driving his own local diffs and permitted personal/public pull requests. Client repositories are excluded unless separately authorised in writing. Rough edges allowed, nothing public. This milestone is **M0 Dogfood**, not the six-angle public 1.0 promise.

**In (MUST):** both changeset sources; Claude adapter — **an `@anthropic-ai/claude-agent-sdk` integration** passing the user's installed `claude` binary (was "clean-room CLI wrapper (process-per-turn)" until R2 was reversed 2026-08-06) + discovery + conformance suite + utility tier (batched) + RoutePlan budget gate; GitHub rung 0 + rung 2 auth with SSO partial-results detection, home surface, deep fetch, local-diff-first, REST-conditional polling, force-push snapshot + auto-reopen, publish batch→sign→submit with degradation ledger and the two sheet variants; occurrence/lineage identity engine; hybrid chunking with deterministic floor; event store with schema versioning, upcasts, privacy property tests, publish idempotency; angles: **spec (incl. derivation), sequence, decisions, blast radius, noise** — claims-and-evidence and adjudication ship **schemas only**; DSL v1 set (envelope, provenance, anchors, validator, skeleton/proposal/decision/finding/test.mapping/noise.patternProposal/spec.model, zero-hunk support, validation.report + retry, conformance corpus); instruction layer (versioned bases, guidance on the ladder, trust gate, manifest + open-assembled-prompt, hostile fixture); settings v1 per settings plan §7 (registry, resolver with `append`, records, trust gate, context pipeline, first-run zero-config + fresh-HOME test, discovery golden test); impl↔tests toggle; findings queue with severity floor + sticky dismissal; LSP Tier 0 everywhere + TS Tier 1 (materialization, degraded detector, readiness probe, inline bands, hover, alsoInChangeset) + open-in-editor with disclosure; `CodeView` surface + coverage UI + anchored threads + diff chat (one harness); command registry/palette; glass tokens + chrome (R26); unsigned local dev build.

Also mandatory from [[Rennet Architecture Contracts]]: `.rennet` deterministic project snapshots and learned knowledge with freshness gating; app-cache-owned staging/materialisations; immutable patchsets; automatic current/invalid/potentially-invalid classification after local or remote updates; explicit affected-only regeneration with stale output retained; canonical artifact provenance; command receipts; physical review purge; unknown-event blocking; honest harness egress/spend disclosure; pure author-side PR preview.

**Later:** codex + omp adapters (interfaces and conformance ready); disagreement emission; claims emission; anomaly docs; references (`gr`), C# Tier 1, docked definitions, promoteToWorktree; signing/notarization/updater/release CI (pre-public-release phase); GitHub App device flow; bot-comment ingestion; mobile everything; watch mode; CI comparator; repo-file **write** ceremony; pin UI; presets; export/import; RSP publication (launch act).

**Never in v1 (by doctrine):** auto-approve/auto-comment; telemetry; diagnostics stream (LSP L12); textual DSL; canvas/Monaco renderer; harness-degenerate per item.

---

## 5. Pre-build spikes, ranked by information value

The entry gate: **no dependent build work before the relevant spike lands; independent work (toolchain bootstrap, protocol skeletons, gates) may proceed in parallel.** Every spike closes with a written verdict under `docs/`; throwaway spike code is never promoted directly into production packages.

1. **Matcher precision (lineage graph) — OPEN.** Build the matcher alone; mutation fixtures (rename/move/dup/split/merge/ambiguous) + 10–20 permitted public, personal, or synthetic patchset pairs; measure auto-match precision and recall separately; auto-carry requires ~100% precision; ambiguity fails closed. Client PRs are prohibited as fixtures. Wrong = state silently carried to wrong code, the product's worst failure. (Critique risk 1.)
2. **DSL schema subset (D1).** ~1 hour: which JSON Schema features `claude -p --json-schema` and codex `outputSchema` accept (unions, `$ref`, `minItems`). Gates the entire document shape; flattening fallback pre-designed.
3. **Event-store + publish failure injection — CLOSED.** [[Rennet Spike - Event Store and Publish Failure Injection]] proves replay, upcasts, private-event noninterference, command deduplication, before/after-acceptance failure, query-before-retry reconciliation, and unknown-event fail-safe behaviour. Reuse the harness as the seed for production tests. (Critique risk 2.)
4. **Decomposition quality comparison.** 8–12 representative large PRs; deterministic vs harness-first vs validated-hybrid; blind comparison on regroups, missed dependency pairs, time-to-explain, preference. Decomposition quality IS the product. (Critique risk 3.)
5. **Capability-gating stress + live codex turn.** `canGateToolCalls` across permission modes, org ask-rules, cancel-while-pending, unsupported binary; codex approval round trip and `turn/steer` reliability. (Adjudication pt 1; adapter B3.)
6. **L-B13 LSP ladder — CLOSED for the TS7 promotion decision.** [[Rennet Spike - TypeScript LSP Ladder]] measured three fresh native-TS7 server runs over an 81,397-file public checkout: 37.45ms median initialize, 75.47ms first hover, 345.95MB RSS, with positive definition, reference, and prepare-rename controls. Promote native `tsgo --lsp --stdio` for TS7 repos; keep fallbacks and omit rename from v1 UI.
7. **Claude CLI probe** (subsumes retired SDK spikes): `-p --resume --fork-session --json-schema` fidelity, prompt-cache across resume/fork (decides N=3 affordability), context-isolation proof per harness (gates `exhaustive`), batching curve per-request/10/50/whole-diff (adjudication pt 2 spike; sets the §5.2 batch numbers).
8. **GitHub publish batch + read-back** on a throwaway repo: threads-batch error shapes, partial failure, `startLine>line`, out-of-diff anchors, thread-ID matching after batch. Every publish-path decision is currently introspection-only.

Second rank: Pierre 1.3.2 re-measure + CPU throttling remains blocked by the npm cooldown; the refreshed prototype covers the product invalidation state but not Pierre annotation recycling. **Electron 43 `node:sqlite` is CLOSED** by [[Rennet Spike - Electron 43 node sqlite]]; use the built-in store and retire the WASM/Kysely bridge. Outdated-thread re-anchor remains P2. See [[Rennet Evidence Gate Status]].

---

## 6. Pointers for depth

| Topic | Document | Read for |
|---|---|---|
| Product, decisions (supreme), market, lens validation | [[Code Review Harness App]] | Everything; Decisions section outranks all plans |
| Packages, ports, IPC, event store, process model, v1 table | [[Wingman Architecture Plan]] | D1–D15 as amended by R1–R26; type sketches |
| Adversarial corrections to the architecture | [[reviews/wingman-architecture-codex-critique]] | R8, R9, R17–R19 detail |
| Harness protocol, per-harness mappings, discovery, auth posture, two-tier LLM | [[Wingman Harness Adapter Protocol]] | §1 protocol, §3 discovery, §5 disagreement (as amended), §6 persistence |
| Claude adapter verdict, capability layers, batching budget, N=3 redesign | [[reviews/wingman-adapter-licensing-codex-adjudication]] | R2, R10, R6, R13 detail |
| Auth ladder, GraphQL/REST split, publish pipeline, polling, SSO | [[Wingman GitHub Integration Plan]] | All of it stands as written (minus route-handoff line, R15) |
| Licence mechanics, signing/notarization, updater, CI/CD, contribution policy | [[Wingman Distribution and Licensing Plan]] | R3–R5, R14, R22 detail; §5 dependency audit |
| Repo layout, gates, tsconfig strategy, CLAUDE.md draft, first 20 commits | [[Wingman Repo Bootstrap Plan]] | The build sequence; CLAUDE.md regenerated per R2/R5/R22 |
| Settings ladder, records, trust gate, discovery, context pipeline, first run | [[Wingman Settings and Setup Plan]] | §1–§6 stand; §1.3 amended by R12 |
| Materialization, tiers, degraded detector, position mapping, editor launch | [[Wingman LSP Integration Plan]] | L1–L16 stand as written |
| DSL documents, anchors, validator, routing matrix, instruction layer | [[Wingman Surfacing DSL and Model Routing Plan]] | §1–§7 stand; R12/R13 ratify its two requests |
| Rendering verdict and numbers | [[Wingman Spike – Pierre Diff Virtualization]] | R16, R25 |
| Identity package, voice, namespace checklist, launch motions, RAI-ONLY list | [[Wingman Branding Plan]] | Registration mechanics; §4 alibi line amended by R15 |
| Build backlog for Navi | [[Rennet Navi Handoff]] | The sequenced bead list, working agreement, RAI-ONLY actions |
