---
name: docs-audit
description: Use when the Rennet docsite may have drifted from shipped behavior — after a feature wave merges, when the delivery-order stamp is older than the latest feat commits, on a periodic sweep, or when someone reports a doc page that reads wrong or contradicts another page.
---

# Docs audit

Fan-out verification of `docs/src/content/docs/**` against what actually shipped. Output is a findings list with evidence, not edits — `docs-refresh` consumes it.

## Ground truth, in priority order

1. `openspec/specs/<area>/spec.md` — shipped behavior.
2. Source: `packages/{types,protocol,core,adapters,ui,instructions}`, `apps/desktop`.
3. Root config: `package.json`, `nx.json`, `pnpm-workspace.yaml`, `AGENTS.md`.
4. `git log` (last ~40 commits) and GitHub issue state (`gh issue view N --repo rbutera/rennet --json state`).

**Code comments are NOT ground truth.** A stale "out of scope" comment once contradicted a merged feature; the commit + closed issue decided it. When any two sources disagree, whoever is collating (the orchestrator in fan-out mode, the sole agent in solo mode) verifies directly against git log + issue state before recording the finding.

## Method

1. Inventory: `find docs/src/content/docs -name '*.md' -o -name '*.mdx'` (~32 pages).
2. Slice into ~5-page groups by section: using/, concepts (arch+UI), concepts (harness+council), concepts (pipeline), reference/, guides+contributing+indexes.
3. One read-only subagent per slice (opus), in parallel. Each agent: read every assigned page fully, verify every concrete claim (commands, paths, package names, versions, feature liveness, UI descriptions), judge human readability.
4. One slice also sweeps cross-cutting: every internal link resolves, every page has `title:` + `description:` frontmatter, every `docs/astro.config.mjs` sidebar entry maps to a file, no orphans.
5. Orchestrator collects reports, resolves inter-agent conflicts itself (rule above), dedupes, ranks.

## Findings format (require it from every agent)

```
## <path>
Verdict: ACCURATE | STALE | INCOMPLETE | UNCLEAR (combinable)
Findings:
- [high|med|low] <issue> — evidence: <spec/source file:line or commit> — fix: <one line>
```

A finding without cited evidence is discarded. Verified-clean claims get one
line too ("verified: paths, links, frontmatter, X, Y") — a page with a bare
ACCURATE verdict and nothing else reads like the agent gave up, not like it
checked. A code block that abstracts a real contract (a teaching type not named
in source) is not a finding if its shape matches the source; suggest an
"(illustrative)" tag instead.

## Known drift patterns (check these first)

- **"Next seam" / "not yet wired" claims** outdate fastest. Verify each against the spec area and the closing commit before trusting.
- **Status cells in authority pages** (`architecture-contracts.md` table, `contracts-and-rulings.md` rulings) lag one delivery cycle. Flag status only — never propose changing a recorded decision.
- **`delivery-order.md`** — check its "Last checked" stamp and finished/next claims against `openspec/changes/archive` + git log.
- **Harness coverage** — pages that name harnesses must reflect all live seats (Claude, Codex, omp) and WSL execution where relevant.
- **The same fact stated on multiple pages** drifts unevenly; when one page is verified current, reconcile the others against it.

## Rule Zero

No finding may propose a gate, confirmation, warning, or restrictive language. Findings that do get dropped, not softened.
