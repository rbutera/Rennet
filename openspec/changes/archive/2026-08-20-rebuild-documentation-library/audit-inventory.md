# Documentation audit inventory

Every Markdown or MDX file in the current documentation corpus belongs to one
slice below. A slice closes only after a fact check against `main` and a
full-file `unslop` edit.

## Slice A: Using Rennet

- Site homepage
- `docs/using/index.md`
- Every file under `docs/using/concepts/`
- Every file under `docs/using/guides/`

## Slice B: Developing Rennet concepts

- `docs/developing/index.md`
- Every file under `docs/developing/concepts/`

## Slice C: Developing Rennet support pages

- Every file under `docs/developing/guides/`
- Every file under `docs/developing/decisions/`
- Every file under `docs/developing/reference/`
- Every file under `docs/developing/plans/`
- Every file under `docs/developing/contributing/`
- `docs/README.md`

## Slice D: Repository authorities and READMEs

- `AGENTS.md`
- `CONTEXT.md`
- `DESIGN.md`
- `PRODUCT.md`
- Root `README.md`
- `apps/README.md`
- `apps/desktop/PACKAGING.md`
- `brand/README.md`
- `brand/PROVENANCE.md`
- `packages/README.md`
- `packages/ui/DESIGN.md`
- `scripts/README.md`
- `.claude/skills/docs-audit/SKILL.md`
- `.claude/skills/docs-refresh/SKILL.md`
- Every current ADR under `docs/adr/`
- `openspec/changes/README.md`

## Slice E: Promoted behavioral contracts

- Every `openspec/specs/*/spec.md`
- Every artifact under `openspec/changes/rebuild-documentation-library/`

## Evidence outside the documentation library

The following trees are not current or planned documentation and never appear in the docs site or `docs/README.md`:

- `openspec/changes/archive/`
- `site/`
- `spikes/`
- `wireframes/`

Their internal narrative stays untouched. A top-level README may receive a short
scope label when it claims authority over current Rennet.

The eight stale active OpenSpec changes are not prose-audit inputs. They move to
`openspec/changes/archive/`; the two partial changes receive outcome notes first.
