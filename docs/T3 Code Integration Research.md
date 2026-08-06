---
tags: [rennet, research, licensing, harnesses]
categories: [research]
status: active
created: 2026-08-06
updated: 2026-08-06
related: ["[[Rennet Master Plan]]", "[[Wingman Harness Adapter Protocol]]", "[[Wingman Distribution and Licensing Plan]]"]
---

# T3 Code Integration Research

> [!IMPORTANT] ✅ This investigation triggered a decision, and the decision has been MADE
> **Rai decided on 2026-08-06: Rennet goes MIT and ADOPTS the Anthropic Agent SDK.**
> This document is preserved as the analysis that produced that decision, so ⚠️ **§3a, §3b and §3d
> below reason about an AGPL-3.0-only Rennet that no longer exists.** Read them as the argument, not
> as current rules.
>
> **What changed as a result:** §3d identified the blocking finding — T3 Code's Claude adapter links
> the proprietary Anthropic SDK, which AGPL could not permit. ⭐ **That blocker is gone**, not because
> the SDK's licence changed but because Rennet's did. And the auth trace gathered here is now the
> **evidence Master Plan R2's reversal rests on**: `query()` spawns the user's own installed `claude`,
> so it authenticates on their Claude subscription and costs nothing per token.
>
> ⭐ **The core verdict is unaffected and still stands: adopt-partial, not a T3 core.** Every reason in
> §7 except the licence one was architectural — no cross-harness orchestration, no structured output,
> none of the review product — and none of those changed. See Master Plan §2.2.

Investigation into whether **T3 Code** can serve as the basis of Rennet's harness-orchestration core, and whether it can shortcut planned Rennet features.

**Every claim below is pinned to a source.** All repository reads were taken against commit
`a2ca89aa10f13a2222e08afd98c66285121d5ba2` of `pingdotgg/t3code` on 2026-08-06. Where a file is
cited, that is the tree it was read from.

**Headline:** the shape is a genuine and surprising convergence, the licence is clean, and the
recommendation is nevertheless **adopt-partial (reference architecture + two or three vendorable
components), not adopt-as-core.** One finding is blocking for the core path, and it lands on the
single component Rennet needs most.

---

## 1. What T3 Code is

### Identity

| | |
|---|---|
| Repository | `https://github.com/pingdotgg/t3code` |
| Copyright holder | T3 Tools Inc. (Theo Browne / Julius, the Ping team) |
| Licence | **MIT** — `https://github.com/pingdotgg/t3code/blob/main/LICENSE` |
| Product sites | `https://t3.codes` (desktop), `https://app.t3.codes` (web) |
| Distribution | GitHub Releases, `winget install T3Tools.T3Code`, `brew install --cask t3-code`, AUR `t3code-bin`, `npx t3@latest` |
| Mobile | iOS App Store `id6787819824`, Google Play `com.t3tools.t3code` |
| Scale | "over 100,000 users who love T3 Code" (`AGENTS.md`) |

### What it actually does

Its own README opens: *"T3 Code is an 'agent harness control surface'. It enables control of the
agents on your machine."* `AGENTS.md` is blunter: *"T3 Code is a minimal GUI for coding agents. A
Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves
web, desktop, and mobile clients."* It positions itself as *"an open source 'bring-your-own-
subscription' alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor."*

So the family resemblance to Rennet is real and not superficial: **both are local-first control
surfaces over the coding harnesses the user has already installed and already pays for.** That is
the same insight, arrived at independently.

### Architecture (`docs/internals/overview.md`, `docs/internals/providers.md`, `docs/internals/glossary.md`)

- **Server is the execution boundary.** *"every provider process, terminal, git operation, and
  filesystem read happens there, never in the client."* Clients (web / Electron desktop / React
  Native mobile) talk to it over **one authenticated Effect RPC WebSocket**.
- **Orchestration is event-sourced.** Clients dispatch typed commands; a **totally ordered** single
  worker fiber processes each `CommandEnvelope`: check the durable command receipt for idempotency
  → run a **pure, side-effect-free decider** → in **one SQL transaction** append events, apply them
  to the in-memory read model via the projector, project into persisted tables, write the accepted
  receipt → commit, swap the read model, publish to subscribers. *"Because persistence and
  projection share a transaction, the read model cannot durably disagree with the event log."*
- **Provider drivers.** Five ship built in (`builtInDrivers.ts` → `BUILT_IN_DRIVERS`): `codex`,
  `claudeAgent`, `cursor`, `grok`, `opencode`. A driver declares `driverKind` + `configSchema` +
  `create`; adapters conform to `ProviderAdapter.ts`. `ProviderInstanceRegistry` owns live
  instances, `ProviderAdapterRegistry` resolves instance → adapter, `ProviderService` routes
  *"session and turn operations without knowing which agent is behind them."* There is a
  `ProviderAdapterCapabilities` type.
- **Drainable workers.** Three queue-backed reactors (`ProviderRuntimeIngestion`,
  `ProviderCommandReactor`, `CheckpointReactor`) built on `DrainableWorker`, which pairs a
  transactional queue with a transactional count of outstanding items so *"a test can await 'queue
  empty and current item finished' instead of sleeping."*
- **Checkpointing.** *"Each turn is bracketed by workspace checkpoints so diffs and reverts are
  exact."* `CheckpointStore` writes **hidden Git refs**; `CheckpointDiffQuery` answers turn and
  full-thread diff requests; `CheckpointReactor` coordinates baseline capture, completed-turn
  capture, diff projection, and reverting **both the workspace and the provider conversation**.
- **Vocabulary.** `project` / `thread` / `turn` / `session` / `activity` / `command` / `event` /
  `decider` / `projector` / `reactor` / `receipt`. A **turn** is *"a single user-to-assistant work
  cycle inside a thread"* — the same word for the same thing Rennet's adapter protocol means.
- **Runtime modes** (`approval-required`, `auto-accept-edits`, `auto`, `full-access`) and
  **interaction modes** (`default`, `plan`).
- **ACP.** `packages/effect-acp` exists and `apps/server/src/provider/acp/AcpAdapterSupport.ts`
  imports from `effect-acp/errors`. So there is a working Effect-flavoured Agent Client Protocol
  implementation in-tree.
- **Not in scope for Rennet's shape:** T3 Connect, a hosted **tunnel/relay** product (Cloudflare
  tunnels + Postgres, per `docs/internals/t3-code-connect-auth-flow.html`), and
  `apps/server/src/telemetry/AnalyticsService.ts`.

### Stack

Effect-TS throughout (`Effect`, `Layer`, `Fiber`, `Schema`, `Stream`, `Queue`, `Deferred`, `Cause`
— `AGENTS.md`: *"Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code"*),
Effect/Schema contracts in `packages/contracts`, React + Vite web, Electron desktop wrapping the
web app **and bundling the server runner**, React Native mobile, SQLite, **Vite+ (`vp`)** as the
build/test/lint driver, **oxlint** (plus a first-party `oxlint-plugin-t3code`), TypeScript native
preview + `@effect/tsgo`, pnpm **11.10.0**, Node `^24.13.1`, and a **Rust** component at
`native/resource-monitor` built with cargo.

Licences of the toolchain, checked at the npm registry: `vite-plus` MIT, `effect` MIT,
`@effect/tsgo` MIT, `oxlint` MIT. None of these is a licence problem.

---

## 2. Licence verdict — CLEAN

**T3 Code is MIT, verbatim and unmodified.** Read from the file itself, not from a claim about it:

> MIT License
> Copyright (c) 2026 T3 Tools Inc.
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software…

No Commons Clause, no BSL, no "additional terms", no field-of-use restriction, no non-compete
rider. Rai's belief that T3 Code is *"super permissive about reusing it, forking it, or adapting
it"* is **confirmed at the licence level**, and the README backs the intent: *"If we ever go the
wrong direction, we want you to have everything you need to fork and build the editor that you
want."* They note *"A large number of our users run forks."*

**Caveat that is about relationship, not law.** `CONTRIBUTING.md`: *"We are not actively accepting
contributions right now… there is a high chance we close it, defer it forever, or never look at
it."* And *"Large PRs… Opinionated rewrites… Anything that expands product scope"* are the least
likely to be accepted. So any adoption is a **hard fork of a fast-moving project**, with no
upstream path for Rennet-shaped changes. Rebase cost is permanent and unshared.

---

## 3. Licence-compatibility verdict — COMPATIBLE, with one blocking exception inside the code

### 3a. MIT into AGPL-3.0-only core: fine

`Wingman Distribution and Licensing Plan.md` §4.4 already rules on exactly this case:
*"MIT-into-AGPL is uncontroversially fine — MIT is a lax permissive licence with no terms AGPL
cannot satisfy. Attribution is the only obligation."* The plan even has a worked precedent (the
Orca vendoring): quarantine in a marked `…/vendor/<name>/` directory, per-file SPDX headers
**preserving T3 Tools Inc.'s copyright, not Rai's**, a scoped `REUSE.toml` overriding the repo
default to MIT for that path, `LICENSES/MIT.txt`, and a generated `THIRD-PARTY-NOTICES.md` copied
into the app bundle. Its ruling holds here verbatim: *"Do not relicense those files to AGPL. The
combined work is AGPL, but the vendored files stay MIT and remain extractable under MIT by anyone.
Both statements are true at once."*

### 3b. MIT inside the Apache-2.0 `protocol`/`types` packages: fine, but check the rule you actually have

The "import nothing in-repo" rule is about **AGPL contamination and in-repo dependency direction**,
not about permissive code. §5 Notes: *"`packages/protocol` and `packages/types` must genuinely
contain no AGPL-derived code… those two packages may depend on nothing inside the repo."* MIT and
Apache-2.0 are mutually compatible permissive licences, so vendored MIT under the same §4.4
quarantine could sit inside them. **The docs never test this specific case**, so treat it as an
inference, not a settled ruling — if it ever becomes load-bearing, decide it explicitly.

### 3c. Dual licensing: NOT threatened

This was the crux worth checking, and it comes out clean. §4.3: *"Dual licensing works on exactly
one thing: Rai owns 100% of the copyright in the AGPL code."* The threat model there is **inbound
contributions without an explicit grant** — *"a fifteen-line PR from a stranger, merged without a
grant, is enough to make the commercial licence unofferable over that file forever."* Incorporating
a permissively-licensed third-party codebase is a **different act**: MIT expressly grants the right
to *"sublicense, and/or sell"*, so Rai can offer a commercial licence over a work containing
vendored MIT, provided the MIT notice ships. Adopting T3 Code does not close the commercial door.

### 3d. ⛔ THE BLOCKING FINDING: T3 Code's Claude adapter links the proprietary Anthropic Agent SDK

This is the one that decides the recommendation.

**Evidence, four independent points:**

1. `apps/server/package.json` declares a direct runtime dependency:
   `"@anthropic-ai/claude-agent-sdk": "^0.3.170"`.
2. `apps/server/src/provider/Layers/ClaudeAdapter.ts` (152,809 bytes, ~4,526 lines) imports from it
   at line 22, and **`query` is a runtime value import, not a type**:
   ```ts
   import {
     type CanUseTool,
     query,
     type Options as ClaudeQueryOptions,
     type PermissionMode,
     type PermissionResult,
     …
   } from "@anthropic-ai/claude-agent-sdk";
   ```
   Its own module docstring: *"Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the
   generic provider adapter contract."* `ClaudeProvider.ts` and `ClaudeAdapter.test.ts` import from
   it too.
3. **The SDK is not open source.** Its npm `license` field is the string
   `"SEE LICENSE IN README.md"` (registry `@anthropic-ai/claude-agent-sdk`, v0.3.223) — contrast a
   positive control, `zod`, whose field reads `"MIT"`, proving the reader works. The GitHub repo
   `anthropics/claude-agent-sdk-typescript` **has no LICENSE file at all** (HTTP 404; control:
   README at the same path returns 200, so the 404 is a real absence). Its README §"License and
   terms" reads: *"Use of this SDK is governed by Anthropic's Commercial Terms of Service."*
4. Rennet has **already ruled on this exact dependency and removed it.** Master Plan **R2** retired
   the SDK: *"The SDK is proprietary and AGPL-incompatible; the Claude adapter is a clean-room
   process-per-turn wrapper over the user's installed `claude`… never importing the SDK or its
   types."* The adapter plan says by name: *"Do not implement `CanUseTool` or import SDK types."*
   `CLAUDE.md` line 18 states it as a fixed boundary: *"Never import or bundle the Claude Agent
   SDK."*

**Why T3 Code can do this and Rennet cannot.** MIT has no copyleft, so combining MIT code with a
proprietary SDK and distributing the result is unremarkable. AGPL-3.0-only cannot: distributing a
combined work containing an AGPL part and a proprietary part Rai has no right to relicense is
precisely what R2 exists to prevent. **The incompatibility is structural, not incidental — it
follows from the licence Rennet chose.**

**Consequence, and it is the sharp end of this whole report.** The `claudeAgent` adapter is the
single component Rennet needs most: Claude CLI is the *only* adapter in the M0 Dogfood cut, with
codex and omp explicitly deferred to "Later". It is also the largest and most mature adapter in the
T3 Code tree. **It is the one file that cannot come across.** Adopting the core means deleting
~4,500 lines of the most valuable thing in the repository and writing the clean-room replacement
Rennet had already planned to write — so the shortcut evaporates *exactly* where Rai hoped it would
help most, and nowhere else in the tree makes up the difference.

Two secondary consequences worth stating: a fork inherits a build script
(`scripts/build-desktop-artifact.ts`) whose packaging logic exists specifically to trim the SDK's
~200MB platform executables, and inherits tests asserting that behaviour — all of which becomes
dead code on removal. And any future upstream sync would keep reintroducing the dependency.

---

## 4. Fit assessment

### 4a. Rai's belief, tested

> *"T3 Code can handle the orchestration and the different harness handoffs."*

**This is a misread, and the distinction matters.** T3 Code **multiplexes** providers; it never
makes them **collaborate**.

The evidence is architectural and explicit. `ProviderService` *"routes session and turn operations
for a thread, so callers name a thread, not an agent"*, and the orchestration layer *"does not know
which one is behind a thread."* One thread → one session → one provider. That is **routing**, and
routing is the opposite of the orchestrator model: T3 Code's design goal is that the identity of
the agent becomes invisible, whereas Rennet's orchestrator model requires one harness to *know
about, receive from, and synthesise across* the others.

A code search for cross-provider synthesis or adjudication (`multi-provider`, `crossProvider`,
`"second opinion"`, `adjudicat`) returns **zero hits**; a positive control (`ProviderAdapter`)
returns **40**, and a docs-scoped control (`checkpoint`) returns 6, so the zero is real and not a
broken search. There is no concept anywhere of a harness reading another harness's output, no
disagreement model, no claim-identity matching, no N-sample variance separation.

So **the entire orchestrator layer — the thing Rai hoped to inherit — is the thing Rennet must
still build.** Multi-harness review, adjudication, `notEmittedBy` silence, within- vs
between-harness variance (Master Plan R6): none of it exists here, in any form.

The **review→agent handoff** is a partial exception and the most interesting near-miss — see 4c.

### 4b. What genuinely does NOT exist in T3 Code (i.e. what Rennet still builds, all of it)

The product is absent. T3 Code is a harness for **writing** code; Rennet is a harness for
**reading** it. None of the following has any counterpart in the tree:

- The six **angles** (spec / sequence / decisions / claims-and-evidence / blast radius / noise).
- **Review state**: dispositions, read/skimmed state, sticky dismissal, the totality/residue
  guarantee, severity floors, findings queues.
- **Occurrence-ID + lineage-graph hunk identity** (R8) — the matcher, the fail-closed ambiguity
  rule, read state surviving a force-push. This is Rennet's hardest engineering problem and its
  worst failure mode; nothing here touches it.
- **Hybrid decomposition** (R9): the deterministic floor, the versioned decomposition graph, the
  validator that rejects omissions/duplication/oversize/invalid anchors.
- **The surfacing DSL / RSP** — envelope, provenance, anchors, byte-verified quotes, closed
  vocabularies, validator-as-pure-function.
- ⛔ **Structured output / constrained decoding.** A code search for `json-schema`, `outputSchema`,
  and `structuredOutput` returns **zero hits** across the repo (same 40-hit positive control). T3
  Code streams assistant **text deltas** and buffers them (`MAX_BUFFERED_ASSISTANT_CHARS = 24000`).
  Rennet's engineering thesis leg 1 — *"a wrong model produces an invalid document, not a wrong
  review"* — and the adapter plan's *"structured output is mandatory, not optional"* have **no
  foundation whatsoever** in this codebase.
- **Model-tier routing**, the `RoutePlan` budget gate, the <15s / <5-invocation product budget,
  utility batching.
- **The instruction layer**: versioned base instructions, the settings ladder, `append` merge, the
  trust gate, the inspectable assembled prompt.
- **GitHub publish**: batch → sign → submit, idempotency, outcome-unknown reconciliation, the
  degradation ledger, the two sheet variants.
- **Read-only sandbox posture.** T3 Code's runtime modes exist to *grant* write access
  (`auto-accept-edits`, `full-access`); Rennet's §3.4 requires deny-by-default with
  *"an unexpected write/exec request fails the turn closed"*. The polarity is inverted.
- **Context manifests / materialisation / egress disclosure** (R31), **LSP tiers**, **`.rennet/`
  snapshots and freshness gating** (R27/R30), **physical review purge** (R32).
- **Capability flags earned by a conformance suite.** T3 Code has `ProviderAdapterCapabilities`,
  which is real convergence, but nothing resembling *"A flag nobody tested is a claim, not a
  capability."*

### 4c. What T3 Code genuinely could shortcut

Three things, and they are worth real money — as **reference implementations and targeted
vendoring**, not as a core.

1. ⭐⭐ **Checkpoint-as-hidden-git-ref, and the turn diff.** This is the strongest find in the whole
   investigation, and it lands on a question Rennet has open rather than solved. The **review→agent
   handoff** loop needs to bracket an agent's work and produce a new patchset from it. T3 Code
   already does exactly that in production: baseline checkpoint on turn start, capture on turn
   completion, `CheckpointDiffQuery` for turn and full-thread diffs, and revert of **both the
   workspace and the provider conversation**, all as hidden Git refs so the user's branch and
   reflog stay clean. `CheckpointStore.ts`, `CheckpointDiffQuery.ts`, `CheckpointReactor.ts`,
   `Diffs.ts`, `checkpointing/Utils.ts`. Rennet's own contracts (R28: every review targets an
   immutable `Patchset`; a local edit creates a new patchset) want a mechanism of this exact shape.
   **Read this before designing the handoff loop.** It is also the piece most cleanly extractable
   under §4.4 if outright vendoring is ever wanted.
2. ⭐ **The event-sourced spine as a validated reference.** Command → durable receipt → pure decider
   → single SQL transaction (append + project + receipt) → post-commit read-model swap → publish.
   This is R17's design, running under 100,000 users. Rennet should **read** `OrchestrationEngine.ts`,
   `decider.ts`, `projector.ts`, and `commandInvariants.ts` as a worked example — especially the
   dispatch-failure reconciliation (reread persisted events past the starting sequence) — rather
   than import them. Independent convergence on the same architecture is meaningful evidence that
   R17 is right.
3. ⭐ **`DrainableWorker`** (`packages/shared/src/DrainableWorker.ts`), and the rule that goes with
   it: *"Wait on receipts and worker drains, never on sleeps or polling. A test that needs a
   timeout to pass is wrong."* A transactional queue paired with a transactional outstanding-count,
   so `drain` means "queue empty **and** current item finished". Small, self-contained, MIT,
   directly useful to Rennet's gates and spikes. **The clearest vendoring candidate in the repo.**

Lesser: `effect-acp` is a working MIT ACP implementation if the omp/ACP adapter slot ever wants
one; and the provider discovery + `ProviderAdapterCapabilities` model is worth reading as
corroboration of Rennet's capability-flag design.

### 4d. Architectural collisions if adopted as core

Independent of the licence blocker, six mismatches — each individually survivable, collectively
decisive:

| # | Collision | Detail |
|---|---|---|
| 1 | **Client/server split** | T3 Code's spine is a WebSocket server with remote clients, a tunnel product, and `AnalyticsService.ts`. Rennet is **no backend, no telemetry**, Electron `MessageChannelMain` IPC, with the mobile client a *peer of the renderer* over a frozen transport-neutral contract (R19/R20). Adopting the core means adopting the server topology as the spine and then removing the reasons it exists. |
| 2 | **Effect-TS is total, not incremental** | Effect is a runtime (`Effect`/`Layer`/`Fiber`/`Schema`/`Stream`), and `packages/contracts` is Effect/Schema. Rennet's own dependency research chose **Zustand + narrow XState + zod + a hand-written ~200-line typed IPC layer**, with an explicit rule against state-library sprawl. Adopting T3 Code means adopting Effect wholesale — a legitimate choice, but it **replaces** the dependency research rather than shortcutting it, and Effect/Schema would displace zod through the contracts. |
| 3 | **Package DAG** | Rennet's `packages/{types, protocol, core, adapters, ui, instructions, tsconfig}` boundary is enforced twice (oxlint/Biome `noRestrictedImports` **and** `scripts/check-boundaries.mjs`, fixture-tested in both directions), with `ui` forbidden from importing `core`. "Adopt an existing app as the core" is structurally opposed to a model in which Rennet owns `core` and every external thing is a wrapped subprocess. |
| 4 | **Toolchain divergence** | T3 Code: pnpm 11.10.0, **Vite+ (`vp`)**, oxlint, `@effect/tsgo`, plus a **Rust/cargo** `native/resource-monitor`. Rennet's research pinned pnpm 10.32.1 exact with `engine-strict`, Vite 8 + Electron Forge 7, **Biome**, Vitest 4, and an explicit "no native deps" rule chosen to avoid `@electron/rebuild` churn. All MIT, so no licence issue — but a fork inherits a Rust toolchain requirement and a build driver Rennet did not choose. |
| 5 | **Licence hygiene surgery** | Every adopted file needs an SPDX header preserving T3 Tools Inc.'s copyright, scoped `REUSE.toml`, `LICENSES/MIT.txt`, and generated `THIRD-PARTY-NOTICES.md`, all `reuse lint`-enforced. Mechanical, but it is per-file, at fork scale. |
| 6 | **Sandbox polarity** | Their permission model exists to grant write access; Rennet's exists to deny it. Rewiring that is not a config change — it is a different product stance about what a harness is for. |

---

## 5. Assessment of the overnight commit

Commit `d9172fc` "Initialise Rennet monorepo", 2026-08-05 21:17:12: **92 files, 27,571 insertions,
0 deletions.** Working tree clean (verified through `rtk proxy` as well as directly, because
`git status --porcelain` through the shell here rewrites the empty case).

**There is zero product implementation code, so there is nothing to throw away.** Breakdown:

| Area | Content |
|---|---|
| `docs/` | 48 markdown files, **12,230 lines** — the bulk of the commit |
| `prototypes/` | 3,974 lines of static HTML (moodboard + archived mockups) + one 285-line vanilla JS file. A clickable design mockup: no framework, no build target, no tests |
| `spikes/` | 1,939 lines across 13 JS/TS/JSX files (Electron + `node:sqlite`, LSP ladder, event-store fold/replay, Vite+React diff virtualisation). **Deliberately excluded from the workspace** by `pnpm-workspace.yaml` |
| `apps/`, `packages/`, `scripts/` | **Stub READMEs only** (3, 11, and 3 lines). None of `apps/desktop` or `packages/{types,protocol,core,adapters,ui}` exists on disk |

This is a genuinely useful fact for the decision: **the layout is described in docs, not committed
to in code.** Whichever way the T3 Code question goes, no implementation work is discarded.

### The dependency research (preserve through any rewrite)

Three files in `docs/References/`, all dated 2026-08-04, all `categories: [research]`:

- **`docs/References/Desktop and Mobile Stack 2026.md`** (551 lines, ~51KB) — the core
  dependency-selection document. Live registry/API-verified across Electron 43 + Forge 7 + Vite 8,
  git plumbing (system `git` via spawn; rejects nodegit/simple-git/gitoxide), SQLite (`node:sqlite`
  vs `node-sqlite3-wasm`; rejects `better-sqlite3`), state (Zustand + narrow XState), build
  (tsdown over tsup), lint (Biome), testing (Vitest 4 + Playwright), typed IPC (hand-written
  zod-based; rejects electron-trpc), auto-update, crash reporting, mobile/Expo.
- **`docs/References/Code Review Tools Market.md`** (276 lines, ~25KB) — competitive landscape.
- **`docs/References/Orca and Paseo Pairing.md`** (364 lines, ~35KB) — mobile-desktop pairing
  crypto research; **already the precedent for the §4.4 MIT-vendoring discipline** this report
  relies on.

Also `docs/research/` (~700 lines, three lens-validation / market-validation files) — product
validation rather than dependency research, flagged in case it is also wanted.

**~1,900 lines / ~186KB total. Carry these forward untouched.** Note that adopting T3 Code's core
would **invalidate large parts of `Desktop and Mobile Stack 2026.md`** — Effect/Schema displaces
zod, Vite+ displaces Vite 8 + Forge, oxlint displaces Biome, and the hand-rolled IPC section
becomes moot. That is a real cost of the adopt-as-core path: it does not shortcut the dependency
research, it discards it.

### Scaffold choices that would conflict with a T3-Code-based core

`pnpm@10.32.1` exact + `engine-strict=true` + `save-exact=true` (theirs: pnpm 11.10.0); Node
`24.16.0` exact (theirs `^24.13.1` — compatible); Biome-only vs their oxlint; Vite 8 + Electron
Forge 7 vs Vite+; the enforced package DAG; SPDX/REUSE lint; and — sharpest — `CLAUDE.md` line 18,
*"Never import or bundle the Claude Agent SDK,"* which T3 Code's Claude adapter violates directly.

**Effect-TS appears zero times anywhere in the Rennet repo.** It has never been evaluated. It is an
unknown quantity, not a considered-and-rejected one.

---

## 6. Tripwire register

`~/expedition/What We Already Tried.md` contains **no prior entry** for T3 Code, t3code, Theo
Browne, Ping/pingdotgg, ACP, Agent Client Protocol, Zed, Effect-TS, OpenCode, Conductor, Cursor,
"agent GUI", "orchestration framework", "agent framework", or adopting an existing app as a base.
Controls both ways: `Honcho` returns 15 hits (the register is real and readable), a fabricated
token returns 0 (zeros are genuine). The six apparent "Ping" hits are substring collisions inside
*pointing*, *keeping*, *scoping*, *mapping*, *wrapping*.

Part 2 of that register is entirely memory/task-backend/infra tooling. Per its own governing rule —
*"absence from this file is not evidence of rejection"* — **this is unexamined territory, not
declined territory.** There is no REVISIT-WHEN condition to check, because there is no prior entry.

---

## 7. Recommendation

### **ADOPT-PARTIAL.** Do not build Rennet on a T3 Code core. Do mine it deliberately, in three named places.

**Why not as core, in order of weight:**

1. ⛔ **The licence-compatible codebase contains a licence-incompatible component, and it is the one
   that matters most.** T3 Code's Claude adapter is built on the proprietary
   `@anthropic-ai/claude-agent-sdk`, which Rennet already ruled out in R2 and forbids by name in
   `CLAUDE.md`. Claude is the *only* adapter in the M0 Dogfood cut. Adopting the core means
   deleting the largest, most mature component in the tree and writing the clean-room replacement
   anyway. **The shortcut fails precisely where the hope was strongest.**
2. **The orchestration Rai wanted is not there.** T3 Code routes to one provider per thread and
   hides which one; Rennet needs harnesses that read each other. Multi-harness synthesis,
   adjudication, disagreement, variance separation: zero hits, real zero, positive controls in
   place. This is the layer Rennet must build regardless.
3. **No structured output anywhere.** Constrained decoding is leg 1 of Rennet's engineering thesis
   and the reason a wrong model yields an invalid document rather than a wrong review. T3 Code
   streams and buffers text. The DSL has no foundation to stand on here.
4. **It is a control surface for writing, and Rennet is a harness for reading.** Angles, review
   state, lineage identity, decomposition, findings, publish, deny-by-default sandbox — the entire
   product — is absent. What T3 Code supplies is the part Rennet was least worried about.
5. **Adopting the core discards the dependency research rather than shortcutting it**, and imports
   a server/tunnel/telemetry topology that Rennet's positioning exists to reject.
6. **It would be an unsupported hard fork** of a fast-moving 100k-user product whose maintainers
   have said in writing they will not take Rennet-shaped changes.

**What to do instead, concretely:**

- ⭐⭐ **Read `CheckpointStore.ts` / `CheckpointDiffQuery.ts` / `CheckpointReactor.ts` / `Diffs.ts`
  before designing the review→agent handoff loop.** Turn-bracketed hidden-Git-ref checkpoints with
  exact turn diffs and workspace+conversation revert are a production answer to the question
  Rennet's handoff loop is about to ask. This is the highest-value item in this report.
- ⭐ **Vendor `DrainableWorker`** under the §4.4 discipline (quarantine dir, SPDX preserving T3
  Tools Inc., scoped `REUSE.toml`, `LICENSES/MIT.txt`, `THIRD-PARTY-NOTICES.md`). Small,
  self-contained, and it brings the "no test passes on a timeout" rule with it.
- ⭐ **Read the event-sourced spine as corroboration of R17**, not as code to import. Independent
  convergence on command → receipt → pure decider → one transaction → projector is real evidence
  that the design is right.
- **Keep `effect-acp` on the shelf** against the omp/ACP adapter slot.
- **Do not** take the Claude adapter, the provider registry, the RPC/WebSocket layer, `contracts`,
  or the client runtime.

**One thing worth saying plainly.** The convergence here is not embarrassing, it is confirming.
Two independent teams looked at "the harnesses are already on the user's machine" and built the
same spine: event-sourced orchestration, provider adapters normalising native protocols into
canonical events, a capability model, turn as the unit, Electron desktop with a mobile peer. Rennet
arrived at that from first principles in planning; T3 Code arrived at it under 100,000 users. That
is strong evidence the architecture is sound — and it is a completely different claim from "the
work is already done." The overlap is the **substrate**. Rennet's product — reading a change you
did not write and being able to answer for it — starts above the line where T3 Code stops.

**A "no" here costs almost nothing.** The overnight commit contains zero implementation code, so
nothing is discarded either way; and this investigation converts one open question into a
checkpointing design lead and a vendorable utility. That is a good trade.

---

## 8. Residuals and limits of this investigation

- **Not measured:** T3 Code was never built or run locally. Every claim is from the repository at
  one pinned commit plus the npm registry. A build would test the Vite+/Rust toolchain cost claim,
  which is currently an inference from `package.json` scripts.
- **Zero-hit claims** (structured output; cross-provider synthesis) rest on GitHub code search with
  positive controls at 40 and 6 hits. GitHub code search can under-index large repositories; the
  architecture docs corroborate both zeros independently, but a local clone plus `rg` would settle
  them beyond doubt.
- **Not established:** whether MIT-vendored code inside the Apache-2.0 `protocol`/`types` packages
  is acceptable under Rennet's own rules. Inferred as fine (§3b); never ruled on. Decide explicitly
  before relying on it.
- **Not checked:** T3 Code's `.repos/` vendored read-only reference tree, which contains
  third-party sources under their own licences. Irrelevant to targeted vendoring; would matter for
  a full fork.
- **Trademark, not licence:** "T3 Code" and the T3 marks are not granted by MIT. Any derivative
  must not present itself as T3 Code. Not a concern for the recommended path.
