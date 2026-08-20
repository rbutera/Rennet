---
title: ADR 0002 - Root docs own the documentation library
description: Why canonical documentation lives under root docs and Starlight builds from an ignored projection.
---

Rennet keeps its only committed reader-facing Markdown under root `docs/`, while `apps/docs` contains the Starlight renderer. The app builds from an ignored generated projection because Starlight requires its collection inside the application tree, and this keeps GitHub browsing direct without relying on symlinks or a custom loader built around undocumented Starlight paths.

- **Status**: Accepted
- **Date**: 2026-08-20
- **Scope**: documentation source ownership

## Decision

Canonical pages live under `docs/using`, `docs/developing`, and `docs/adr`. `docs/README.md` lists every page for GitHub readers. The Starlight homepage remains under `apps/docs` because it uses site components.

Before Astro sync, build, preview, or development, the docs app mirrors the canonical sections into its ignored `src/content/docs` directory. Development watches the canonical files and applies additions, changes, and deletions to the projection. Route middleware maps edit links and update dates back to the canonical source. The build reads full Git history for those dates and is not cached by Nx.

Nx models root documentation as `rennet-docs-content`. The `rennet-docs` application depends on that project and `rennet-theme`, so content and theme changes invalidate the site build.

## Consequences

- GitHub readers reach prose directly under `docs/`.
- The public site renders the same committed files.
- Generated projection files never enter Git or appear in source links.
- New documentation sections must be added to the projection, inventory check, and sidebar together.
