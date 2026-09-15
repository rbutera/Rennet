---
title: Developing Rennet
description: The architecture, contracts, guides, and working rules for people building Rennet.
---

Use this section to find the code that owns a Rennet behavior and the contract it
must preserve. Start with the architecture pages, then follow the subsystem you
are changing.

## Built on T3 Code

Rennet stands on the shoulders of [T3 Code](https://github.com/pingdotgg/t3code),
the open-source coding agent from T3 Tools. Its server, provider layer, and thread
UI are the engine under every Rennet review: the chat beside each surface, the work
orders Rennet dispatches, and the harness sessions that persist across a reload all
run on T3 Code, vendored into this monorepo rather than reimplemented. Rennet would
be a far smaller, slower thing to build without it, and the project is glad to build
on such good work. A huge thank-you to the T3 Code team.

T3 Code is MIT licensed by T3 Tools Inc., and the upstream licence travels with the
vendored snapshot unchanged. How the snapshot is taken, folded, and patched is in
[T3 Code vendoring](./concepts/t3code-vendoring.md); how the daemon runs it as an
owned local process, the one Rennet's own surfaces call the *chat sidecar*, is in
[the T3 Code sidecar](./concepts/t3code-sidecar.md).

## Architecture tour

```mermaid
flowchart LR
  capture[Capture an immutable patchset] --> delta[Build the delta packet]
  delta --> landed{Landed round?}
  landed -->|No| lenses[Draft five lens boards concurrently]
  landed -->|Yes| report[Classify and persist the round report]
  report --> lenses
  lenses --> board[Compose across the lens boards]
  board --> asks[Stage asks]
  asks --> exits{Exit}
  exits -->|Teammate PR| post[Post the GitHub review]
  exits -->|Your branch| round[Dispatch a work-order round]
  exits -->|Nothing left to ask| pr[Push and open the pull request]
  round --> successor[Capture a successor patchset]
  successor --> capture
```

Read these pages in order when you need the whole system:

1. [Architecture overview](./concepts/architecture-overview.md) maps the apps,
   packages, processes, and review loop.
2. [Architecture contracts](./concepts/architecture-contracts.md) defines the
   rules for patchsets, project context, persistence, and outbound work.
3. [The lens pipeline](./concepts/lens-pipeline.md) explains how the delta
   packet reaches the Design, Sequence, Decisions, Flagged, and Noise
   drafters concurrently after the round-report boundary, and how bounded
   repair and deterministic validation freeze their boards.
4. [Surfacing and routing](./concepts/surfacing-and-routing.md) covers model
   output, validation, instructions, and model assignment.
5. [Hand off and the exits](./concepts/handoff-and-exits.md) follows asks and
   the living drafts into a GitHub review, a work-order round, or a pull
   request.

## Find a subsystem

| Change | Read |
| --- | --- |
| Harness discovery, sessions, or events | [Harness adapters](./concepts/harness-adapters.md) and [surfacing and routing](./concepts/surfacing-and-routing.md) |
| Prompt context or model assignment | [Context assembly](./concepts/context-assembly.md) and [model council](./concepts/model-council.md) |
| Definitions, references, or symbol lookup | [Code intelligence](./concepts/code-intelligence.md) |
| Board drafting, lint, or lens lanes | [The lens pipeline](./concepts/lens-pipeline.md) |
| Board storage, elements, or the whiteboard protocol | [How Rennet consumes `@wboard/*`](./reference/whiteboard-consumption.md) |
| Asks, living drafts, or an exit | [Hand off and the exits](./concepts/handoff-and-exits.md) |
| Coding-agent rounds and successor patchsets | [Hand off and the exits](./concepts/handoff-and-exits.md) and [Delta and generations](./concepts/delta-rereview-and-lineage.md) |
| Repository discovery or settings | [Repository bootstrap](./guides/repository-bootstrap.md) and [settings and setup](./guides/settings-and-setup.md) |
| The product images on rennet.dev | [Marketing screenshots](./guides/marketing-screenshots.md) |
| Interface behavior | [Design doctrine](./concepts/design-doctrine.md) and [the lens pipeline](./concepts/lens-pipeline.md) |
| Dependencies or build configuration | [Dependency standard](./reference/dependency-standard.md) and [monorepo map](./reference/monorepo-map.md) |
| How long a stage takes, and on which harness | [Benchmarks](./reference/benchmarks.md) |

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

It runs formatting, architecture, licence, vendor-ledger, lint, typecheck, and
build targets, then the `test` and `dogfood-test` targets together. The adapter
build includes Rennet's first-party native executable and
therefore needs the host C toolchain described in the
[dependency standard](./reference/dependency-standard.md). Before editing documentation, read the
[docs style guide](./contributing/docs-style-guide.md) and the
[good docs standard](./contributing/good-docs-standard.md).
