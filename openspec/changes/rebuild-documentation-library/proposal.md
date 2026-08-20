## Why

Rennet's documentation is buried inside the Starlight application. It has also
drifted from the monorepo. Current pages, promoted specs, and package READMEs mix
live behavior with obsolete designs, so readers cannot tell what works now or
what is planned.

## What changes

- Move the Astro and Starlight renderer into `apps/docs`. Keep the only committed
  reader pages directly under root `docs`.
- Add a GitHub-readable `docs/README.md`, source-relative navigation, and a map of
  every current Nx application and package.
- Organize the site around current concepts, guides, decisions, reference
  material, and tracked plans. Remove the completed delivery ledger and
  reader-facing archive material.
- Check every current or planned page, README, ADR, and promoted spec against
  `main`, then rewrite the whole file in direct prose.
- Archive every stale active OpenSpec change. Preserve unchecked tasks on the
  two partial changes and record their outcomes.
- Replace paper, signing, hold-to-confirm, degradation-gate, and glass
  requirements with the preview and post model required by Rule Zero.
- Check the root inventory, internal links, renderer projection, Nx cache inputs,
  and monorepo map for drift.

## Capabilities

### New capabilities

- `documentation-library`: Defines the canonical root documentation library, the
  separate renderer, GitHub browsing, current and planned scope, and drift
  checks.

### Modified capabilities

- `publish-safety-gate`: Replace signing and hold gates with direct posting of
  the exact previewed payload.
- `destination-frame`: Replace paper and signing language with the draft,
  preview, and post flow.
- `canvas-ui`: Require the Affineur's Bench tokens and forbid glass styling.

## Impact

This changes the documentation tree, the `rennet-docs` Nx project, Starlight
content loading, the Cloudflare Pages workflow, workspace metadata,
documentation checks, current OpenSpec contracts, repository READMEs,
`CONTEXT.md`, and the documentation ADR set. It does not change Rennet's runtime
or public protocol.
