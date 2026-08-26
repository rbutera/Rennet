# Context packet — B1 types-into-protocol

Read `openspec/BUILD-LOOP.md` first. Plan row: B1 in `docs/developing/plans/board-rebuild-plan.md`.

## Objective

Delete `packages/types`. The 69 `objectSchemaFor<T>()` Zod schemas in `packages/protocol` become the single source of truth; TypeScript types become `z.infer` exports from `protocol`. Every `@rennet/types` import repo-wide re-points to `@rennet/protocol` (114 in app-ui alone). Delete the `objectSchemaFor` drift-prevention helper — its existence was the argument for this change. Rewrite the package-boundary law in `CLAUDE.md` (`protocol` imports no Rennet package; `ui` imports `protocol` + `theme`; `app-ui` drops `types`) and `packages/*/package.json` dependency edges to match.

## Out of scope

Any behavioral change. This is one unsplittable mechanical wave — types move, nothing else does. No protocol folder restructure (that is B3), no canvas deletion (B2).

## Blocked by

Nothing. This is the first engine wave.

## Sources

- Engine architecture asset §1: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Decision ledger Q16 (Rai confirmed the deletion): plan doc + https://github.com/rbutera/rennet/issues/489
- Current state: `packages/types/src/index.ts` (3,653 lines), `packages/protocol/src/index.ts` (the schema mirror)
- `docs/developing/reference/monorepo-map.md` — update in this change

## Verification

- `pnpm check` green; `packages/types` gone from the workspace; `grep -r "@rennet/types"` returns zero hits.
- Positive control: re-adding a single `@rennet/types` import must fail architecture/typecheck.

## Completion sigil

`<promise>B01-COMPLETE</promise>`
