## Context

Starlight 0.41.7 expects its collection at `<srcDir>/content/docs`. Navigation,
Markdown processing, and Git dates all use that path. Root `docs/` must expose
the canonical pages directly to GitHub readers, while Nx and the Cloudflare
workflow must react to changes in either the renderer or the content.

The documentation corpus has four jobs. Public guides explain the product.
Project authorities define intent and architecture. Promoted OpenSpec files
define accepted behavior. Archived changes preserve evidence. Only current and
explicitly planned material belongs in the documentation library.

## Goals and non-goals

Goals:

- Keep one committed copy of every reader-facing page.
- Preserve normal Starlight routing, navigation, Mermaid rendering, Git dates, and development reloads.
- Make omissions and broken links detectable without generating the prose itself.
- Give every current or planned file a fact audit and a full prose edit.
- Keep authorities scoped and explicit.

Non-goals:

- Change product runtime behavior as part of the documentation move.
- Publish retired plans or explain how the current design evolved.
- Rewrite archived OpenSpec task history.
- Add a new hosted service or remote cache.

## Decisions

### Root docs own the source

Canonical pages live at `docs/using`, `docs/developing`, and `docs/adr`.
`docs/README.md` is the GitHub entry point. The docs app keeps its site-only
homepage under `apps/docs` because the MDX uses Starlight components and has a
different job from the repository map.

Page links use source-relative Markdown paths. Starlight resolves them during build, while GitHub opens the same files directly. Current routes do not need compatibility redirects.

### The app consumes an ignored projection

`apps/docs` mirrors canonical pages into an ignored `src/content/docs` directory
before Astro sync, build, preview, or development. An Astro integration watches
root docs through Vite and applies add, change, and unlink events. Each initial
sync deletes stale projected files before copying the canonical tree.

Route middleware maps projected paths back to `docs/...` for source links and Git-derived update dates. The projection never appears in links and never enters Git.

A custom Astro content loader cannot satisfy the Starlight code that reads the
fixed path outside the loader. A symlink is unreliable across Git checkouts on
supported Windows setups.

### Nx models content as a dependency of the renderer

Root docs get a content-only Nx project. `rennet-docs` declares an implicit
dependency on it, and its production inputs include that project plus
`rennet-theme`. Build outputs remain under `apps/docs`. Affected calculation and
cache invalidation then follow the real build inputs.

The deployment workflow watches `apps/docs/**`, `docs/**`, and `packages/theme/**`, then deploys `apps/docs/dist`.

### Navigation separates current facts from plans

The site keeps the Using Rennet and Developing Rennet audiences. Developing
Rennet separates concepts, guides, decisions, reference, plans, and contributing
material. A current page owns each useful conclusion. Archive material does not
get a reader-facing section.

Current pages need no status label. A planned page carries `status: planned` and a live tracking link. There is no historical status.

### Authorities have narrow owners

`PRODUCT.md` remains the Impeccable product brief and defers to Product and
vision for canonical product intent. `DESIGN.md` remains the visual authority.
`CONTEXT.md` remains the Matt Pocock glossary and contains no implementation
detail. Contracts and rulings owns cross-cutting decisions. Promoted specs own
accepted behavior. ADRs explain narrow architectural choices but cannot
overrule Rule Zero or a scoped authority.

### Checks validate structure, not writing quality

A documentation check validates the canonical inventory, source-relative links
and headings, planned-page tracking fields, Starlight projection parity, and the
monorepo map against resolved Nx projects and package manifests. Human review
owns factual judgment and prose quality. The check neither scores style nor
generates prose.

### Audit ownership is explicit

The corpus is split into disjoint review groups. Each file receives a fact result and a prose result. Reviewers use current code, tests, resolved Nx configuration, manifests, and scoped authorities as evidence. Numeric inventories are generated or checked rather than copied by hand.

Archived changes keep their task boxes. Completed stale changes archive normally. Retired partial changes receive a concise outcome note before archive, with unfinished tasks left unchecked.

## Risks and trade-offs

- Generated projection code can leave stale files. The initial sync deletes the old projection, watcher tests cover deletion, and parity runs before the build.
- External content can be omitted from cache keys. The separate Nx content project and affected proof cover this explicitly.
- A large prose edit can introduce factual regressions. Parallel ownership, source citations during audit, full-site build, and independent Codex and Claude PR reviews provide separate checks.
- Direct GitHub links and site routes can disagree. Link validation resolves both the canonical file and the built route.
- Promoted specs can still disagree with runtime code. The audit records current mismatches as planned work instead of describing a future contract as shipped behavior.

## Migration plan

1. Move the renderer and establish the projection with tests.
2. Move canonical pages into the root library and convert internal links.
3. Rebuild navigation and add the repository and monorepo maps.
4. Audit current pages, root authorities, READMEs, ADRs, and promoted specs.
5. Archive stale OpenSpec changes and promote the corrected contract deltas.
6. Run affected checks, projection and link proofs, the docs build, and `pnpm check`.
7. Merge only after independent Codex and Claude reviews are resolved.

Rollback is a normal Git revert. The generated projection is ignored, so no reader content depends on recovering build output.
