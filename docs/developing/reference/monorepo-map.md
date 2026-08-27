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
| `rennet-desktop` | `@rennet/desktop` | `apps/desktop` | Electron shell, browser bundle, packaging, and end-to-end tests | adapters, client, core, protocol, server, app-ui |
| `rennet-docs` | `@rennet/docs` | `apps/docs` | Astro and Starlight documentation renderer | docs-content, theme |
| `rennet-marketing` | `@rennet/marketing` | `apps/marketing` | Public marketing site | theme |
| `rennet-mobile` | `@rennet/mobile` | `apps/mobile` | Expo mobile client | client, protocol |

## Packages

| Nx project | Package | Root | Responsibility | Allowed in-repository dependencies |
| --- | --- | --- | --- | --- |
| `rennet-theme` | `@rennet/theme` | `packages/theme` | Shared design tokens and generated mobile palette | None |
| `rennet-protocol` | `@rennet/protocol` | `packages/protocol` | Contract folders — board schema (on `@wboard/core`), command registry, session, delta, manifests — plus event and wire schemas | None |
| `rennet-prompts` | `@rennet/prompts` | `packages/prompts` | Lens-agent drafting prompts, the unslop editor pass, and the versioned RSP prompt contracts | protocol |
| `rennet-core` | `@rennet/core` | `packages/core` | Review behavior and domain workflows | protocol, prompts |
| `rennet-adapters` | `@rennet/adapters` | `packages/adapters` | Git, GitHub, filesystem, persistence, and harness integrations | protocol, prompts, core |
| `rennet-server` | `@rennet/server` | `packages/server` | Daemon composition, command dispatch, and network transport | protocol, prompts, core, adapters |
| `rennet-client` | `@rennet/client` | `packages/client` | Browser-safe connection and session runtime | protocol |
| `rennet-ui` | `@rennet/ui` | `packages/ui` | Vendored shadcn/Base UI component kit | protocol, theme |
| `rennet-app-ui` | `@rennet/app-ui` | `packages/app-ui` | Rennet's composites and review-interface screens | protocol, theme, ui |

The root `rennet` Nx project owns workspace-wide checks. The content-only
`rennet-docs-content` project owns canonical Markdown under `docs`; it has no
package manifest or runtime dependency.
