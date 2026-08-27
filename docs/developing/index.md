---
title: Developing Rennet
description: The architecture, contracts, guides, and working rules for people building Rennet.
---

Use this section to find the code that owns a Rennet behavior and the contract it
must preserve. Start with the architecture pages, then follow the subsystem you
are changing.

## Architecture tour

```mermaid
flowchart LR
  capture[Capture an immutable patchset] --> review[Run deterministic and model review jobs]
  review --> lenses[Project results onto review lenses]
  lenses --> draft[Edit the collation draft]
  draft --> preview[Build the outbound preview]
  preview --> github[Post a review or open a pull request]
  preview --> handoff[Run a coding-agent handoff]
  handoff --> successor[Capture a successor patchset]
  successor --> review
```

Read these pages in order when you need the whole system:

1. [Architecture overview](./concepts/architecture-overview.md) maps the apps,
   packages, processes, and review loop.
2. [Architecture contracts](./concepts/architecture-contracts.md) defines the
   rules for patchsets, project context, persistence, and outbound work.
3. [Review lenses](./concepts/review-lenses.md) explains the Spec, Sequence,
   Decisions, Noise, and Flagged views and how each shapes the shared patchset.
4. [Surfacing and routing](./concepts/surfacing-and-routing.md) covers model
   output, validation, instructions, and model assignment.
5. [Collation and publishing](./concepts/collation-and-publishing.md) follows
   review state into a GitHub review or pull request.

## Find a subsystem

| Change | Read |
| --- | --- |
| Harness discovery, sessions, or events | [Harness adapters](./concepts/harness-adapters.md) and [surfacing and routing](./concepts/surfacing-and-routing.md) |
| Prompt context or model assignment | [Context assembly](./concepts/context-assembly.md) and [model council](./concepts/model-council.md) |
| Definitions, references, or symbol lookup | [Code intelligence](./concepts/code-intelligence.md) |
| Coding-agent work after review | [Agent handoff](./concepts/agent-handoff.md) and [delta re-review and lineage](./concepts/delta-rereview-and-lineage.md) |
| Draft editing or comment wording | [Comment refinement](./concepts/comment-refinement.md) and [collation and publishing](./concepts/collation-and-publishing.md) |
| Repository discovery or settings | [Repository bootstrap](./guides/repository-bootstrap.md) and [settings and setup](./guides/settings-and-setup.md) |
| Interface behavior | [Design doctrine](./concepts/design-doctrine.md) and [review lenses](./concepts/review-lenses.md) |
| Dependencies or build configuration | [Dependency standard](./reference/dependency-standard.md) and [monorepo map](./reference/monorepo-map.md) |

## Source and authority

[Contracts and rulings](./decisions/contracts-and-rulings.md) owns cross-cutting
product decisions. [Documentation architecture](./reference/doc-architecture.md)
maps the narrower authorities. Promoted OpenSpec files define accepted behavior,
and [GitHub issues](https://github.com/rbutera/rennet/issues) track active work.

The runtime is split across portable packages and thin applications.
`@rennet/server` composes the daemon and command router. `@rennet/client` owns
browser-safe connections to that daemon. `@rennet/ui` is the vendored component
kit, and `@rennet/app-ui` owns the Rennet application interface built on it.
`apps/desktop` and `apps/mobile` supply platform shells.

## Work in the monorepo

Rennet uses pnpm and Nx. Query resolved configuration instead of guessing a
project name or target:

```sh
pnpm nx show project <name> --json
```

The full local check is:

```sh
pnpm check
```

It runs formatting, architecture, licence, lint, typecheck, test, and build
targets. Before editing documentation, read the
[docs style guide](./contributing/docs-style-guide.md) and the
[good docs standard](./contributing/good-docs-standard.md).
