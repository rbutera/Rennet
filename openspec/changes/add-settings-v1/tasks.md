## 1. Protocol (additive wire shapes)

- [x] 1.1 RED: extend `packages/protocol/src/index.test.ts` — `settingsLayerSchema` accepts `"detected"`; `settingsProjectSchema` accepts the old shape without `locusProvenance` and normalizes it to the canonical new shape; new `settings.resetRepoValue` / `settings.pinRepoValue` command payload + outcome schemas parse; `locusOverridden` stays required and accepted exactly as today. Watch the tests fail.
- [x] 1.2 GREEN: add `"detected"` to `settingsLayerSchema`, `locusProvenance` to `settingsProjectSchema`, and the two command schemas in `packages/protocol/src/index.ts` (~1500 region), wired into the command union.

## 2. Core: registry + generic resolver

- [x] 2.1 RED: new tests in `packages/core/src/settings-resolver.test.ts` — the registry enumerates exactly the four live keys (scheme, visibility, promoted, locus), each key's builtin default passes its own validator, each declares `merge: "replace"` and a permitted-layers list; `resolve` folds offers in `LAYER_ORDER` (`builtin < detected < global < repo`), returns `Resolved<T>` with exactly one effective contribution; locus: detected-only ⇒ effective layer `detected`; detected + repo ⇒ repo wins with the detected offer listed non-effective; an offer at a layer the key does not permit is refused (thrown or type-impossible — pin whichever the implementation chooses).
- [x] 2.2 GREEN: implement `SettingDeclaration`, the const registry (reusing protocol schemas as validators), exported `LAYER_ORDER`, and generic `resolve` in `packages/core/src/settings-resolver.ts`; reimplement `resolveScheme`/`resolveVisibility`/`resolvePromoted` as thin registry calls (keep the exports; callers unchanged) and add `resolveLocus(detected, repoValue)`.
- [x] 2.3 Delete the now-redundant per-key `fold` plumbing; `pnpm nx affected -t lint,typecheck,test` green.

## 3. Composition: locus through the ladder, reset, pin

- [x] 3.1 RED: extend `apps/desktop/src/main/settings.test.ts` — `get()` rows carry `locusProvenance` naming `detected` when no override and `repo` when overridden, with the suppressed detected contribution present; `resetRepoValue` for visibility clears the repo key AND drives the visibility switch toward the newly effective value; `resetRepoValue` for locus matches shipped `setRepoLocus(null)` behavior; `pinRepoValue` for locus writes the currently detected locus at the repo layer and the row flips to source `repo`; both commands: unresolved target ⇒ `unresolved`, malformed config ⇒ `malformed` with zero writes (assert the fake store saw no save). Watch them fail.
- [x] 3.2 GREEN: wire `resolveLocus` into `get()` (delete the `config?.locus ?? detectLocus` side-channel; derive `locusOverridden` from the resolved layer), and implement `resetRepoValue`/`pinRepoValue` in `createSettingsComposition` per design Decision 4, mirroring `setRepoVisibility`'s target re-resolution and Rule-75 refusal.
- [x] 3.3 Wire the two commands through dispatch and the main-process deps in `apps/desktop/src/main/index.ts` (same 4-step pattern as `settings.setRepoLocus`).

## 4. UI: Explain / Reset / Pin per row

- [x] 4.1 RED: extend `packages/ui/src/components/settings-screen.dom.test.tsx` — locus row renders its `Provenance` contributions; a repo-set row shows Reset and not Pin, an inheriting/detected row shows Pin and not Reset; clicking Reset on visibility invokes `settings.resetRepoValue` and re-renders from the returned outcome; clicking Pin on a detected locus invokes `settings.pinRepoValue`; no dialog/confirmation element ever appears (assert the action completes in one interaction); malformed row: controls render the refusal copy, no invoke. Watch them fail.
- [x] 4.2 GREEN: implement in `packages/ui/src/components/settings-screen.tsx` — `Provenance` for locus, the shared Reset/Pin slot per design Decision 5 (the locus "Reset to auto" becomes the generic Reset), scheme row's global reset.

## 5. Docs (same change) + gate

- [x] 5.1 Rewrite the wave-8 entry in `docs/src/content/docs/developing/reference/delivery-order.md` to the delivered scope: registry, `builtin < detected < global < repo` resolver, Explain/Reset/Pin — naming the cuts (workspace/repo-shared/changeset layers, non-replace merge strategies, record table) as deliberate with their proposal rationale, so "eight-layer" stops being the standing description.
- [x] 5.2 Update the settings coverage in `docs/src/content/docs/using/guide/getting-started.md` and `docs/src/content/docs/using/guide/windows-and-wsl.md` where rows/controls changed (locus provenance, Pin, Reset); verify no other page describes the three-function resolver or `locusOverridden`-only locus.
- [x] 5.3 Full gate `pnpm check` green, including a positive control: temporarily break one new assertion, watch it fail, restore.
