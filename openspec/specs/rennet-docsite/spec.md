# rennet-docsite Specification

## Purpose
Defines the static Starlight renderer, its two reader audiences, build-time Mermaid output, contribution rules, and production deployment.
## Requirements
### Requirement: A static, two-audience documentation site
The system SHALL provide an Astro Starlight application at `apps/docs` that builds to static files under `apps/docs/dist`. It SHALL present "Using Rennet" and "Developing Rennet" as independent content areas with separate multi-section sidebars.

#### Scenario: Both areas have independent deep sidebars
- **WHEN** the docsite is built and the reader switches between the Using and Developing topics
- **THEN** each topic shows its own full sidebar tree, not a shared two-item nav

#### Scenario: The build is static and runtime-free
- **WHEN** `rennet-docs` is built
- **THEN** it produces a static `dist/` servable by Cloudflare Pages with no SSR or server runtime

### Requirement: Mermaid diagrams render as themed SVGs without a headless browser
The docsite SHALL render ```mermaid fences as SVG via `beautiful-mermaid` at build time, themed for light and dark, without invoking a headless browser.

#### Scenario: A mermaid fence becomes a themed SVG
- **WHEN** a doc containing a ```mermaid fence is built
- **THEN** the output is an inline SVG that toggles light/dark with the site theme, produced without launching a browser

### Requirement: Docs are agent-maintained by standing obligation
The repository SHALL carry a documentation style guide, a good-docs standard, and an `AGENTS.md` instruction that any change to the monorepo updates the affected documentation in the same change. Pages SHALL use Mermaid when a flow or architecture is clearer as a diagram.

#### Scenario: The obligation is discoverable and explicit
- **WHEN** an agent reads `AGENTS.md` before changing the monorepo
- **THEN** it finds the instruction to update affected docs in the same change, and a style guide + standard telling it how

### Requirement: CI deploys the docsite to Cloudflare Pages
The system SHALL build and deploy the docsite to the `rennet-docs` Cloudflare Pages project through GitHub Actions after changes under `apps/docs/**`, `docs/**`, or `packages/theme/**` land on `main`. Pull requests SHALL build the application through the repository check without running the deployment workflow.

#### Scenario: A docs change deploys to production
- **WHEN** a renderer, canonical content, or shared-theme change lands on `main` and the workflow runs
- **THEN** the site builds and deploys to the `docs.rennet.dev` production branch

#### Scenario: A pull request checks the site without deploying
- **WHEN** a pull request changes the renderer, canonical content, or shared theme
- **THEN** the repository gate builds `rennet-docs` and no docs deployment runs
