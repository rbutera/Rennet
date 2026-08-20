## Purpose

Defines one GitHub-readable documentation library for Rennet and the separate static application that renders it as the public documentation site.

## ADDED Requirements

### Requirement: Root docs are the canonical documentation library

The repository SHALL keep the only committed copy of reader-facing Markdown directly under root `docs/`. The library SHALL contain a GitHub-rendered README that links to the public site and maps every current or planned section.

#### Scenario: A GitHub reader opens the docs directory

- **WHEN** a reader opens root `docs/` on GitHub
- **THEN** GitHub renders a README with a link to `docs.rennet.dev` and direct links into the documentation library

### Requirement: The docs app only renders the library

The Astro and Starlight application SHALL live under `apps/docs`. Any generated content projection SHALL be ignored by Git and derived from the root library before build or development.

#### Scenario: The site builds from canonical files

- **WHEN** the `rennet-docs` build runs
- **THEN** it renders the current root documentation library without requiring a second committed copy of any page

#### Scenario: A canonical page changes during development

- **WHEN** a page is added, changed, or removed while the docs development server runs
- **THEN** the rendered site updates from that canonical change, including deletions

### Requirement: Documentation describes current or planned Rennet only

Reader-facing documentation SHALL describe how Rennet works now or behavior that is explicitly planned. It SHALL NOT narrate retired designs, completed migrations, superseded terminology, or the history of how the current design was reached.

#### Scenario: A retired design has useful information

- **WHEN** an audit finds useful material inside a retired design or research page
- **THEN** the current fact is moved into the page that owns it and the retired narrative is excluded from the documentation library

#### Scenario: Planned behavior appears in docs

- **WHEN** a page describes behavior that is not implemented on `main`
- **THEN** the page marks that behavior as planned and links to its current tracking source

### Requirement: The library represents the whole monorepo

The documentation SHALL map every current Nx application and package, name its responsibility, and state its allowed in-repository dependencies. The inventory SHALL be checked against the resolved Nx project graph and package manifests.

#### Scenario: A project is added without documentation

- **WHEN** an Nx application or package exists without a matching monorepo-map entry
- **THEN** the documentation check fails and names the missing project

### Requirement: Documentation is readable in GitHub and on the site

Page-to-page links, headings, diagrams, and source references SHALL work from both the canonical Markdown files on GitHub and the rendered site.

#### Scenario: Internal links are checked

- **WHEN** the documentation check scans the root library
- **THEN** every internal page and heading link resolves to a canonical source file and the rendered site builds the same navigation target

### Requirement: Every current page receives a prose audit

Every current or planned page, README, ADR, and promoted spec SHALL be checked against `main` and rewritten where needed to use direct, specific language. The audit SHALL cover the whole file rather than only lines whose facts changed.

#### Scenario: The audit closes

- **WHEN** the documentation change is ready to merge
- **THEN** every in-scope file has an assigned audit result and the full repository gate passes
