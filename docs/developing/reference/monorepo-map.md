---
title: Monorepo map
description: Every Nx application and package, its job, and the in-repository dependencies it may use.
---

Use this map to find the project that owns a change before editing code. Nx and
the package manifests remain the machine-readable source; the documentation
check rejects missing or misnamed rows here.

## Applications

| Nx project | Package | Root | Responsibility | Allowed in-repository dependencies |
| --- | --- | --- | --- | --- |
| `rennet-desktop` | `@rennet/desktop` | `apps/desktop` | Electron shell, browser bundle, packaging, and end-to-end tests | adapters, client, core, protocol, server, types, ui |
| `rennet-docs` | `@rennet/docs` | `apps/docs` | Astro and Starlight documentation renderer | theme |
| `rennet-marketing` | `@rennet/marketing` | `apps/marketing` | Public marketing site | theme |
| `rennet-mobile` | `@rennet/mobile` | `apps/mobile` | Expo mobile client | client, protocol, types |

## Packages

| Nx project | Package | Root | Responsibility | Allowed in-repository dependencies |
| --- | --- | --- | --- | --- |
| `rennet-types` | `@rennet/types` | `packages/types` | Shared domain types | None |
| `rennet-theme` | `@rennet/theme` | `packages/theme` | Shared design tokens and generated mobile palette | None |
| `rennet-protocol` | `@rennet/protocol` | `packages/protocol` | Command, event, and wire schemas | types |
| `rennet-instructions` | `@rennet/instructions` | `packages/instructions` | Versioned model instructions | types |
| `rennet-core` | `@rennet/core` | `packages/core` | Review behavior and domain workflows | types, protocol, instructions |
| `rennet-adapters` | `@rennet/adapters` | `packages/adapters` | Git, GitHub, filesystem, persistence, and harness integrations | types, protocol, instructions, core |
| `rennet-server` | `@rennet/server` | `packages/server` | Daemon composition, command dispatch, and network transport | types, protocol, instructions, core, adapters |
| `rennet-client` | `@rennet/client` | `packages/client` | Browser-safe connection and session runtime | types, protocol |
| `rennet-ui` | `@rennet/ui` | `packages/ui` | Shared review interface | types, protocol, theme |

The root `rennet` Nx project owns workspace-wide checks. The content-only
`rennet-docs-content` project owns canonical Markdown under `docs`; it has no
package manifest or runtime dependency.
