---
tags: [rennet, architecture, evidence]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]"]
source: codex
---

# Rennet Spike: Electron 43 `node:sqlite`

## Verdict

**Pass. Use built-in `node:sqlite` for the Rennet event store. Retire `node-sqlite3-wasm` and the Kysely bridge from the active design.**

The probe ran inside Electron 43.2.0, whose embedded Node was 24.18.0. It loaded `node:sqlite`, created an in-memory database, created a table, inserted a bound value, read it back, and closed cleanly.

```json
{"electron":"43.2.0","node":"24.18.0","nodeSqlite":true,"roundTrip":true}
```

Electron 43.3.0 was visible in the registry but excluded by the workstation's seven-day npm supply-chain cooldown. The gate concerns Electron major 43 availability rather than a patch-specific behaviour, so 43.2.0 is sufficient to close the architectural question. Re-run the same probe as an ordinary dependency-upgrade check when the pinned Electron version changes.

Probe: [probe.cjs](../spikes/node-sqlite-electron-43/probe.cjs).

## Consequence

The store may use synchronous `DatabaseSync` inside the single-writer engine process. This does not change the persistence, physical purge, permissions, backup, or unknown-event fail-safe requirements in [[Rennet Architecture Contracts]].
