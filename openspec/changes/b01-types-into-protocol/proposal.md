# B1 — Delete packages/types: protocol's Zod schemas become the single source of truth (#489)

## Why

`packages/types/src/index.ts` (3,653 lines) hand-writes every domain type, and `packages/protocol/src/index.ts` (3,520 lines) mirrors 69 of them as Zod schemas through `objectSchemaFor<T>()` — a helper whose entire job is to stop the two files drifting apart (#242's silent IPC strips). Maintaining a mirror plus a drift-prevention helper is the argument for deleting the mirror: make the schemas the source, derive the types with `z.infer`, and the drift becomes impossible instead of merely guarded. Decision ledger Q16 (plan doc + [#489](https://github.com/rbutera/rennet/issues/489)) confirmed the deletion; the engine architecture asset (§1, [#489 comment](https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330)) names this the first engine wave.

## What Changes

One unsplittable mechanical wave — types move, nothing else does. Zero behavioral change.

- **`packages/protocol` becomes self-sufficient.** The 69 `objectSchemaFor<T>()` call sites in `src/index.ts` become plain `z.object({...})`; their TypeScript types become `export type T = z.infer<typeof tSchema>`. Types with no schema counterpart (plus the 11 runtime value exports in `packages/types` — `DIFF_TRUNCATION_MARKER`, `CANVAS_ANGLES`, `MAX_UI_*`, `autoCarries`, the `*_SCHEMA_VERSION` constants, …) move into `protocol` verbatim, JSDoc intact. The `objectSchemaFor` helper is deleted. The 17 protocol source files that import `@rennet/types` stop; `protocol/package.json` drops the dep. `protocol` imports no Rennet package.
- **Every `@rennet/types` import repo-wide re-points to `@rennet/protocol`.** Measured file counts: core 119, app-ui 114, adapters 66, server 38, instructions 3, ui 2, client 1, `apps/desktop` 1, `apps/mobile` 1. Each consumer's `package.json` swaps the dep to match. `instructions` gains a `protocol` edge (its 3 type imports have to land somewhere); `ui`'s allowed edge becomes `protocol` + `theme`.
- **`packages/types` is deleted from the workspace** — directory, workspace entry, every `package.json` edge.
- **The package-boundary law is rewritten to match**, in all three homes: `scripts/check-boundaries.mjs` allowed-map (drop the `@rennet/types` entry and every reference to it), `eslint.config.mjs` depConstraints (drop `layer:types` everywhere; add `layer:protocol` to `layer:instructions` and `layer:ui-kit`), and the CLAUDE.md package-boundary paragraph (`protocol` imports no Rennet package; `ui` imports `protocol` + `theme`; `app-ui` drops `types`).
- **Docs in the same change**: `docs/developing/reference/monorepo-map.md` (delete the `rennet-types` row, update every dependency column) plus the other source pages that name `@rennet/types`/`packages/types` (`architecture-overview.md`, `dependency-standard.md`, `surfacing-and-routing.md`, `delta-rereview-and-lineage.md`, `repository-bootstrap.md`).

**Explicitly out of scope** (packet): any behavioral change; the protocol folder restructure (B3); the canvas deletion census (B2).

## Capabilities

### New Capabilities

<!-- None. Mechanical relocation; no behavior changes. -->

### Modified Capabilities

<!-- None. The wire shapes, commands, and events are byte-identical; only where their types are declared changes. -->

## Impact

- **`packages/protocol`** — absorbs all type declarations and value exports; loses `objectSchemaFor` and its `@rennet/types` dep.
- **`packages/types`** — deleted.
- **`packages/{core,instructions,adapters,server,client,ui,app-ui}`, `apps/{desktop,mobile}`** — imports re-pointed, `package.json` edges swapped.
- **`scripts/check-boundaries.mjs`, `eslint.config.mjs`, `CLAUDE.md`** — the boundary law, rewritten in lockstep.
- **Docs** — `monorepo-map.md` and the five other source pages listed above.
- **Verification** (packet): `pnpm check` green; `packages/types` gone from the workspace; zero `@rennet/types` hits in workspace source; positive control — re-adding a single `@rennet/types` import must fail architecture/typecheck.
