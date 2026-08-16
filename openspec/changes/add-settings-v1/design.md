## Context

See proposal.md — Why. What exists (verified 2026-08-16):

- `packages/core/src/settings-resolver.ts` — three hand-rolled resolvers (`resolveScheme`, `resolveVisibility`, `resolvePromoted`) over a private `fold`, ladder `builtin < global < repo`, `Resolved<T>` with provenance as the return type.
- `apps/desktop/src/main/settings.ts` — `createSettingsComposition` builds `SettingsView`; locus resolves OUTSIDE the resolver (`config?.locus ?? detectLocus(target.repoPath)`) with `locusOverridden` as the only provenance; `setRepoLocus(locus: null)` is the one shipped reset-to-inherit; Rule-75 malformed refusals check `loadConfigState` before every write.
- `packages/adapters/src/project-snapshot-store.ts` — `ProjectConfig` (`version`, optional `path`/`promoted`/`aliases`/`relocatedFrom`/`visibility`/`locus`), `loadConfigState` distinguishing absent/ok/malformed, `updateConfig` throwing on malformed (the guard every writer shares).
- `packages/adapters/src/file-config-store.ts` — the global store; same atomic-write and fail-safe-read discipline.
- `packages/protocol/src/index.ts` ~1470–1560 — `settingsLayerSchema` (`builtin|global|repo`), `resolvedProvenanceSchema`, `settingsProjectSchema` (with `locus` + `locusOverridden` but no locus provenance), `settingsViewSchema`.
- `packages/ui/src/components/settings-screen.tsx` — `Provenance` renders contributions for scheme/visibility/promoted; locus row has a segmented control and "Reset to auto"; no Pin anywhere; no reset for visibility/promoted/scheme.

Constraint: Rule Zero. Explain is honesty, Reset and Pin are plain writes; nothing here asks permission or withholds a capability.

## Goals / Non-Goals

Goals: registry + generic resolver; the `detected` rung; locus through the ladder; Explain/Reset/Pin on every row; additive protocol; zero migration.

Non-Goals (each cut is argued in proposal.md):
- Workspace, repo-shared (committed `.rennet` settings file), and changeset layers — no producer exists; the ordering leaves room (see Decision 2).
- `union` / `deepMerge` / `append` merge strategies — no registered key needs them; the registry field exists, the only implemented strategy is `replace`.
- A persisted record/provenance table and the retired plan's uuidv7 `RepoRecord`/`WorkspaceRecord` alias evidence.
- The retired plan's global pin-block and its `check-settings-access` script gate.
- New setting keys (chunk budgets, mechanical globs, harness order). Registering existing consumed constants is #44-adjacent later work.

## Decisions

**1. The registry is a typed constant table in core, not a plugin surface.**
A `SettingDeclaration<T>` record: `key`, a validate function (reuse the protocol zod schemas where they exist), `builtinDefault`, `layers: SettingsLayer[]`, `merge: "replace"`, `render(value): string`. Exported as a const object keyed by setting id. Alternative rejected: a registration API with `registerSetting()` calls — mutable global state and ordering hazards for zero benefit; every setting is known at compile time.

**2. `detected` slots between `builtin` and `global`; the enum is additive and ordered by a single exported precedence list.**
`settingsLayerSchema` becomes `["builtin", "detected", "global", "repo"]`. Precedence is defined once (`LAYER_ORDER` in core); the fold sorts offers by it, so a future rung (workspace between global and repo, changeset above repo) is one enum member + one list insertion, no re-keying of stored values (files never store layer names; layers are where a file IS). Detection below `global`/`repo` because detection is an environmental guess and any explicit user choice must beat it — this is exactly the current `config?.locus ?? detectLocus(...)` semantics, expressed as ladder order. Alternative rejected: `detected` above `global` — no key today has both a global and a detected producer, but if one ever does, "the machine guessed" outranking "the user chose globally" is the wrong default.

**3. Locus resolution moves into the resolver; the wire shape grows additively.**
Composition passes `{ detected: detectLocus(repoPath), repo: config?.locus }` as offers; the resolver returns `Resolved<Locus>`. `settingsProjectSchema` gains `locusProvenance: resolvedProvenanceSchema` (additive); `locusOverridden` is kept and derived (`layer === "repo"`), so existing renderer code and tests keep working. Rendering a locus for provenance uses the existing `describeLocus`-style string ("host" / "WSL · Ubuntu").

**4. Reset and Pin are two small commands over the existing write path, not a new store.**
- `settings.resetRepoValue { projectId, repoPath, key }` — `updateConfig` deleting the key's field. For locus this collapses to the shipped `setRepoLocus(null)`; visibility reset additionally runs the real visibility switch toward the newly effective value so `.rennet/.gitignore` matches (the value falling back to `local` must actually re-apply local semantics — a reset that changes the effective value without applying it would be a lie in the UI).
- `settings.pinRepoValue { projectId, repoPath, key }` — read the current `Resolved<T>`, write `resolved.value` at the repo layer via the same setters the explicit controls use. Pin is defined as "set-to-current-effective", so it cannot introduce a new write path or new validation.
Both reuse the composition's target re-resolution (live project, canonical top level) and the Rule-75 malformed refusal, mirroring `setRepoVisibility`. Alternative rejected: a generic `settings.set {key, value}` command — visibility and locus have side-effectful setters (gitignore switch, locus store) with distinct outcome types; a generic set would either bypass them or grow a dispatch table equal in size to the two commands.

**5. UI: Reset and Pin are the same slot, state-dependent.**
A row explicitly set at the repo layer shows Reset ("inherit"); an inheriting/detected row shows Pin ("keep this value"). Explain stays the always-visible `Provenance` block, now fed for locus too. No new components beyond wiring; the locus "Reset to auto" button becomes the generic Reset for that row.

## Risks / Trade-offs

- [Registry validate functions drift from `isValidProjectConfig`] → the registry reuses the protocol schemas (`projectVisibilitySchema`, `locusSchema`, `appearanceSchemeSchema`) as the single source; a test enumerates the registry and round-trips each key's default through its validator.
- [Pin races detection: value changes between render and pin click] → pin writes the value the composition resolves at command time, not the renderer's snapshot; the outcome message states what was pinned. Acceptable: detection is stable within a session.
- [Visibility reset must re-apply the gitignore switch] → covered by Decision 4; a red-first test drives reset from `git-visible` and asserts the switch ran toward `local`.
- [Cut layers/strategies read as missing work later] → proposal states each cut and the delivery-order entry is rewritten in this change, so the record of "why not eight" is in the tree, not in an agent's head.

## Migration Plan

None needed: enum growth and new optional fields are additive; old configs parse unchanged (spec requirement); no file format changes; no data migration. Rollback is reverting the change.

## Open Questions

None.
