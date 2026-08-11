---
tags: [rennet, architecture, plans]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Evidence Gate Status]]"]
source: codex
---

# Rennet Decision Integration Tasks

> ⚠️ **RULE ZERO (CLAUDE.md, 2026-08-11) outranks this document.** No consent gates, no gates, no robustness for robustness' sake. The completed documentation items are a record; the two unchecked items no longer gate any build.

Small documentation pass required before feature implementation. [[Rennet Contracts and Rulings]] remains authoritative.

- [x] **Write the canonical project-context contract.** Defined in [[Rennet Architecture Contracts]] §2 and integrated into the Master Plan and Handoff.

- [x] **Write the canonical review and patchset model.** Defined in [[Rennet Architecture Contracts]] §3–§4 and represented in the refreshed prototype.

- [x] **Freeze the persistent schemas.** Canonical entities, artifact provenance, commands, and acceptance criteria are in [[Rennet Architecture Contracts]] §5–§6.

- [x] **Record the privacy, storage, and publication contracts.** Frozen in [[Rennet Architecture Contracts]] §7–§9 and reflected in product copy.

- [x] **Normalise the subordinate plans against the Master Plan.** Eleven plans now carry explicit authority notices; operative recipes use the canonical names and contracts while historical measurements remain labelled as evidence only.

- [x] **Refresh the canonical prototype.** It now shows Rennet, six angles, author-first home, invalidation/regeneration, both publish variants, and honest privacy language.

- [ ] **Validate the refreshed prototype with 5–8 target engineers.** Test whether invalidation, affected-only regeneration, and the two publish variants are understood without explanation before deep frontend implementation.

- [ ] **Close the remaining pre-build evidence gates.** Event/publish failure injection, TypeScript LSP resources, and Electron `node:sqlite` are closed. Remaining gates and exact approval blockers are tracked in [[Rennet Evidence Gate Status]].

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. Both unchecked items above are build blockers ("validate with 5–8 engineers *before* deep frontend implementation"; "close the remaining pre-build evidence gates") and neither blocks anything now — spikes stay useful as evidence, never as permission to start.
