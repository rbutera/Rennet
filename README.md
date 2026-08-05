# Rennet

Rennet is a local-first code review harness. It helps a reviewer understand large local changes and pull requests through six complementary angles while keeping the human responsible for every published outcome.

The repository is currently in pre-build architecture and evidence-gathering. It is the product monorepo, not a notes archive: application code will live under `apps/`, portable packages under `packages/`, and supporting scripts under `scripts/`.

## Start here

- [Master plan](./docs/Rennet%20Master%20Plan.md): authoritative product and architecture reconciliation.
- [Architecture contracts](./docs/Rennet%20Architecture%20Contracts.md): project context, immutable patchsets, invalidation, persistence, privacy, and publication.
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

## Current checks

```sh
pnpm check
```

This currently validates the executable event-store proof and prototype JavaScript. Package-level build, lint, typecheck, and test gates will replace it when the first production packages land.

## Privacy boundary

There is no Rennet backend. Selected harnesses or model providers may receive explicitly assembled code and context, and the app must disclose that before a run. Never use easyJet or other client repositories, data, screenshots, or pull requests as fixtures without written authorization.

This private repository does not currently grant a licence. The planned public licensing split is recorded in the master plan and must be implemented before the repository becomes public.
