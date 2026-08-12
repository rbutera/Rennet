---
title: Good Rennet docs standard
description: What every Rennet doc page must carry to count as done — the checklist an agent applies before a change is complete.
---

This is the bar. A doc page — new or updated as part of a code change — is not
done until it meets it. The [style guide](/developing/contributing/docs-style-guide/)
is *how* to write; this is *what must be true* when you stop.

## Every page must have

1. **Frontmatter** with a `title` and a `description`. The description is one
   sentence that says what the page is for; it is used in search and social
   cards.
2. **A purpose line up top** — one or two sentences before the first heading,
   telling the reader what they are about to get.
3. **The right area.** Using or Developing, never both. See the [style
   guide](/developing/contributing/docs-style-guide/).
4. **Working links.** No links to pages that do not exist. If you reference
   something not yet written, say "(not yet documented)" rather than linking a
   dead route.
5. **Examples where there is a how.** A command, a config snippet, a real path.
   Not a paraphrase of the code.
6. **A diagram where a flow or architecture is clearer seen than read** — as a
   build-time mermaid fence, themed light/dark.

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

- Changed a package boundary or dependency arrow →
  [architecture overview](/developing/concepts/architecture-overview/) and
  [architecture contracts](/developing/concepts/architecture-contracts/).
- Changed a user-facing flow → the relevant page under **Using Rennet**.
- Changed the build, the gate, or the delivery sequence →
  [delivery order](/developing/reference/delivery-order/) and the developing
  landing page.
- Added a doc convention → this standard and the style guide.

If a change touches something with no doc yet, the smallest honest fix is a stub
page in the right area that says what the thing is and links the code — an empty
page with a real name beats a correct fact nobody can find.
