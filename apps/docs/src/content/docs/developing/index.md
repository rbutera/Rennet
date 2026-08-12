---
title: Developing Rennet
description: Documentation for people building Rennet itself.
---

This area is for **building** Rennet — the architecture, the contracts between
packages, the delivery order, and the doctrine that keeps the codebase honest.
If you just want to run reviews, switch to [Using Rennet](/using/) in the
sidebar.

## Where to start

- **[Architecture overview](/developing/concepts/architecture-overview/)** — the review pipeline at a glance, with a diagram.
- **[Architecture contracts](/developing/concepts/architecture-contracts/)** — the boundaries between packages and why they hold.
- **[Design doctrine](/developing/concepts/design-doctrine/)** — the principles the code is written against.
- **[Delivery order](/developing/reference/delivery-order/)** — the sequence the product is built in.

## Contributing

- **[Docs style guide](/developing/contributing/docs-style-guide/)** — how to write a Rennet doc.
- **[Good Rennet docs standard](/developing/contributing/good-docs-standard/)** — what every page must carry.

Rennet is a pnpm + Nx monorepo. The gate is `pnpm check`
(`format · architecture · licenses · lint · typecheck · test · build`); a change
is not done until it is green.
