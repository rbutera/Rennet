# Rennet

Rennet is a local-first code review harness. It helps a reviewer understand large local changes and pull requests through six complementary angles while keeping the human responsible for every published outcome.

The repository contains a runnable desktop review foundation: immutable local and PR patchsets, evented review state, canvases and dispositions, an editable collation draft, publication previews, and explicit invalidation/regeneration. It does not auto-publish, push source branches, or treat provider use as local-only processing.

## Start here

- [Product vision](./docs/PRODUCT_VISION.md): the canonical product intent, the six angles, and the required prototype-alignment rule.
- [Rulings ledger](./docs/RULINGS_LEDGER.md): concise currently binding decisions with stable R-IDs.
- [Architecture](./docs/ARCHITECTURE.md): immutable patchsets, project context, storage, privacy, publication, dependencies, and package boundaries.
- [MVP status](./docs/MVP_STATUS.md): verified implementation, evidence gates, and deliberate gaps.
- [Design doctrine](./docs/DESIGN_DOCTRINE.md): the mandatory visual and interaction rules.
- [Interactive prototype](./prototypes/moodboard/index.html): approved product-state target for UI work.
- [Documentation index](./docs/README.md): secondary guides and the historical archive.

## Repository shape

```text
apps/          Electron desktop app and future clients
packages/      Portable types, protocol, core, adapters, UI, and instructions
scripts/       Repository gates and maintenance tooling
docs/          Current implementation guidance and archived historical material
prototypes/    Approved moodboard and exploratory screens
spikes/        Isolated evidence probes, never workspace packages
```

## Run the MVP

```sh
pnpm install --frozen-lockfile
pnpm dev
```

## Current checks

```sh
pnpm check
pnpm architecture
pnpm e2e
pnpm exec nx run rennet-desktop:package-smoke
```

Nx runs and locally caches deterministic lint, TypeScript, unit-test, and build work across the production graph. Electron E2E and Forge packaging remain uncached because they exercise real process and artifact boundaries.

## Privacy boundary

There is no Rennet backend. Selected harnesses or model providers may receive explicitly assembled code and context; Rennet must disclose that before a run. Rennet is MIT licensed throughout. Never use easyJet or another client repository, data, screenshot, pull request, or infrastructure as a fixture without written authorization.
