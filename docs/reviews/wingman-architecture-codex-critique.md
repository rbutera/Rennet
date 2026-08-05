---
categories:
  - "[[Projects]]"
tags:
  - wingman
  - reviews
  - architecture
created: 2026-08-04
---

# Wingman Architecture Plan — Codex adversarial critique (2026-08-04)

Independent cross-model review of [[Wingman Architecture Plan]] against [[Code Review Harness App]] and [[References/Desktop and Mobile Stack 2026]]. Codex read all three files directly (provenance log confirmed full reads). Verdict: **not safe to hand to an autonomous builder yet.** Findings feed the Fable synthesis pass that produces the single authoritative Rennet architecture doc.

Context note from the synthesis owner: Codex read the hub mid-evening; Rai's latest calls (route handoff DESCOPED, both modes v1, omp ratified, name = Rennet) partially supersede the hub line Codex cites for "author-side fronts v1". The reconciliation must take Rai's 2026-08-04-evening decisions as the top of the stack.

## Stop-ship: plan is stale against the hub

Plan still instructs: `@wingman/*` names, protocol/types inside AGPL `core`, bundled proprietary Claude Agent SDK, disagreement deferred, author-side deferred. Hub (later, same day) ratifies: Rennet; Apache-2.0 `packages/protocol` + `packages/types`; CLI child-process Claude adapter; disagreement in v1. Reconcile D1, D2, D12, B1, B4, B18 and the v1 table before any scaffold commit.

## (a) Hunk identity — concrete failures of the three-tier scheme

Key `hash(newPath, enclosingSymbolPath, normalized ± body)` with same-file/same-symbol similarity partitions fails on: file rename; enclosing-symbol rename; move between symbols; split hunk (one→many lineage inexpressible); merge hunk (many→one); duplicate identical edits in one symbol (same key twice — the "twelve files" test misses same-file collision); ambiguous similarity with no assignment/tie-break/fail-closed rule; whitespace normalization in whitespace-significant contexts.

Prescription: immutable occurrence IDs + lineage graph (exact/one-to-one/split/merge/move/ambiguous/rejected) + path/symbol as weighted evidence not hard partitions + max-weight bipartite matching + **never auto-carry "read" through similarity** (possible-continuation state, require reread; ambiguity fails closed) + contextual disambiguator for duplicate bodies.

## (b) Event sourcing and publishing underspecified

Missing events: patch computation failed/cancelled/truncated; match ambiguous/confirmed/rejected/split/merged; review abandoned/superseded/attached-to-new-PR; edits/deletes; decomposition proposed/accepted/rejected as one atomic version; external GitHub state changes; publish cancelled/superseded/retry/outcome-unknown/reconciled; command dedup. `hunk.regrouped` too small a primitive for LLM decomposition proposals.

Migrations: upcasts must chain v1→v2→v3 with every historical schema + golden event streams in tests; unknown future event types fail safe.

Privacy: one digest test ≠ "structurally incapable". Split telemetry from state (`hunk.readStateChanged` vs `telemetry.hunkDwellRecorded`), then property-test noninterference: vary/insert/delete/reorder private events, rebuild projections from zero, assert exact canonical outbound bytes identical.

Publish idempotency: local digest is not a server-side idempotency key. Connection drop after GitHub accepts → retry posts duplicate review. Need `outcome: unknown` state + deterministic marker in the pending review + query-before-retry, tested with failure injection at every remote boundary.

## (c) Diff pipeline cliffs

Byte ranges into a JS string corrupt on non-ASCII (keep bytes: Uint8Array/spool file, index without copying). Domain parser and Pierre both parse the patch. Memory multiplication (patch + line objects + tree-sitter trees + tokens). Tree-sitter: parse once per file, dispose aggressively. O(k²) similarity explodes in generated/repetitive files. 1,000-line single hunk violates the 400-LOC thesis if hunks are never split. Binary/submodule/mode-only/truncated inputs have no hunks — residue assertion can report full coverage while silently excluding changed files; **done and publish must block on incomplete ingestion**. Pierre spike must measure the whole path (ingest→parse→identity→IPC→highlight, peak RSS, time-to-first-reviewable-chunk, cancellation), not scroll FPS alone.

## (d) Deterministic-authoritative chunking rejected

Deterministic fallback correct; deterministic-authoritative is optimizing golden-file determinism over semantic quality, and decomposition quality IS the product. Failure: migration+DTO+service+UI+tests renders as five file-local chunks instead of one vertical decision slice. Hybrid model: deterministic totality/classification/limits/provisional view → harness proposes complete versioned decomposition graph with rationale → deterministic validator rejects omissions/duplication/oversize/invalid anchors → user accepts/edits → offline keeps fallback. Test invariants + labelled dependency pairs + regroup count + blinded preference, not golden text.

## (e) Expensive LATER retrofits

Working-tree→PR review lineage (durable identity independent of ChangesetKey + source-attachment events) — retrofit changes identity throughout the store. Disagreement provenance (model/config/version, repeated-run identity, finding correlation, stochastic baseline) must exist before the FIRST adapter fixes the protocol. LLM decomposition proposal/revision data model now, implementation later. Mobile transport primitives (reconnect, replay cursor, capability negotiation, versioning, backpressure) can't be retrofitted into an Electron-only request/reply API. Protocol/types split and CLI Claude adapter at scaffold time. One fake second adapter in v1 so the protocol isn't Claude-shaped.

## (f) Portable boundary still assumes Electron

Zod/TS command defs aren't language-neutral (generate JSON Schema/IDL, test wire fixtures both sides). MessageChannelMain/utilityProcess topology belongs in the Electron host, not the FROZEN portable contract. Protocol lacks version negotiation/capabilities/structured errors/reconnect/replay/flow control. `RepoId = realpath(git-common-dir)` is machine-local — breaks on move/reclone and can't identify a repo to mobile; use internal UUID + path aliases + forge identity. Path-bearing models leak local paths to remote clients. No SecretStorePort shown. Raw EventEnvelope as ServerEvent risks sending private events to clients — subscriptions need recipient-specific projections.

## Top 3 risks → cheapest spikes

1. **False hunk continuity** (silently carries state/threads to wrong code): build the matcher alone; mutation fixtures (rename/move/dup/split/merge/ambiguous) + 10-20 real patchset pairs; measure auto-match precision and recall separately; auto-carry requires ~100% precision; ambiguity fails closed.
2. **Privacy/publish claims fail under replay or network uncertainty**: minimal SQLite event log + one projector + fake GitHub transport with failure injection before/after acceptance; property-test replay, chained upcasts, rebuild, private-event variation, exact outbound bytes, duplicate commands, timeout reconciliation.
3. **Deterministic chunks semantically mediocre, erasing the wedge**: 8-12 representative large PRs; deterministic vs harness-first vs validated-hybrid; blind comparison on regroups, missed dependency pairs, time-to-explain, preference.

Zero-code reconciliation pass FIRST: one authoritative Rennet architecture document.
