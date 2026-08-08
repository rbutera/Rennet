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

Small documentation pass required before feature implementation. [[Rennet Contracts and Rulings]] remains authoritative.

- [x] **Write the canonical project-context contract.** Defined in [[Rennet Architecture Contracts]] §2 and integrated into the Master Plan and Handoff.

- [x] **Write the canonical review and patchset model.** Defined in [[Rennet Architecture Contracts]] §3–§4 and represented in the refreshed prototype.

- [x] **Freeze the persistent schemas.** Canonical entities, artifact provenance, commands, and acceptance criteria are in [[Rennet Architecture Contracts]] §5–§6.

- [x] **Record the privacy, storage, and publication contracts.** Frozen in [[Rennet Architecture Contracts]] §7–§9 and reflected in product copy.

- [x] **Normalise the subordinate plans against the Master Plan.** Eleven plans now carry explicit authority notices; operative recipes use the canonical names and contracts while historical measurements remain labelled as evidence only.

- [x] **Refresh the canonical prototype.** It now shows Rennet, six angles, author-first home, invalidation/regeneration, both publish variants, and honest privacy language.

- [ ] **Validate the refreshed prototype with 5–8 target engineers.** Test whether invalidation, affected-only regeneration, and the two publish variants are understood without explanation before deep frontend implementation.

- [ ] **Close the remaining pre-build evidence gates.** Event/publish failure injection, TypeScript LSP resources, and Electron `node:sqlite` are closed. Remaining gates and exact approval blockers are tracked in [[Rennet Evidence Gate Status]].
