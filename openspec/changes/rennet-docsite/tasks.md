# Tasks — rennet-docsite

Read `design.md` + `~/expedition/Rennet Docsite Framework.md` first (exact snippets there). Gate: `NX_DAEMON=false pnpm check` stays green, plus the new `apps/docs` build succeeds. Do NOT migrate all 56 docs — a representative first batch only (design.md phasing).

## 1. Scaffold the Starlight app
- [ ] 1.1 Create `apps/docs` as a pnpm-workspace Astro + Starlight app (matching versions to what learn.chatgpt.com uses is not required; use current stable Astro + `@astrojs/starlight`). Wire it into `pnpm-workspace.yaml` and Nx (build target = `astro build`, output `apps/docs/dist`; a `serve`/dev target that is non-cacheable).
- [ ] 1.2 Confirm `pnpm check` still green and `apps/docs` builds a static `dist/`.

## 2. Two content areas
- [ ] 2.1 Add `starlight-sidebar-topics` (HiDeoo). Define two topics: **Using Rennet** and **Developing Rennet**, each with its own deep sidebar (Guide / Concepts / Reference / Recipes shape).
- [ ] 2.2 Content lives under `apps/docs/src/content/docs/{using,developing}/…` as plain `.md`/`.mdx`. Add the top-level topic switcher.

## 3. beautiful-mermaid
- [ ] 3.1 Add `beautiful-mermaid`; wire a build-time rehype/remark hook replacing ```mermaid fences with `renderMermaidSVG()` output (light/dark themed SVG via CSS custom properties, bound to Starlight's theme). No headless browser. Snippet in the framework note.
- [ ] 3.2 Prove it: a doc with a mermaid diagram renders a themed SVG that toggles light/dark.

## 4. The agent-maintenance layer (the point)
- [ ] 4.1 Write the docs writing/style guide (`developing/…/docs-style-guide`): voice, page structure, the two-audience split, when to use a diagram.
- [ ] 4.2 Write the "good Rennet docs" standard (what every page must carry).
- [ ] 4.3 Add an `AGENTS.md` instruction (root, or a `docs/AGENTS.md`): any monorepo change updates the affected docs *in the same change*, with mermaid where it clarifies. This is the standing auto-update obligation.

## 5. Migrate a representative first batch (NOT all 56)
- [ ] 5.1 Pick ~6-10 existing `docs/*.md` that exercise both areas + ≥1 mermaid diagram (e.g. Product & Vision + a Using guide; Architecture Contracts + Delivery Order + a Developing/contributing guide). Convert to Starlight frontmatter + place in the right area. Add at least one architecture/flow mermaid diagram.
- [ ] 5.2 Leave the remaining docs in `docs/` untouched; note the full migration as follow-up.

## 6. CI → Cloudflare Pages (preview-first)
- [ ] 6.1 Add a GitHub Actions workflow: on `apps/docs/**` change, `astro build`, then deploy `dist/` to a Cloudflare Pages project via `wrangler pages deploy` using a `CLOUDFLARE_API_TOKEN` repo secret (Pages:Edit). Deploy to the `*.pages.dev` preview — do NOT block on the custom domain.
- [ ] 6.2 Document the two external prerequisites in the PR (rennet.dev → Cloudflare zone; the Pages project + token secret) so Rai can wire the custom domain after.

## 7. Pin OpenSpec + finish
- [ ] 7.1 Add `@fission-ai/openspec` to rennet devDependencies; confirm `openspec validate rennet-docsite --strict` runs via the repo.
- [ ] 7.2 Full gate green + `apps/docs` builds. Open the PR as `xp-navi` against `rbutera/rennet` with a body that: names the framework choice + why, lists the two external setup items, and states what is deferred (remaining docs, marketing site, custom domain).
