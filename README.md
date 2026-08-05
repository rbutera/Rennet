# Rennet

Rennet is a local-first code review harness. It helps a reviewer understand large local changes and pull requests through six complementary angles while keeping the human responsible for every published outcome.

The repository now contains the first runnable desktop MVP alongside the architecture and evidence work. It captures a local repository into an immutable patchset, persists review events locally, preserves the old review when code changes, and regenerates only after an explicit action. It does not call a model, mutate Git, or publish anything.

## Start here

- [Master plan](./docs/Rennet%20Master%20Plan.md): authoritative product and architecture reconciliation.
- [Architecture contracts](./docs/Rennet%20Architecture%20Contracts.md): project context, immutable patchsets, invalidation, persistence, privacy, and publication.
- [Dependency standard](./docs/Rennet%20Dependency%20Standard.md): authoritative package, licence, toolchain, and ownership decisions.
- [Local review MVP](./docs/Rennet%20Local%20Review%20MVP.md): what is implemented, how to run it, and the deliberately missing product layers.
- [Evidence gates](./docs/Rennet%20Evidence%20Gate%20Status.md): what is proven, open, or approval-blocked before implementation.
- [Build handoff](./docs/Rennet%20Navi%20Handoff.md): dependency-ordered implementation plan.
- [Interactive prototype](./prototypes/moodboard/index.html): current product-state prototype.

## Repository shape

```text
apps/          Electron desktop app and future clients
packages/      Portable types, protocol, core, adapters, UI, and instructions
scripts/       Repository gates and maintenance tooling
docs/          Architecture, product research, decisions, and evidence verdicts
prototypes/    Current moodboard and archived exploratory screens
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

There is no Rennet backend. Selected harnesses or model providers may receive explicitly assembled code and context, and the app must disclose that before a run. Never use easyJet or other client repositories, data, screenshots, or pull requests as fixtures without written authorization.

This private repository does not currently grant a licence. The planned public licensing split is recorded in the master plan and must be implemented before the repository becomes public.
