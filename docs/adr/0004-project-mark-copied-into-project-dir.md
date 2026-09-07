---
title: ADR 0004 - A project's logo is copied into its project dir
description: Why a detected or uploaded project logo is stored as bytes under the host's per-project directory instead of being read from the checkout on demand.
---

A project mark that is a logo lives as a file under the Rennet host's per-project directory (`~/.rennet/projects/<escaped-path>/`), copied there once when the project scout detects it or when the user uploads one, and served to the client through a typed wire verb. Reading the detected path out of the checkout on every request was rejected because a mark is a property of the project, not of whichever worktree or branch happens to be checked out, because the repo can delete or move the file without the project losing its mark, and because an uploaded logo needs a Rennet-owned home in any case, so one store serves both kinds.

- **Status**: Accepted
- **Date**: 2026-09-07
- **Scope**: project mark storage

## Consequences

- A detected logo does not follow upstream changes; Identity offers a "Detect again" action that re-runs logo detection and re-copies.
- The scout record keeps the source (`repoRoot` + relative path) so a refresh never resolves the repo through the project's open path.
- The project's own `.rennet/` folder is never used for the mark: it is per-checkout and purged with the session that owns it.
