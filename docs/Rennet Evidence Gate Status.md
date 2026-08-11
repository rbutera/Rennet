---
tags: [rennet, architecture, evidence]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Decision Integration Tasks]]"]
source: codex
---

# Rennet Evidence Gate Status

> ⚠️ **READ FIRST — RULE ZERO (CLAUDE.md, Rai, 2026-08-11) outranks this entire document.** No consent gates, no gates, no robustness for robustness' sake. Nothing in this ledger may stop work from starting.

This is the current evidence ledger for [[Rennet Contracts and Rulings]] entry gates. A gate is closed only by a reproducible verdict, never by architectural confidence.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. The whole premise of this document — that an open row withholds permission to build — is retired: this is now an evidence *ledger* that records what is measured versus assumed, and it informs work without blocking it (rows that turn on Rai's money or on mutating someone else's repository are his call as owner, not gate machinery, and are unaffected).

| Gate | Status | Evidence or blocker |
|---|---|---|
| Local review desktop vertical slice | Closed for MVP scope | [[Rennet Local Review MVP]]. Real Electron E2E proves repository capture, renderer isolation, edit invalidation, preservation of the old patchset, and explicit regeneration. Forge packaging and the emitted Electron fuse wire are checked locally. |
| Lineage matcher precision | Open | Synthetic matcher and a permitted 10–20-pair corpus do not yet exist. Client PRs are prohibited as fixtures; use public, personal, or synthetic history. |
| Cross-harness JSON Schema subset | Blocked | A real Claude and Codex call could incur provider spend. Requires Rai's explicit spend approval before probing. |
| Event store and publish failure injection | Closed | [[Rennet Spike - Event Store and Publish Failure Injection]]. |
| Decomposition quality comparison | Open | Needs an 8–12 PR permitted corpus, three decompositions per PR, and blinded human scoring. No client corpus may be used. |
| Capability gating and live Codex turn | Blocked | Requires a real model-backed app-server turn and approval flow, with possible spend. |
| Claude CLI isolation, resume, schema, and batching | Blocked | Requires real model-backed calls and possible spend. |
| GitHub batch publication and read-back | Blocked | Requires mutating a throwaway external repository. External publication needs Rai's explicit approval. |
| TypeScript LSP ladder | Closed | [[Rennet Spike - TypeScript LSP Ladder]]. |
| Pierre target-version, throttling, and annotation recycling | Partially blocked | The target Pierre version remains inside the workstation's npm cooldown; the current prototype refresh can validate product-state survival, but cannot close the renderer-version gate. |
| Cache-owned LSP materialisation | Open | Prove the disposable app-cache checkout/materialisation mechanism without mutating the source repository or relying on a source-repo worktree. |
| Refreshed prototype comprehension | Open | Run 5–8 target engineers through invalidation, affected-only regeneration, and both publish variants without explanation. |
| Electron 43 `node:sqlite` | Closed | [[Rennet Spike - Electron 43 node sqlite]]. |
| Outdated GitHub thread re-anchor | Open | Needs a permitted real force-pushed PR fixture; safe to defer because it is P2. |

Closed gates may unblock only their dependent subsystem. Foundational work may proceed inside closed or ungated slices; the affected product subsystems and any public release remain gated by their open P0 rows.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. An open P0 row no longer blocks a subsystem from being built; build the subsystem, and let an open row tell you which behaviour is still unmeasured.
