## Why

Issue #28's surviving scope (post the Rule Zero strike of the trust/access gates) is the settings machinery around the already-shipped config ladder slice: today every setting is a hand-rolled pair of resolver function + UI row (`resolveScheme`/`resolveVisibility`/`resolvePromoted` in `packages/core/src/settings-resolver.ts`), the execution locus **bypasses the resolver entirely** (`config?.locus ?? detectLocus(...)` in `apps/desktop/src/main/settings.ts`, so its provenance is a bare `locusOverridden` boolean rather than the resolver's own answer), reset-to-inherit exists only for locus, and there is no way to pin an auto-detected value. The just-shipped locus seam (PR #332) made a *detected* source real: a value that comes from the environment, not from any config file, and the ladder has no rung for it — which is exactly why locus had to route around the resolver.

## What Changes

- **Schema registry**: one declarative table in `@rennet/core` where every settings key declares its value schema, builtin default, the layers that may set it, its merge strategy, and how to render a value for provenance. The resolver and the settings surface both derive from it; adding a setting becomes one registry entry, not a new resolve function plus hand-wired UI plumbing. (#44's palette-override store will later register through the same table; nothing in this change builds it.)
- **Generic resolver over the live ladder**: a single registry-driven `resolve` replacing the three per-key functions, folding `builtin < detected < global < repo` — the four layers that have real producers today. `detected` is the new rung: environment-derived offers (locus auto-detection) enter the ladder as ordinary contributions, so locus gets true provenance instead of a side-channel boolean. `Resolved<T>` (provenance as the return type) is unchanged as the contract.
- **Deliberately cut, stated here so it is a visible decision**: the retired plan's remaining layers (workspace-shared, workspace-personal, repo-shared, changeset) and the `union`/`deepMerge`/`append` merge strategies ship with their **first real producer/key, not now** — every currently-consumed setting is `replace`, and no committed workspace/repo settings file is read by anything. The layer ordering is specified so future rungs slot in without re-keying stored values. The retired plan's pin-block (global pin outranking shared layers) is superseded: with no shared layers, pin-at-repo (below) is the pin the product needs.
- **Records verdict — no persisted record table**: provenance is computed fresh by the pure resolver on every read and rendered verbatim; persisting it would be a cache that can go stale and lie. Repo relocation identity already shipped (`path`/`aliases`/`relocatedFrom` on `ProjectConfig`); the retired plan's uuidv7 `RepoRecord`/`WorkspaceRecord` + forge/root-commit evidence table has no live consumer (no cross-machine naming, no sync) and is not built.
- **Per-repo Explain/Reset/Pin surface**: every settings row renders the resolver's own contributions (Explain — now including locus); every repo-layer value gains reset-to-inherit (clear the repo entry, fall back down the ladder — today only locus has it); a row whose effective value is inherited/detected gains pin-at-repo (write the current effective value explicitly at the repo layer so a lower rung changing no longer moves it — chiefly: freeze an auto-detected locus). The appearance scheme row gains the same reset (clear the global entry, back to builtin). All of it is plain config writes with zero confirmation ceremony (Rule Zero); the shipped Rule-75 malformed-config refusals apply unchanged.

## Capabilities

### New Capabilities

- `settings-resolution`: the schema registry, the layered resolver with provenance as the return type, the detected rung, and the per-repo Explain/Reset/Pin surface.

### Modified Capabilities

<!-- none: wsl-execution-mode's locus requirements (see/change the locus in settings, informational never a confirmation) remain true and untouched; this change extends the settings surface additively. -->

## Impact

- `packages/core/src/settings-resolver.ts`: registry + generic resolve replace the three per-key functions (same `Resolved<T>` contract).
- `packages/protocol/src/index.ts` (~1500): `settingsLayerSchema` gains `"detected"` (additive); `SettingsProject` gains locus provenance (additive; `locusOverridden` kept); new `settings.resetRepoValue` / `settings.pinRepoValue` commands (or parameterised set-commands — design decides).
- `apps/desktop/src/main/settings.ts`: locus resolution moves inside the resolver; composition wires detected offers; reset/pin handlers over the existing `updateConfig` (Rule-75 guard already lives in the adapter).
- `packages/adapters/src/project-snapshot-store.ts`: no shape change expected (reset = delete key via `updateConfig`; old configs parse unchanged — no migration).
- `packages/ui/src/components/settings-screen.tsx`: Explain for locus, Reset/Pin controls per row.
- Docs, same change: `docs/src/content/docs/developing/reference/delivery-order.md` wave-8 entry rewritten to the honest scope; settings coverage in the using-Rennet guide updated where rows/controls change.
