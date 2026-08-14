# Rennet

Rennet is a local-first code review harness. It turns local changes and GitHub pull requests into an ordered, evidence-backed review while keeping the human responsible for the result that goes out.

The desktop app captures immutable patchsets, builds deterministic project context, runs review work through installed coding harnesses, preserves review state across successor changes, and produces one editable signed artifact. Team work can become a GitHub review; your own branch can become a coding-agent handoff followed by a pushed branch and pull request.

**Website:** [rennet.dev](https://rennet.dev) — make code digestible. **Docs:** [docs.rennet.dev](https://docs.rennet.dev).

## Start here

- [Using Rennet](./docs/src/content/docs/using/index.md): the product, the review loop, and the shortest route through it.
- [Architecture overview](./docs/src/content/docs/developing/concepts/architecture-overview.md): packages, processes, state, and the two live review paths.
- [Architecture contracts](./docs/src/content/docs/developing/concepts/architecture-contracts.md): immutable patchsets, context, lineage, persistence, and publication.
- [Contracts and rulings](./docs/src/content/docs/developing/reference/contracts-and-rulings.md): the authority register and durable product decisions.
- [Dependency standard](./docs/src/content/docs/developing/reference/dependency-standard.md): package, licence, toolchain, and ownership decisions.
- [Delivery order](./docs/src/content/docs/developing/reference/delivery-order.md): current implementation priorities grounded in the live issue queue.
- [Wireframes](./wireframes/): the canonical lo-fi wireframe set (rendered PNGs + HTML sources in `wireframes/src/`). Open `wireframes/gallery.html` for the whole flow on one scroll.

## Repository shape

```text
apps/          Electron desktop app and future clients
packages/      Portable types, protocol, core, adapters, UI, and instructions
scripts/       Repository gates and maintenance tooling
docs/          Astro Starlight docsite: user guides, architecture, and reference
wireframes/    Canonical lo-fi wireframes (rendered PNGs + HTML sources + gallery)
prototypes/    Archived exploratory screens (pre-wireframe)
spikes/        Isolated evidence probes, never workspace packages
```

## Run the MVP

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Choose a Git repository in the desktop app. Rennet captures committed feature-branch changes, staged and unstaged changes, and nonignored untracked files without writing to the source repository.

## Current checks

```sh
pnpm check
pnpm architecture
pnpm e2e
pnpm exec nx run rennet-desktop:package-smoke
```

Nx runs and locally caches lint, TypeScript 7 typechecking, unit tests, and Vite builds across the production package graph. The architecture target includes a forbidden-import positive control. Electron E2E and Forge packaging remain uncached because they exercise real process and artifact boundaries.

## Privacy boundary

There is no Rennet backend. Selected harnesses or model providers may receive explicitly assembled code and context; Rennet records the assembled context rather than pretending the whole loop is offline. Never use client repositories, data, screenshots, or pull requests as fixtures without written authorization.

Rennet is MIT licensed throughout.
