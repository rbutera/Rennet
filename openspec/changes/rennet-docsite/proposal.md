# rennet-docsite

**Owner:** Navi (authored) → Opus subagent applies as a PR under `xp-navi`. **Review:** dogfood — Rai reads it in Rennet (the first Rennet PR). **Depends on:** nothing in-repo; two external setup items flagged below.
**Framework rationale (evidence):** `~/expedition/Rennet Docsite Framework.md`.

## Why

Rennet's historical planning set needed one usable, agent-maintained home at **docs.rennet.dev** with two audiences — people *using* Rennet and people *developing* it — and a maintenance rule that keeps current product truth from drifting.

## What Changes

- **Add a Starlight docsite** at `docs` (Astro Starlight). Chosen with evidence: one of Rai's three loved reference sites (learn.chatgpt.com/docs) *is* customised Starlight; it builds fully static (`astro build` → `dist/`) for **free Cloudflare Pages**; and `beautiful-mermaid` fits it better than any off-the-shelf Starlight mermaid option (synchronous, zero-DOM, no headless browser, one SVG themed light/dark via CSS variables — the same pre-rendered themed-SVG model Rai's favourite site uses).
- **Two content areas via `starlight-sidebar-topics`** — **Using Rennet** (end users) and **Developing Rennet** (contributors) — each with its own deep, multi-section sidebar (Guide / Concepts / Reference / Recipes shape), not a two-item nav.
- **Wire `beautiful-mermaid`** as a small build-time rehype/remark hook calling `renderMermaidSVG()`, emitting light/dark themed SVGs from ```mermaid fences. Exact snippet in the framework note.
- **The agent-maintenance layer (the point of this whole thing):** a docs **writing/style guide**, a **"what good Rennet docs look like"** standard, **mermaid-where-it-clarifies** guidance, and a **`docs/AGENTS.md`** (or a docs section in the root `AGENTS.md`) instructing any agent changing the monorepo to update the relevant docs *in the same change* — so the docset stays alive by construction.
- **CI: GitHub Actions → Cloudflare Pages.** On changes under `docs/**`, build Starlight and deploy the `rennet-docs` Pages project. Pull requests use preview branches; `main` is served at `docs.rennet.dev`.
- **Pin the OpenSpec CLI** (`@fission-ai/openspec`) as a rennet devDependency so the propose/apply/archive workflow is reproducible in CI and for agents (currently global only).
- **Migrate the useful legacy material** into focused current pages, delete the retired planning files from the working tree, and keep their history recoverable through Git.

## Acceptance

- `pnpm --filter @rennet/docs build` (or the Nx target) produces a static `dist/` that serves the two-area docsite locally, with working sidebars for both **Using** and **Developing**.
- A ```mermaid fence in a doc renders as a themed SVG that toggles light/dark — via `beautiful-mermaid`, no headless browser in the build.
- The GitHub Actions workflow builds and deploys the site to Cloudflare Pages on a docs change; pull requests remain preview deployments.
- The agent-maintenance layer exists and is discoverable: a style guide, a docs standard, and an AGENTS.md instruction that an agent changing code updates the affected docs in the same change.
- `@fission-ai/openspec` is a rennet devDependency and `openspec validate` runs via the repo.
- The PR is opened by `xp-navi` against `rbutera/rennet`.

## Impact

- **New:** root `docs` Starlight app + config + two topic trees + mermaid hook, a docs-deploy workflow, the docs style guide + standard, an AGENTS.md docs instruction, the migrated authority set, and the OpenSpec dev dependency.
- **Untouched:** the desktop app, `packages/*`, and the existing `site/` marketing build.
- **Nx:** `docs` joins the workspace; add its build/serve targets (Astro is a static build, not cacheable as `serve`).

## External setup

The `rennet-docs` Cloudflare Pages project, repository secrets, and
`docs.rennet.dev` custom domain are configured and live.

## Deferred (named, out of scope for this PR)

- Folding / rebuilding the `site/` marketing site on the same stack.
- No gate, consent step, or ceremony (Rule Zero) — this is additive tooling.
