---
title: Bootstrap a Rennet checkout
description: Install the pinned toolchain, inspect the Nx graph, and run the repository gate.
---

Use this guide for a fresh clone or worktree. The root manifest, lockfile, and Nx
configuration define the development environment.

## Install the toolchain

Rennet pins Node `24.18.0` in `.nvmrc` and pnpm `10.32.1` in `package.json`.
Select the pinned Node version, then install the committed dependency graph:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Use the workspace copy of Nx through `pnpm nx`. A global Nx installation is not
part of the toolchain.

## Inspect the workspace

Ask Nx for project and target names before running them:

```sh
pnpm nx show projects
pnpm nx show project rennet-core --json
pnpm nx show project rennet-desktop --json
```

The production workspace contains four apps and ten packages:

| Area | Projects |
|---|---|
| Apps | `rennet-desktop`, `rennet-docs`, `rennet-marketing`, `rennet-mobile` |
| Product packages | `rennet-types`, `rennet-protocol`, `rennet-instructions`, `rennet-core`, `rennet-adapters`, `rennet-server`, `rennet-client`, `rennet-ui`, `rennet-app-ui`, `rennet-theme` |

`rennet-docs-content` represents the canonical Markdown library under `docs/`.
The root `rennet` project owns repository-wide checks. Spikes have their own Nx
projects but stay outside the pnpm workspace.

The [monorepo map](../reference/monorepo-map.md) lists each project and its role.

## Follow the package boundaries

```mermaid
flowchart TD
  types["@rennet/types"]
  theme["@rennet/theme"]
  protocol["@rennet/protocol"]
  instructions["@rennet/instructions"]
  core["@rennet/core"]
  adapters["@rennet/adapters"]
  server["@rennet/server"]
  client["@rennet/client"]
  ui["@rennet/ui"]
  appui["@rennet/app-ui"]
  desktop["apps/desktop"]
  mobile["apps/mobile"]

  protocol --> types
  instructions --> types
  core --> types
  core --> protocol
  core --> instructions
  adapters --> types
  adapters --> protocol
  adapters --> instructions
  adapters --> core
  server --> types
  server --> protocol
  server --> core
  server --> adapters
  client --> types
  client --> protocol
  ui --> types
  ui --> theme
  appui --> types
  appui --> protocol
  appui --> theme
  appui --> ui
  desktop --> server
  desktop --> client
  desktop --> appui
  mobile --> client
  mobile --> protocol
  mobile --> types
```

An arrow means "imports." `types` and `theme` import no Rennet package. `core`
contains platform-neutral product logic. `adapters` owns Git, filesystem,
GitHub, harness, and process effects. `server` composes the daemon. `client`
implements the transport-neutral client. `ui` is the vendored component kit,
importing only `types` and `theme`. `app-ui` builds the Rennet interface on that
kit. Both stay browser-safe. The desktop and mobile apps are composition roots
for their platforms.

`scripts/check-boundaries.mjs` checks manifest dependencies and source imports.
See the [architecture overview](../concepts/architecture-overview.md) and
[architecture contracts](../concepts/architecture-contracts.md) for the full
ownership rules.

## Run repository tasks

Use Nx for builds, tests, lint, and type checks. The full local and CI gate is:

```sh
pnpm check
```

It runs `format`, `architecture`, `licenses`, `lint`, `typecheck`, `test`, and
`build` across the workspace. Use the affected gate while iterating:

```sh
pnpm nx affected -t lint,typecheck,test,build
```

Run the full gate before pushing. For a new regression test, prove that it fails
when the protected behavior is broken, then restore the implementation and prove
that it passes.

## Keep Nx cache results meaningful

Cacheable targets declare the source, shared configuration, environment inputs,
and generated outputs that decide their results. Trust a matching local cache
hit. If a changed input can produce a stale pass, reproduce the fault and correct
the target inputs.

Do not run concurrent Nx processes in one worktree. Nx can race its task-history
database and report `FOREIGN KEY constraint failed` or `disk I/O error` after a
target succeeds. For that exact failure, run `pnpm nx reset` once and rerun the
command. Long-running, interactive, and end-to-end targets are not cacheable.

## Place new work

| Change | Owner |
|---|---|
| Shared wire type or command | `packages/types` or `packages/protocol` |
| Product rule or pure transformation | `packages/core` |
| Git, filesystem, network, or process effect | `packages/adapters` |
| Daemon composition or dispatch | `packages/server` |
| Client transport and projection | `packages/client` |
| Vendored component primitive | `packages/ui` |
| Rennet review interface | `packages/app-ui` |
| Electron integration | `apps/desktop` |
| Expo integration | `apps/mobile` |

Define a core port when product logic needs a platform capability. Implement the
port in `adapters`, then compose it in the relevant app or server. Keep all
packages under the repository's MIT licence.

## Keep the checkout healthy

- Preserve unrelated work in a dirty tree and stage only files in your change.
- Keep spikes outside the pnpm workspace.
- Update affected documentation in the same change.
- Do not add AI attribution or co-author trailers.
- Track delivery priority in the [GitHub issue queue](https://github.com/rbutera/rennet/issues).
