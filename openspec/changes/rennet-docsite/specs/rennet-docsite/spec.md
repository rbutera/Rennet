## ADDED Requirements

### Requirement: A static, two-audience documentation site
The system SHALL provide a documentation site (`docs`, Astro Starlight) that builds fully static (`astro build` → `dist/`) and presents two independent content areas — "Using Rennet" and "Developing Rennet" — each with its own deep multi-section sidebar.

#### Scenario: Both areas have independent deep sidebars
- **WHEN** the docsite is built and the reader switches between the Using and Developing topics
- **THEN** each topic shows its own full sidebar tree, not a shared two-item nav

#### Scenario: The build is static and runtime-free
- **WHEN** `docs` is built
- **THEN** it produces a static `dist/` servable by Cloudflare Pages with no SSR or server runtime

### Requirement: Mermaid diagrams render as themed SVGs without a headless browser
The docsite SHALL render ```mermaid fences as SVG via `beautiful-mermaid` at build time, themed for light and dark, without invoking a headless browser.

#### Scenario: A mermaid fence becomes a themed SVG
- **WHEN** a doc containing a ```mermaid fence is built
- **THEN** the output is an inline SVG that toggles light/dark with the site theme, produced without launching a browser

### Requirement: Docs are agent-maintained by standing obligation
The repository SHALL carry a docs writing/style guide, a "good docs" standard, and an `AGENTS.md` instruction that any change to the monorepo updates the affected documentation in the same change, using mermaid diagrams where they clarify a flow or architecture.

#### Scenario: The obligation is discoverable and explicit
- **WHEN** an agent reads `AGENTS.md` before changing the monorepo
- **THEN** it finds the instruction to update affected docs in the same change, and a style guide + standard telling it how

### Requirement: CI deploys the docsite to Cloudflare Pages
The system SHALL build and deploy the docsite to the `rennet-docs` Cloudflare Pages project via GitHub Actions on changes under `docs/**`, using preview branches for pull requests and the production branch for `main`.

#### Scenario: A docs change deploys to the matching environment
- **WHEN** a change under `docs/**` lands and the workflow runs
- **THEN** the site builds and deploys to a preview branch for a pull request or the `docs.rennet.dev` production branch for `main`
