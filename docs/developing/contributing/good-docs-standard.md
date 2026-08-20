---
title: Good Rennet docs standard
description: The completion criteria for every current or planned Rennet documentation page.
---

A page is complete when it meets this standard. The [style guide](./docs-style-guide.md) covers prose; this page covers required content and checks.

## Every page must have

1. **Frontmatter** with a `title` and a `description`. The description is one
   sentence that says what the page is for; it is used in search and social
   cards.
2. **A purpose line up top**: one or two sentences before the first heading,
   telling the reader what they are about to get.
3. **The right area.** Using or Developing, never both. See the [style
   guide](./docs-style-guide.md).
4. **Working links.** Every internal page and heading link resolves from the canonical Markdown and the rendered site.
5. **Examples where there is a how.** A command, a config snippet, a real path.
   Not a paraphrase of the code.
6. **A diagram where a flow or architecture is clearer seen than read**, written as a
   build-time mermaid fence, themed light/dark.
7. **Explicit planned status.** A page for unimplemented behavior declares `status: planned` and a live `tracking` URL. Current pages carry no status.

## A change to code updates its docs

When a monorepo change alters behaviour, a contract, a command, or an
architecture boundary, the **same change** updates the doc that describes it. The
test is simple:

> If someone reads the docs after this change and is now wrong, the change is not
> done.

This is the standing obligation stated in the root `AGENTS.md`. It is enforced
the same way the rest of Rennet's discipline is: it is part of the definition of
done, not a separate chore.

## What "affected docs" means

- A package boundary or dependency arrow: update the
  [architecture overview](../concepts/architecture-overview.md) and
  [architecture contracts](../concepts/architecture-contracts.md).
- A user-facing flow: update the relevant page under **Using Rennet**.
- The build or repository gate: update the relevant reference page and the
  [developing landing page](../index.md).
- A documentation convention: update this standard and the style guide.

If a change needs a new page, add it to the right area and to `docs/README.md`. Do not add an untracked placeholder.

## Periodic drift sweeps

Two repository skills check the full corpus:

- **`docs-audit`** (`.claude/skills/docs-audit/`): parallel verification of every
  page against promoted OpenSpec specifications and current source. It emits
  an evidence-cited findings list.
- **`docs-refresh`** (`.claude/skills/docs-refresh/`): consumes an audit, fixes
  only what the audit proved, runs the gate, and opens a PR.

Run both after a feature changes several pages or whenever a claim disagrees with current code or an accepted contract.
