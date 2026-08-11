---
tags: [rennet, mvp, electron, architecture]
categories: [project]
status: implemented
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Dependency Standard]]"]
---

# Rennet Local Review MVP

This is the first executable Rennet slice, implemented through OpenSpec change `build-local-review-mvp`. It proves the local review lifecycle before introducing providers, LSPs, GitHub, or generated analysis.

## What works

The desktop app can choose a local Git repository and capture one immutable patchset containing feature-branch commits against the resolved default base, staged changes, unstaged changes, and nonignored untracked files. It shows repository/base/head provenance, a changed-file rail, raw per-file patches, additions/deletions, read progress, and an explicit patchset identity.

Chokidar only marks the repository as potentially dirty. Git recapture decides whether the content-addressed patchset changed. When it did, Rennet persists an invalidation event but keeps the old patchset and its diff visible. Regeneration is a user action; success activates the new patchset and resets patchset-scoped read state.

Review state is stored in app-owned `node:sqlite` with WAL, a schema-version gate, append-only versioned events, payload-bound command receipts, idempotent replay, and unknown-event failure. This is intentionally separate from `.rennet/`: review state is private application state, while future durable project configuration, snapshots, and evidence-backed learned context belong in the repository's `.rennet/` directory under the visibility contract.

## Package boundary

| Project | Current responsibility |
|---|---|
| `packages/types` | Dependency-free repository, patchset, file, and review shapes |
| `packages/protocol` | Zod command/output validation and the renderer's single typed invoke surface |
| `packages/core` | Event folding, payload digests, invalidation, read state, and review service |
| `packages/adapters` | Read-only Git capture, SQLite storage, and change hints |
| `packages/ui` | First-run and local review React surfaces |
| `apps/desktop` | Electron composition root, permission boundary, Vite bundles, E2E, and Forge package |

Nx tags plus ESLint enforce the arrows. A manifest checker rejects illegal workspace dependencies, and its forbidden `ui → core` import positive control must fail before the architecture gate passes.

## External effects

The preload exposes exactly one method, `invoke(name, input)`, and main parses every input and output against the protocol schemas. That single typed surface is the renderer↔main contract; production assets are served through a custom protocol. Forge produces an ASAR-only macOS app.

This slice has no Rennet backend, telemetry, model/harness invocation, network API, GitHub mutation, source-repository write command, distribution signing identity, notarization, updater, publisher, or release action. Forge applies only the local ad-hoc macOS signature required to launch the packaged arm64 artifact.

## Run and verify

```sh
pnpm install --frozen-lockfile
pnpm dev

pnpm check
pnpm architecture
pnpm e2e
pnpm exec nx run rennet-desktop:package-smoke
```

The Playwright E2E journey launches the real unpackaged Electron binary against a synthetic temporary repository, captures the diff, edits the source repository, observes invalidation, proves the old diff is still visible, regenerates, and sees the new diff. The separate package smoke proves the emitted app launches and stays running. Unit/integration fixtures cover empty and mixed Git states, stable and changed identities, event replay across restart, command reuse mismatch, read state, invalidation, regeneration, and unknown-event refusal.

## Deliberate gaps

This is not yet the six-angle review harness. The next layers still need the `.rennet` default-branch project snapshot, immutable byte/materialisation hardening for pathological Git paths and very large/binary sources, lineage and affected-only artifact invalidation, RSP documents, harness adapters and disclosure, LSP, Pierre rendering, GitHub PR ingestion and explicit publication, physical delete-review purge, diagnostics, accessibility/browser depth, signing, notarization, updating, and release automation.

The MVP's base-ref fallback and untracked patch synthesis are conservative but not the final byte-exact Git contract. Nothing downstream may treat this raw capture as proof for pathological filename, encoding, submodule, symlink, or huge-binary cases until the dedicated Git fixtures and materialisation layer close those gaps.
