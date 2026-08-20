---
name: docs-audit
description: Use when Rennet documentation may disagree with current code, accepted OpenSpec behavior, the Nx graph, or live plans.
---

# Docs audit

Check the complete current documentation corpus and return evidence-backed
findings. `docs-refresh` consumes the result.

## Ground truth

Rule Zero in `AGENTS.md` outranks every other source. After that, classify each
claim before resolving it:

1. Current behavior comes from code, tests, resolved Nx configuration, and
   package manifests.
2. Accepted behavior comes from `openspec/specs/*/spec.md`.
3. Planned behavior needs a live GitHub issue or active OpenSpec change.
4. Product intent comes from `docs/using/concepts/product-and-vision.md`.
5. Scoped engineering decisions come from the authority map in
   `docs/developing/reference/doc-architecture.md`.

Code comments are leads, not proof. When current code and an accepted spec
disagree, report the implementation as current and the spec as planned. Verify
the tracking source before calling the gap planned.

## Method

1. Read `docs/README.md`. Its links are the canonical reader-page inventory.
2. Include the root authorities, current repository READMEs, ADRs, and every
   promoted OpenSpec file named by the documentation audit inventory.
3. Split the files into disjoint groups and inspect them in parallel.
4. Read every assigned file in full. Check commands, paths, package names,
   versions, interface labels, feature state, and internal links against the
   sources above.
5. Run a separate readability pass over each file. Check first-use jargon,
   orientation, sentence density, headings, and whether a table or Mermaid
   diagram would make a complex relationship clearer.
6. Run `node scripts/check-docs.mjs .` for inventory, links, planned metadata,
   projection parity, and monorepo-map drift.
7. Collate the reports. Verify conflicting findings directly, remove
   duplicates, and rank the remainder.

Before restructuring a generated or test-pinned block, search tests for the
page path. Edit around a pinned block unless the owning test changes with it.

## Findings format

```text
## <path>
Verdict: ACCURATE | STALE | INCOMPLETE | UNCLEAR
Findings:
- [high|medium|low] <claim> | evidence: <source:line> | fix: <one line>
```

Verdicts may be combined. Record verified facts for an accurate page so the
result proves that the reviewer checked it. Discard any finding without cited
evidence.

No finding may propose a consent gate, confirmation ceremony, capability
restriction, or robustness work detached from Rennet's job.
