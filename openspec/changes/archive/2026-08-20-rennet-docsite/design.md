# Design — rennet-docsite

Full framework evidence + comparison table + exact snippets: `~/expedition/Rennet Docsite Framework.md`. This file is the decisions summary.

## Framework: Astro Starlight (not VitePress, not Fumadocs)

- **Verified aesthetic match:** learn.chatgpt.com/docs — one of Rai's three loved sites — is customised Astro Starlight (`generator: Astro v6.0.4` + Starlight signature). code.claude.com (his favourite) is Mintlify (paid SaaS, can't self-host; its diagrams are pre-rendered themed SVGs, not live mermaid). cursor.com/docs is bespoke Next.js.
- **Free static Cloudflare Pages:** `astro build` → `dist/`, no SSR/runtime. Fumadocs was rejected here — it is server-first and its free-static-CF story is the one hard requirement that does not bend. VitePress is the low-risk fallback (proven beautiful-mermaid, Rai knows it) but less aesthetic proximity.

## beautiful-mermaid integration

Wire as a build-time **rehype/remark hook** that finds ```mermaid fences and replaces them with `renderMermaidSVG()` output. `beautiful-mermaid` (lukilabs, v1.1.3) is synchronous, zero-DOM, needs **no headless browser** (unlike `rehype-mermaid`/Playwright), and emits one SVG themed light/dark via CSS custom properties — matching the pre-rendered themed-SVG model of Rai's favourite site, and reusing the exact library already proven in his Lumiere docs. Keep the catppuccin light/dark toggle bound to Starlight's theme.

## Two areas: `starlight-sidebar-topics`

Use the `starlight-sidebar-topics` plugin (HiDeoo) to give **Using Rennet** and **Developing Rennet** each an independent, deep sidebar. Top-level switcher between the two topics; within each, a Guide / Concepts / Reference / Recipes shape. Content lives as plain `.md`/`.mdx` under `docs/src/content/docs/{using,developing}/…` so an agent edits files + one config, nothing bespoke.

## The agent-maintenance layer

This is the requirement Rai cares most about — the docset stays alive because agents maintain it:
- **Writing/style guide** (`developing/contributing/docs-style-guide.md`): voice, structure, when to use a diagram, the two-audience split.
- **"Good Rennet docs" standard**: what a page must have (purpose up top, examples, a diagram where it clarifies a flow/architecture).
- **`AGENTS.md` instruction**: any change to the monorepo updates the affected docs *in the same change*; mermaid diagrams where they clarify. This is the "auto-update" — not (only) a CI job, but a standing agent obligation, enforced the same way Rule Zero and the wave discipline are.

## CI / deploy

GitHub Actions on `docs/**` changes: `astro build`, then deploy `dist/` to the `rennet-docs` Cloudflare Pages project with a Pages-scoped token. Pull requests use preview branches; `main` is the production branch behind `docs.rennet.dev`.

## Migration completion

The initial scaffold proved the two-area structure, Mermaid rendering, deployment, and maintenance layer. The completion pass moved the site to root `docs`, rewrote the useful legacy authority into focused pages, and removed the retired planning set from the working tree.
