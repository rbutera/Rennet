# Tasks — b01-types-into-protocol (B1, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first. One cluster per session. The repo must stay compilable after every cluster: `packages/types` keeps existing untouched until cluster 4, so consumers not yet re-pointed still resolve.

## 1. Protocol becomes the source of truth

- [x] 1.1 In `packages/protocol/src/index.ts`, rewrite the 69 `objectSchemaFor<T>()({...})` call sites to plain `z.object({...})` and export their types as `export type T = z.infer<typeof tSchema>`, carrying each type's JSDoc from `packages/types/src/index.ts` onto the schema or inferred type. Delete the `objectSchemaFor` helper (and its doc block).
- [x] 1.2 Move every `packages/types` export with no schema counterpart into `protocol` verbatim (hand-written `type`/`interface` declarations, unions like `Locus`/`PatchsetSource`, and the 11 runtime value exports: `DIFF_TRUNCATION_MARKER`, `AUTO_CARRY_LINEAGES`, `autoCarries`, `CANVAS_ANGLES`, `MAX_UI_EVIDENCE_BYTES`, `MAX_UI_SCREENSHOTS_PER_RUN`, `MAX_UI_EVIDENCE_DATA_URL_LENGTH`, `R10_BUDGET_EXHAUSTED`, `PROJECT_SNAPSHOT_SCHEMA_VERSION`, `SNAPSHOT_OVERLAY_SCHEMA_VERSION`, `KNOWLEDGE_SCHEMA_VERSION`), JSDoc intact. Everything `@rennet/types` exported must now be exported by `@rennet/protocol`.
- [x] 1.3 Remove the `@rennet/types` imports from all 17 protocol source files (`index.ts`, `bodies.ts`, `rsp.ts`, `session.ts`, tests, …) in favor of the now-local declarations; drop `@rennet/types` from `packages/protocol/package.json`. Leave `packages/types` itself untouched.
- [x] 1.4 `sh -c 'pnpm nx run-many -t typecheck,test -p rennet-protocol rennet-types'` green. Commit.

## 2. Re-point the engine side (core, instructions, adapters, server)

- [x] 2.1 Re-point every `@rennet/types` import to `@rennet/protocol` in `packages/core` (119 files), `packages/instructions` (3 files), `packages/adapters` (66 files), `packages/server` (38 files). Purely mechanical — no shape edits.
- [x] 2.2 Swap the `package.json` edges: drop `@rennet/types`, ensure `@rennet/protocol workspace:*` is present, in all four packages. `instructions` gains the `protocol` dep it did not have.
- [x] 2.3 Grant the new `instructions → protocol` edge in both enforcers so the gate passes mid-wave: `scripts/check-boundaries.mjs` allowed-map and `eslint.config.mjs` (`layer:instructions` gains `layer:protocol`).
- [x] 2.4 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 3. Re-point the client side (app-ui, ui, client, apps)

- [x] 3.1 Re-point every `@rennet/types` import to `@rennet/protocol` in `packages/app-ui` (114 files), `packages/ui` (2 files), `packages/client` (1 file), `apps/desktop` (1 file), `apps/mobile` (1 file).
- [ ] 3.2 Swap the `package.json` edges in all five; `ui` gains `@rennet/protocol` (replacing `@rennet/types`).
- [ ] 3.3 Grant the new `ui-kit → protocol` edge in both enforcers (`scripts/check-boundaries.mjs`: `@rennet/ui` → `{@rennet/protocol, @rennet/theme}`; `eslint.config.mjs`: `layer:ui-kit` gains `layer:protocol`).
- [ ] 3.4 `sh -c 'pnpm nx affected -t typecheck,test'` green. Commit.

## 4. Delete packages/types and rewrite the boundary law

- [ ] 4.1 Confirm zero remaining `@rennet/types` references in workspace source (`packages/`, `apps/`, `scripts/` — excluding `scripts/check-boundaries.mjs`'s own map, handled next), then delete `packages/types` entirely.
- [ ] 4.2 Rewrite the law in both enforcers: remove the `@rennet/types` entry and every `@rennet/types` reference from `scripts/check-boundaries.mjs`; remove `layer:types` from every depConstraint in `eslint.config.mjs`. Final edges: `protocol` imports no Rennet package; `instructions` → `protocol`; `core` → `{protocol, instructions}`; `adapters` → `{protocol, instructions, core}`; `server` → `{protocol, instructions, core, adapters}`; `client` → `protocol`; `ui` → `{protocol, theme}`; `app-ui` → `{protocol, theme, ui}`.
- [ ] 4.3 Rewrite the CLAUDE.md "Package boundaries" paragraph to the same law (also drop the `packages/types` clause from the "imports no Rennet package" sentence — that now names `protocol` and `theme`).
- [ ] 4.4 Sweep for stragglers: `pnpm-workspace.yaml`, `tsconfig.base.json`, Nx project references, lockfile (`sh -c 'pnpm install'` after the deletion). Commit.

## 5. Docs (same change, definition of done)

- [ ] 5.1 `docs/developing/reference/monorepo-map.md`: delete the `rennet-types` row; update the dependency column of every row that listed `types` (desktop, mobile, protocol, instructions, core, adapters, server, client, ui, app-ui).
- [ ] 5.2 Update the other source pages that name `@rennet/types`/`packages/types`: `developing/concepts/architecture-overview.md`, `developing/reference/dependency-standard.md`, `developing/concepts/surfacing-and-routing.md`, `developing/concepts/delta-rereview-and-lineage.md`, `developing/guides/repository-bootstrap.md` (skip `docs/dist` — generated). Re-grep `docs/` for others.
- [ ] 5.3 Commit.

## 6. Verification (packet)

- [ ] 6.1 `sh -c 'pnpm check'` green (exit 0, real target success — not a masked pipe status).
- [ ] 6.2 `packages/types` gone from the workspace: absent from disk, `sh -c 'pnpm nx show projects'` lists no `rennet-types`.
- [ ] 6.3 Zero `@rennet/types` grep hits in workspace source (`packages/ apps/ scripts/ eslint.config.mjs CLAUDE.md docs/` excluding `docs/dist`). Show the grep output.
- [ ] 6.4 Positive control: temporarily add `import type { RepositoryProvenance } from "@rennet/types"` to one `packages/core` file — architecture and/or typecheck MUST fail. Show the failure, revert, re-run green.
- [ ] 6.5 Flip B1 in `BUILD-STATUS.json` and output the completion sigil `<promise>B01-COMPLETE</promise>`.
