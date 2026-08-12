# rennet-docsite

**Owner:** Navi (authored) → Opus subagent applies as a PR under `xp-navi`. **Review:** dogfood — Rai reads it in Rennet (the first Rennet PR). **Depends on:** nothing in-repo; two external setup items flagged below.
**Framework rationale (evidence):** `~/expedition/Rennet Docsite Framework.md`.

## Why

Rennet has 56 markdown design docs in `docs/` and no docsite. Rai wants a beautiful, agent-maintained documentation site at **docs.rennet.dev** with two audiences — people *using* Rennet and people *developing* it — and he wants the docset to stay current because agents update it as a matter of course, not because someone remembers to.

## What Changes

- **Add a Starlight docsite** at `apps/docs` (Astro Starlight). Chosen with evidence: one of Rai's three loved reference sites (learn.chatgpt.com/docs) *is* customised Starlight; it builds fully static (`astro build` → `dist/`) for **free Cloudflare Pages**; and `beautiful-mermaid` fits it better than any off-the-shelf Starlight mermaid option (synchronous, zero-DOM, no headless browser, one SVG themed light/dark via CSS variables — the same pre-rendered themed-SVG model Rai's favourite site uses).
- **Two content areas via `starlight-sidebar-topics`** — **Using Rennet** (end users) and **Developing Rennet** (contributors) — each with its own deep, multi-section sidebar (Guide / Concepts / Reference / Recipes shape), not a two-item nav.
- **Wire `beautiful-mermaid`** as a small build-time rehype/remark hook calling `renderMermaidSVG()`, emitting light/dark themed SVGs from ```mermaid fences. Exact snippet in the framework note.
- **The agent-maintenance layer (the point of this whole thing):** a docs **writing/style guide**, a **"what good Rennet docs look like"** standard, **mermaid-where-it-clarifies** guidance, and a **`docs/AGENTS.md`** (or a docs section in the root `AGENTS.md`) instructing any agent changing the monorepo to update the relevant docs *in the same change* — so the docset stays alive by construction.
- **CI: GitHub Actions → Cloudflare Pages.** On changes under `apps/docs/**` (and the migrated content), build Starlight and deploy to a Cloudflare Pages project. Ship to the `*.pages.dev` preview URL first; the custom domain `docs.rennet.dev` is wired once rennet.dev is on Cloudflare (external setup, below).
- **Pin the OpenSpec CLI** (`@fission-ai/openspec`) as a rennet devDependency so the propose/apply/archive workflow is reproducible in CI and for agents (currently global only).
- **Migrate a first representative batch** of the 56 `docs/*.md` into the two areas (enough to prove the structure + the mermaid rendering + the style guide), with the remaining docs migrated as follow-up. The existing hand-rolled `site/` marketing build stays as-is this PR; its relationship to the docsite is noted as follow-up.

## Acceptance

- `pnpm --filter @rennet/docs build` (or the Nx target) produces a static `dist/` that serves the two-area docsite locally, with working sidebars for both **Using** and **Developing**.
- A ```mermaid fence in a doc renders as a themed SVG that toggles light/dark — via `beautiful-mermaid`, no headless browser in the build.
- The GitHub Actions workflow builds and deploys the site to Cloudflare Pages (preview URL) on a docs change; it does not block on the custom domain.
- The agent-maintenance layer exists and is discoverable: a style guide, a docs standard, and an AGENTS.md instruction that an agent changing code updates the affected docs in the same change.
- `@fission-ai/openspec` is a rennet devDependency and `openspec validate` runs via the repo.
- The PR is opened by `xp-navi` against `rbutera/rennet`.

## Impact

- **New:** `apps/docs` (Starlight app + config + the two topic trees + the mermaid hook), a `.github/workflows/` docs-deploy workflow, the docs style guide + standard, an AGENTS.md docs instruction, a first batch of migrated docs, and the openspec devDep.
- **Untouched:** the desktop app, `packages/*`, and the existing `site/` marketing build.
- **Nx:** `apps/docs` joins the workspace; add its build/serve targets (Astro is a static build, not cacheable as `serve`).

## External setup (flagged, not blocking the PR — the PR ships against a `*.pages.dev` preview)

1. **rennet.dev → Cloudflare.** The domain is not yet on the Cloudflare account (verified). Add it as a zone (nameservers → Cloudflare); then `docs.rennet.dev` CNAMEs to the Pages project. Rai's Cloudflare token is account-scoped and valid; a Pages-scoped deploy token (or `CLOUDFLARE_API_TOKEN` secret with Pages:Edit) is needed for the Actions deploy.
2. **Cloudflare Pages project** creation (one-time), name referenced by the workflow.

## Deferred (named, out of scope for this PR)

- Migrating all 56 docs (first batch proves the system; the rest follow).
- Folding / rebuilding the `site/` marketing site on the same stack.
- The custom domain cutover (needs rennet.dev on Cloudflare first).
- No gate, consent step, or ceremony (Rule Zero) — this is additive tooling.
