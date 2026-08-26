---
title: Board rebuild plan
description: Build order, workstreams, and the AFK dispatch loop for the murder-board redesign — whiteboard protocol, engine rework, client rebuild.
status: planned
tracking: https://github.com/rbutera/rennet/issues/489
---

This is the implementation plan resolved by
[Decide: implementation plan — protocol, engine, UI rework](https://github.com/rbutera/rennet/issues/489),
the terminal ticket of the
[murder-board wayfinder map](https://github.com/rbutera/rennet/issues/452).
The design is decision-complete: every workstream below implements closed
decision tickets, and no build wave may re-open one. Rule Zero governs: no
gates, no ceremony, agents write and push freely.

Canonical companions, all linked from the plan ticket:

- **Behavioral contract** — [`spikes/board-prototype/INVENTORY.md`](https://github.com/rbutera/rennet/blob/main/spikes/board-prototype/INVENTORY.md): 712 verifiable claims (the map's earlier "722" figure was a miscount). The spike has **zero code authority**; the inventory is its entire legacy, plus leaf JSX ported under the fence rules.
- **Target architecture** — three assets on the plan ticket:
  [engine](https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330),
  [client](https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569),
  and the [spike autopsy](https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732)
  with its 11-rule porting fence.
- **Loop research** — resolved on [#494](https://github.com/rbutera/rennet/issues/494).

## Verification contract

The plan is not done until every inventory line has a home. Mechanics:

1. A mechanical commit tags every `INVENTORY.md` line with its workstream
   (`[ws:C5]` style). A script asserts *every line tagged exactly once* —
   that assertion is the not-done test.
2. One GitHub checklist issue per client workstream is **generated from the
   tags** (markdown stays canonical; issues are a regenerable projection for
   tracking from a phone).
3. Build-time status lives in a root `BUILD-STATUS.json`: one entry per
   workstream, `passes: false` until its verification runs. Agents may only
   flip status fields, never edit entries — JSON chosen deliberately (models
   rewrite markdown too casually). The file is deleted when the build ends.

## The dispatch loop

Distilled from the loop research (Anthropic long-running-harness +
best-practices, Huntley's Ralph, Pocock's bounded AFK variant). The rules:

- **Fresh context per iteration.** Every implementing session starts clean and
  reads its state from disk. Never continue a filling session past its wave.
- **One workstream in flight per track; one task cluster per session.**
  Bounded iterations with an explicit completion sigil — never `while true`.
- **State lives on disk, not in context**: the OpenSpec change (tasks.md), the
  packet manifest, `BUILD-STATUS.json`, and git history are the only
  continuity. Assume interruption at any moment.
- **Session-start bearings** (standing text in every dispatched prompt): read
  the packet manifest, `git log` since the wave began, the change's tasks.md;
  run the smoke check; pick the highest-priority unfinished task; **search
  before assuming something is unimplemented**.
- **Verification closes the loop, not self-report.** `pnpm check` is the gate,
  plus each change's own end-to-end check (a positive control that can fail —
  for UI work that means driving the real app, not unit tests). Evidence is
  shown, never asserted. Placeholder implementations are named a failure mode
  in every packet.
- **Dual review per wave** (Opus + Codex seats, fresh contexts, diff + packet
  manifest only), fix loop until both pass. Reviewer findings are sorted under
  Rule Zero — a finding whose fix is a gate is dropped.
- **The repo out-votes the prompt**: conventions the build must keep are
  landed as code/lint early (element registry, kit-not-hand-rolled, no
  `bridge.invoke` in components), because agents copy the codebase harder
  than they obey instructions.

### The packet (per OpenSpec change)

Every change directory carries a `context.md` manifest — the implementing
agent's *entire* context authority, copied from this plan's workstream entry:

1. Objective + out-of-scope statement + completion sigil.
2. The decision tickets it implements (permalinks) and the ruling texts it
   answers to (the canonical R1–R70 comment on #458).
3. Its inventory slice (`[ws:*]` tag + section refs) — client tracks only.
4. Repo files to read: `CONTEXT.md`, relevant `docs/` pages, `packages/prompts`
   sources, spike paths (read-only) + the autopsy fence addendum — UI tracks.
5. The end-to-end verification step that proves the change works.
6. Docs pages the change invalidates (updated in the same change — definition
   of done).

## Orchestration topology

A master orchestrator drives three track orchestrators (Claude agent teams).
**Parallel only at frozen contract boundaries; serial within a track.**

- **Track A (whiteboard)** free-runs immediately — its own repo, zero overlap.
- **Track B (engine)** starts now on B1–B3 (pure Rennet work); B4 onward
  requires the **npm alpha** from A5.
- **Track C (client)** starts after B3 freezes the protocol shapes it consumes;
  C1–C2 may begin against existing commands + `MemoryBridge`.
- Worktree per agent, one nx invocation per worktree, mandatory worktree/daemon
  cleanup on merge (see CLAUDE.md).

Cutover posture (decided): **delete-first**. B2 executes the #459 deletion
census wholesale; `main` stays gate-green (compiles, tests pass) but the
product is mid-rebuild until Track C restores it. "Keep main releasable" is
deliberately suspended at the product level for this effort. No first-dogfood
milestone — waterfall to full inventory parity.

## Track A — whiteboard repo (`@whiteboard/*`, MIT, own monorepo)

Implements #453–#456; tracked at [#463](https://github.com/rbutera/rennet/issues/463).
OpenSpec lives in the new repo. Public from first commit.

| # | Change | Notes |
|---|--------|-------|
| A1 | bootstrap-monorepo | nx, MIT, `spec/` (SPEC.md + fixture corpus skeleton), CI |
| A2 | core-authoring | five tool shapes (#455), host-schema kit, Zod→wire, corpus |
| A3 | server-reference | append-only event log, projections; **must be embeddable in-process with pluggable persistence** — Rennet requirement, goes in SPEC.md before B4 starts |
| A4 | mcp-facade | stateless five tools, `get_events` polling + WebSocket |
| A5 | release-alpha | nx release → npm alpha. **Gate for B4.** |
| A6 | python-twins | full-fat symmetric twins, uv plugin, PyPI — trails, never blocks Rennet |
| A7 | docs + worked examples | kanban + diagramming examples |

## Track B — engine

Architecture per asset 1. Two packages die (`types`, `instructions`),
`lens-instructions` → `prompts`, none are born.

| # | Change | Implements / notes |
|---|--------|--------------------|
| B1 | types-into-protocol | Delete `packages/types`; 69 Zod schemas become source, types via `z.infer`. One unsplittable mechanical wave, first. Rewrites the CLAUDE.md package-boundary law. |
| B2 | canvas-deletion-cutover | #459 census, delete-first, **including the #459-vs-#464 KEEP reconciliation** (model-backed `*-generation` passes die; deterministic producers survive); `instructions` deleted; `prompts` rename; `app-ui/canvas` reduced to registrar/read-state/symbol (60 DOM tests deleted with the rest); mobile canvas route stubbed. |
| B3 | protocol-contracts | `protocol/{board,commands,session,delta,manifests}`: #462 host schema (13 kinds; `DraftBoardSchema` **derived** by omit + drift test), the **`LensBoard` projection shape** (missing today — blocks the board surface), #465 command registry table, **patchset span-read command** (citations hydrate from the captured patchset, never the checkout). **Gate for Track C proper.** |
| B4 | boards-runtime | Embed `@whiteboard/server` in-process, event log under `.rennet/`, `projection.ts` privacy wrap over board events, `adapters/whiteboard-client` (only writer of board ops). Blocked by A5. |
| B5 | delta-packet | `core/delta`: hunk index, element-diffs, collation/counterpart, blast-radius, openspec parse, noise pre-classify → `buildDeltaPacket()` (the drafters' entire input). `delta-account` → `successor-account`. |
| B6 | context-map-swarm | #460: partitions, light workers, verify seat, council job ids, incremental delta with carry. |
| B7 | related-context | #461: ref extraction, `gh` first-class, dossier shape, project-scout adapter, settings-ladder keys. |
| B8 | lens-pipeline | #464 + #493 + #486: drafter dispatch (warm sessions, structured returns), lint (19 rules, pure) + scoped-retry ladder (cap 10, blemishes exit), post-process, immutability check, mechanical + authored composition, every-hunk check, round-report seat. |
| B9 | session-rounds | #466: session as durable root, claim, cursor-resume harness, one-turn lock, rework queue, rounds state machine, idempotent pipeline starts. |
| B10 | commands-and-settings | #465 registry-bound dispatch (kills the 2,479-line switch), `app_*` in-process tools, #476 settings ladder + `client-settings.json`/`daemon-settings.json` split + `config.json` migration. |
| B11 | exits-backend | **Asks durable host-side per session** (decided), work-order composition, PR + GitHub two-strata review composition, idempotent push + open-PR. |

## Track C — client

Architecture per asset 2; every UI packet carries the autopsy fence addendum.
Standing laws: no component calls `bridge.invoke`; derive-don't-store; element
registry with `assertNever`; fixtures only as `MemoryBridge`.

| # | Change | Surface (inventory §) |
|---|--------|------------------------|
| C1 | client-foundations | data seam (`useCommand`/`useMutation`/`useCommandStream`; react-query subject to dependency standard, hand-rolled fallback behind same hooks), router + #480 route table, store slices, `MemoryBridge` rig (§2) |
| C2 | ui-kit-additions | six generic primitives; `collapse` + `resize-handle` ported under review |
| C3 | shell | frame, sidebar rewrite (projection-fed), top bar, chat dock outside the outlet + unmount test (§1, §5 shell) |
| C4 | review-machinery | shared `review/` layer: code blocks, line comments, selection toolbar, rich text over span-read (§3 partial) |
| C5 | board-surface | element registry (one file per kind), folds, quote threads, delta marks, generation drill-down (§3) |
| C6 | diff-view | ported under review, real comment wiring (§4) |
| C7 | chat | transcript on real streams (§5) |
| C8 | exits | FAB + asks + hand-off view + lanes + verdict, all state as selectors (§6) |
| C9 | rounds | run view, round report, ledger on `onProgress` (§7) |
| C10 | settings-help | pages ported, values real (§8) |
| C11 | command-menu | ⌘P/⌘K, the six advertised keybindings wired, remapping (§9, §14, R70/#492) |
| C12 | projects-flow | add-project, directory browser (reuse existing), scouting, context map, new-chat (§10) |
| C13 | onboarding | coach marks per R55, refs not selectors, client-settings persistence (§11) |
| C14 | conformance-sweep | §14 residue, inventory audit: every `[ws:*]` line verified in the running client, generated issues closed |

## Standing reconciliations

Carried into the packets so they cannot be lost:

- #459's KEEP list is stale where #464 overrode it — B2 reconciles explicitly.
- `@whiteboard/server` embeddability is a SPEC requirement, not an assumption (A3).
- Two derivation chains get drift *tests*: `DraftBoardSchema` from
  `HostBoardSchema`, and Zod → whiteboard wire.
- #493's warm-session concurrency cost model is falsifiable — B8 measures
  before trusting cap 10.
- Mobile board rebuild is out of scope: route stubbed in B2, fresh wayfinder
  effort after desktop ships.
- Docs: each change updates the pages it invalidates (definition of done);
  overall docs overhaul scope is [#490](https://github.com/rbutera/rennet/issues/490).

## Decision ledger

Grilled to agreement with Rai, 2026-08-26 (Q1–Q17 on the plan ticket): plan
doc + dispatch-time OpenSpec authoring; TS alpha before engine, Python trails;
delete-first cutover; designed rearchitecture with nothing precious on either
end, full license including surviving engine code; wave dispatch with dual
review; no dogfood milestone (waterfall); inventory homes as tags + generated
issues; mobile deferred; team-of-orchestrators with contract-gated
parallelism; architecture designed up front by parallel agents (assets 1–3);
asks durable; `types` deleted; old `app-ui/canvas` reduced to three modules.
