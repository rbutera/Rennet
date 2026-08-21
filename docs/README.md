# Rennet documentation

This directory is the canonical documentation library. GitHub renders these
files as you browse. `apps/docs` projects the same files into Starlight for
[docs.rennet.dev](https://docs.rennet.dev); the site homepage stays with the
renderer because it uses Starlight components.

Every page belongs to one of two audiences: **Using Rennet** for people who run
reviews, and **Developing Rennet** for people who build Rennet.

## Using Rennet

- [Start here](./using/index.md)
- Concepts: [product and vision](./using/concepts/product-and-vision.md) and
  [common questions](./using/concepts/common-questions.md)
- Guides: [getting started](./using/guides/getting-started.md),
  [connecting to GitHub](./using/guides/github-auth.md),
  [reviewing a GitHub PR](./using/guides/reviewing-a-github-pr.md),
  [the Context Map](./using/guides/context-map.md),
  [remote access](./using/guides/remote-access.md),
  [browser use](./using/guides/browser-rennet.md),
  [planned mobile use](./using/guides/mobile.md), and
  [Windows with WSL](./using/guides/windows-and-wsl.md)

## Developing Rennet

- [Start here](./developing/index.md)
- Concepts: [architecture overview](./developing/concepts/architecture-overview.md),
  [architecture contracts](./developing/concepts/architecture-contracts.md),
  [canvas model](./developing/concepts/canvas-model.md),
  [review lenses](./developing/concepts/review-lenses.md),
  [context assembly](./developing/concepts/context-assembly.md),
  [code intelligence](./developing/concepts/code-intelligence.md),
  [Model Council](./developing/concepts/model-council.md),
  [surfacing and routing](./developing/concepts/surfacing-and-routing.md),
  [harness adapters](./developing/concepts/harness-adapters.md),
  [the WSL daemon](./developing/concepts/wsl-daemon.md),
  [agent handoff](./developing/concepts/agent-handoff.md),
  [delta re-review and lineage](./developing/concepts/delta-rereview-and-lineage.md),
  [comment refinement](./developing/concepts/comment-refinement.md),
  [collation and publishing](./developing/concepts/collation-and-publishing.md),
  and [design doctrine](./developing/concepts/design-doctrine.md)
- Guides: [repository bootstrap](./developing/guides/repository-bootstrap.md)
  and [settings and setup](./developing/guides/settings-and-setup.md)
- [Decisions](./developing/decisions/contracts-and-rulings.md): the cross-cutting
  decision register
- [ADRs](./adr/0001-tray-quit-owns-the-daemon.md): narrow architectural
  decisions, including the
  [root documentation library](./adr/0002-root-docs-own-the-library.md)
- Reference: [documentation authority](./developing/reference/doc-architecture.md),
  [monorepo map](./developing/reference/monorepo-map.md),
  [dependency standard](./developing/reference/dependency-standard.md),
  [protocol compatibility](./developing/reference/protocol-compatibility.md),
  [Codex app-server integration](./developing/reference/codex-app-server.md),
  and [reactive streams](./developing/reference/reactive-streams.md)
- Contributing: [docs style guide](./developing/contributing/docs-style-guide.md),
  [good docs standard](./developing/contributing/good-docs-standard.md),
  and [reader personas](./developing/contributing/personas.md)

Planned pages carry a live issue or OpenSpec tracking link in their frontmatter.
[GitHub issues](https://github.com/rbutera/rennet/issues) own the work queue. The
library contains only current behavior and tracked plans.

## Authority

[Product and vision](./using/concepts/product-and-vision.md) owns product intent.
[Contracts and rulings](./developing/decisions/contracts-and-rulings.md) settles
cross-cutting conflicts. [Architecture contracts](./developing/concepts/architecture-contracts.md)
owns the review and persistence invariants, and the
[dependency standard](./developing/reference/dependency-standard.md) owns package
selection and toolchain choices. Accepted behavior lives in
[promoted OpenSpec specifications](../openspec/specs/).

Repository-level authorities keep their narrower jobs:

- [`PRODUCT.md`](../PRODUCT.md) is the product brief.
- [`DESIGN.md`](../DESIGN.md) is the visual authority.
- [`CONTEXT.md`](../CONTEXT.md) is the project glossary.
- [`AGENTS.md`](../AGENTS.md) is the working agreement and carries Rule Zero.

## Monorepo map

[The monorepo map](./developing/reference/monorepo-map.md) lists every Nx
application and package, its root, its responsibility, and its allowed
in-repository dependencies.
