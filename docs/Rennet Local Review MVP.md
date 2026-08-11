---
tags: [rennet, mvp, electron, architecture]
categories: [project]
status: implemented
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Dependency Standard]]", "[[Rennet Evidence Gate Status]]"]
---

# Rennet Local Review MVP

> ⚠️ **RULE ZERO (CLAUDE.md, 2026-08-11) outranks this document.** No consent gates, no gates, no robustness for robustness' sake. This is a record of shipped code and stays accurate as a record; the ⛔ marker below governs what further work is warranted, not what already exists.

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

## Security and external effects

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. What shipped stays shipped, but this section is not a mandate to extend: no further hardening, fuse work, permission denial, or lockdown is warranted for its own sake — and where hardening costs a real capability (the disabled CLI-inspect fuse that stops Playwright attaching to the packaged app), the capability wins.

The renderer is sandboxed with context isolation and no Node integration. The preload exposes only `invoke(name, input)`. Main validates the exact `app://rennet` sender, parses every input and output, denies permission requests, external navigation, and new windows, and serves production assets through a restricted custom protocol with CSP.

Forge produces an ASAR-only macOS app. The package gate reads the emitted fuse wire: RunAsNode, `NODE_OPTIONS`, CLI inspect, and extra file-protocol privileges are disabled; cookie encryption, embedded ASAR integrity, ASAR-only loading, and WASM trap handlers are enabled.

This slice has no Rennet backend, telemetry, model/harness invocation, network API, GitHub mutation, source-repository write command, distribution signing identity, notarization, updater, publisher, or release action. Forge applies only the local ad-hoc macOS signature required to launch the packaged arm64 artifact after fuse hardening.

## Run and verify

```sh
pnpm install --frozen-lockfile
pnpm dev

pnpm check
pnpm architecture
pnpm e2e
pnpm exec nx run rennet-desktop:package-smoke
```

The Playwright E2E journey launches the real unpackaged Electron binary against a synthetic temporary repository, proves that renderer `process` is absent, captures the diff, edits the source repository, observes invalidation, proves the old diff is still visible, regenerates, and sees the new diff. Playwright cannot attach to the hardened package because the CLI inspect fuse is deliberately disabled; the separate package smoke owns signature verification, exact fuse assertions, and proving the emitted app remains running. Unit/integration fixtures cover empty and mixed Git states, stable and changed identities, event replay across restart, command reuse mismatch, read state, invalidation, regeneration, and unknown-event refusal.

## Deliberate gaps

This is not yet the six-angle review harness. The next layers still need the `.rennet` default-branch project snapshot, immutable byte/materialisation hardening for pathological Git paths and very large/binary sources, lineage and affected-only artifact invalidation, RSP documents, harness adapters and disclosure, LSP, Pierre rendering, GitHub PR ingestion and explicit publication, physical delete-review purge, diagnostics, accessibility/browser depth, signing, notarization, updating, and release automation.

The MVP's base-ref fallback and untracked patch synthesis are conservative but not the final byte-exact Git contract. Nothing downstream may treat this raw capture as proof for pathological filename, encoding, submodule, symlink, or huge-binary cases until the dedicated Git fixtures and materialisation layer close those gaps.
