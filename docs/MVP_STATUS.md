# MVP status

**Snapshot: 2026-08-08.** This is an evidence-based implementation status, not a roadmap promise. Recent work must update this file when it changes what a reviewer can actually do; use the issue queue for work sequencing.

## Built and verified in the repository

| Area | Present now | Important limit |
|---|---|---|
| Local review | Desktop capture of committed branch, staged, unstaged, and nonignored untracked changes into immutable patchsets; raw diffs, provenance, action-defined read state, invalidation, and explicit regeneration | Pathological Git bytes, huge/binary materialisation, and full lineage calibration still have dedicated gates |
| Evented core | SQLite/WAL event store, receipts/idempotency, replay, unknown-event blocking, invalidation, read state, and fail-closed carry fixes | Physical purge must continue to be proved across every storage class |
| GitHub source | Host-owned `gh` auth, PR ingestion, SSO partial-result handling, local-diff-first capture, and pinned heads | Actual external batch publication/read-back is still approval-blocked |
| Review surfaces | Five canvases plus blast overlay, zoom/roll-up, real hunk material, coverage, CodeView syntax highlighting, anchored L3 marks, and authoring at multiple granularities | Several angles remain thin/partial and visual parity with the prototype is not yet proven |
| Decomposition | Deterministic ≤400-LOC floor, DAG/topological order, agent-owned comprehension ordering, RSP schema/validator, and a live pipeline | Quality comparison on a permitted corpus remains open |
| Dispositions | Span-grained approve/request-change/comment/question, action-defined read state, staged destination, and orphan handling | Refinement-loop completion and full outbound integration remain unfinished |
| Destination and preview | Editable collation draft canvas; publish sheet with author/reviewer variants, degradation-ledger content, refined-preview content, and a red-provable safety gate | It is still a preview; it does not perform GitHub publication or source pushing |
| Harness foundation | Discovery, Claude Agent SDK adapter, Codex utility seat, consent/permission controls at the main-process boundary, and context/run plumbing | Real provider turns, isolation/resume/schema/batching evidence, and additional adapters are gated |
| Orchestration | Lean map-not-container primer, protocol card, context-update stream, `canvasOps@2`, and a Model Council resolver with live budget enforcement/trace | Retrieval/knowledge quality and the experimental `context.ask` design need empirical validation |
| Desktop hardening | Sandboxed renderer, typed IPC, sender validation, restricted protocol/CSP, hardened Forge package checks, Nx gates and positive controls | Public signing, notarization, updater, and release automation are intentionally later |

## Evidence-gate ledger

| Gate | Status | Consequence |
|---|---|---|
| Local review desktop vertical slice | Closed for its MVP scope | Local capture and explicit invalidation/regeneration can support subsequent slices |
| Event-store and publish failure injection | Closed | Reuse its fixtures for production safeguards |
| Electron 43 `node:sqlite` | Closed | `node:sqlite` is the event-store choice |
| TypeScript LSP ladder | Closed for the TS promotion decision | The implementation still needs the cache-owned materialisation feature |
| Lineage matcher precision | Open | No similarity-based auto-carry beyond the fail-closed floor |
| Decomposition quality comparison | Open | Do not claim the product's grouping quality is proven |
| Cross-harness schema and live turns | Blocked by explicit spend approval | Do not unblock provider-dependent subsystems with assumptions |
| GitHub batch publication/read-back | Blocked by explicit approval for a throwaway remote mutation | Keep publication as preview only |
| Pierre target version/recycling | Partially blocked | Do not promote an unmeasured stable renderer version |
| Prototype comprehension | Open | Do not call the UI understandable until target engineers complete the scenario study |

## What remains deliberately planned

- Home/first-run experience that gives the review a clear beginning and exposes freshness beside work.
- Complete `.rennet/` project snapshots, settings/trust gate, and cache-owned LSP materialisation.
- Full claims/evidence, spec, noise, blast-radius, and LSP product depth—not merely their surface scaffolding.
- Comment refinement, real `context.ask` evaluation, calibrated lineage/relevance carry, and a permitted delta re-review loop.
- Real GitHub review publication, reconciliation/read-back, external approval flow, and visible provider disclosure at every required boundary.
- Prototype parity, accessibility, performance, and comprehension validation.
- Mobile companion, public-release signing/notarization/updating, and further provider adapters.

## Truthful user-facing statements

Rennet currently has meaningful local review, canvas, disposition, destination-preview, and harness/orchestration foundations. It is **not yet** a complete six-angle production review harness, a fully validated provider product, or a GitHub publishing client. It never auto-publishes, pushes source, or claims universal local-only processing.

Historical MVP and evidence reports are retained under [`archive/`](./archive/), including the original local-review MVP and gate ledger.
