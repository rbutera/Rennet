# Tasks — rennet-docsite

Read `design.md` first. Gate: `pnpm check` stays green and the root `docs` build succeeds.

## 1. Scaffold the Starlight app
- [x] 1.1 Create `docs` as a pnpm-workspace Astro + Starlight app (matching versions to what learn.chatgpt.com uses is not required; use current stable Astro + `@astrojs/starlight`). Wire it into `pnpm-workspace.yaml` and Nx (build target = `astro build`, output `docs/dist`; a `serve`/dev target that is non-cacheable).
- [x] 1.2 Confirm `pnpm check` still green and `docs` builds a static `dist/`.

## 2. Two content areas
- [x] 2.1 Add `starlight-sidebar-topics` (HiDeoo). Define two topics: **Using Rennet** and **Developing Rennet**, each with its own deep sidebar (Guide / Concepts / Reference / Recipes shape).
- [x] 2.2 Content lives under `docs/src/content/docs/{using,developing}/…` as plain `.md`/`.mdx`. Add the top-level topic switcher.

## 3. beautiful-mermaid
- [x] 3.1 Add `beautiful-mermaid`; wire a build-time rehype/remark hook replacing ```mermaid fences with `renderMermaidSVG()` output (light/dark themed SVG via CSS custom properties, bound to Starlight's theme). No headless browser. Snippet in the framework note.
- [x] 3.2 Prove it: a doc with a mermaid diagram renders a themed SVG that toggles light/dark.

## 4. The agent-maintenance layer (the point)
- [x] 4.1 Write the docs writing/style guide (`developing/…/docs-style-guide`): voice, page structure, the two-audience split, when to use a diagram.
- [x] 4.2 Write the "good Rennet docs" standard (what every page must carry).
- [x] 4.3 Add an `AGENTS.md` instruction (root, or a `docs/AGENTS.md`): any monorepo change updates the affected docs *in the same change*, with mermaid where it clarifies. This is the standing auto-update obligation.

## 5. Migrate the useful legacy material
- [x] 5.1 Rewrite the current product, architecture, integration, and contributor authority into the two audience trees with Mermaid where it clarifies.
- [x] 5.2 Remove retired planning, spike, review, and state files from the working tree; keep them recoverable through Git history.

## 6. CI → Cloudflare Pages
- [x] 6.1 Build on root `docs/**` changes and deploy `docs/dist` to `rennet-docs`; use preview branches for pull requests and production for `main`.
- [x] 6.2 Configure the Pages project, repository secrets, and `docs.rennet.dev` custom domain.

## 7. Pin OpenSpec + finish
- [x] 7.1 Add `@fission-ai/openspec` to rennet devDependencies; confirm `openspec validate rennet-docsite --strict` runs via the repo.
- [x] 7.2 Full gate green + root `docs` build.
