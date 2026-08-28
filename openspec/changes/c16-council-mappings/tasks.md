# Tasks — c16-council-mappings (C16, #485)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster; one commit per checked task. Sources of record: the packet `context.md`, issue #485 (the surface + its four open questions; C16 answers only the mapping display+override under the honest-present ruling), the settings ladder #476, and the council doctrine `openspec/specs/model-council/spec.md` + `docs/developing/concepts/model-council.md`. Reused landed surfaces: the council tables `packages/core/src/model-council.ts` (`ASSIGNMENT_TABLES`, `JOB_CATALOGUE`, `resolveAssignment`, `scenarioFor`), the C10 Review UI `packages/app-ui/src/settings/environments/model-mappings.tsx` + its presentation copy `settings/assets/model-council.ts` (`REVIEW_ROLE_DEFAULTS`), the projection seam `settings/data/projections.tsx` (`SettingsProjection.reviewRoles` / `setRoleAssignment` / `ReviewRole` / `RoleAssignment`), the live bind `settings/data/live-projection.tsx`, the settings command pattern `packages/protocol/src/commands/index.ts` + `packages/server/src/dispatch/settings.ts` + `packages/core/src/settings-resolver.ts`, and the config store `packages/adapters/src/file-config-store.ts`. Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** confirm the reused surfaces are on main — `model-council.ts` exports `ASSIGNMENT_TABLES`/`JOB_CATALOGUE`/`resolveAssignment`/`scenarioFor`; `CouncilResolveContext.overrides.task` is the honoured override slot (grep `resolveAssignment` in `model-council.ts` — the task-override layer already exists); `projections.tsx` carries `reviewRoles: readonly ReviewRole[]` + `setRoleAssignment(roleId, scenario, assignment)`; `live-projection.tsx` still says *"reviewRoles: no Model-Council / mappings command exists"* (the note this change deletes); `model-mappings.tsx` renders the switch + dialog + Reset over the projection. Then confirm what does NOT yet exist: `grep -rn "resolveReviewRoles\|REVIEW_ROLE_CATALOGUE\|reviewRoleMappingSchema\|setRoleAssignment\b" packages/core/src packages/protocol/src packages/server/src` — **no core catalogue, no wire schema, no command** (only the app-ui projection method + its tests reference `setRoleAssignment`). C16 adds them.

## 0. Re-scope — per-scenario routing overrides (Rai, 2026-08-28)

> Rai ruled that routing overrides are **PER-SCENARIO**, rejecting the job-keyed
> shape clusters 1–4 landed ("one edit moves all three columns"). `routing.task`
> is keyed by **(jobId, scenario)**. The shape is unreleased — it changes IN
> PLACE, no migration, no compatibility read. See `context.md` § Re-scope.
>
> This supersedes, in the tasks above: 2.1's `task?: Record<jobId, {model,effort}>`;
> 1.2's `resolveReviewRoles(ctx: CouncilResolveContext)` (the context is now a
> review-role context carrying the scenario-keyed slice; the inert `availability`
> field is gone); and the "SCENARIO-INDEPENDENT BY CONSTRUCTION" note on
> `SettingsPort.setRoleAssignment`, which was the job-keyed rationalisation.

- [x] 0.1 Record the ruling in `context.md` + this file (this block).
- [x] 0.2 Protocol: `clientSettingsSchema.routing.task` becomes
      `Record<jobId, { dual?, claudeOnly?, codexOnly? }>` (`councilScenarioOverridesSchema`,
      additive-optional). `CouncilOverrides.task` loosens to `Partial<Record<…>>` so a
      single-job override needs no cast.
- [x] 0.3 Core `resolveReviewRoles` layers only that scenario's own cell; server
      `setRoleAssignment` writes/clears exactly ONE `(job, scenario)` cell (`null`
      clears that cell only; an emptied job entry drops, an emptied slice drops).
      Adapters/server tests re-encode per-scenario semantics.
- [x] 0.4 **Positive control (must fail if job-keyed sneaks back):** set an override
      in `codexOnly`, then assert `dual` and `claudeOnly` still read the council-table
      default with unchanged values and `layer: "default"`.

## 1. Core — the review-role catalogue + all-scenario resolution (packet: "readable … over the council tables that already exist"; Reconciliation 3)

- [x] 1.1 `packages/core/src/model-council.ts` (or a sibling `model-council-roles.ts` re-exported from the barrel): `REVIEW_ROLE_CATALOGUE` — the authoritative map of the eight user-legible roles (`orchestrator`, `map-workers`, `confirmation`, `lens-workers`, `second-seat`, `adjudication`, `post-process`, `utility`) each to its backing council **job id, reused from `JOB_CATALOGUE`** (e.g. lens-workers → `lens-draft`, post-process → `board-post-process`, map-workers → `partition-worker`, utility → a light-tier id, orchestrator → the review seat, adjudication → `adjudication`). The Flagged `second-seat` is the dual-only construct (`dual-seat.ts`), NOT a single-provider table job — model it so it resolves in `dual` and is honest-null in `claudeOnly`/`codexOnly` (Reconciliation 3). Each role carries its `label` + `hint` (the copy the surface shows). **No new job ids, no table-value change** (out of scope).
- [x] 1.2 `resolveReviewRoles(ctx: CouncilResolveContext)` — pure, deterministic: for each role, for each of the three scenarios (`both`/`claude-only`/`codex-only`), resolve `{ model, effort } | null` from `ASSIGNMENT_TABLES[scenario][jobId]` layered with `ctx.overrides.task[jobId]`, plus the resolution **source** (`council-table` when the table default stands, `task-override` when an override wins) so the surface can render `{value, layer}` provenance. Honest-null where the role does not run in a scenario. Reuse `resolveAssignment` per (role, scenario) rather than re-implementing the layering.
- [x] 1.3 Unit test `model-council-roles.test.ts`: every role resolves to an assignment in every scenario OR is honest-null (never `undefined`, never a throw); `second-seat` is null in `claude-only`/`codex-only` and a real pick in `dual`; a `ctx.overrides.task` entry changes the resolved cell AND flips its source to `task-override`. **Positive control (must be able to fail):** a test asserts every job id named in `REVIEW_ROLE_CATALOGUE` is a key of `JOB_CATALOGUE` (the no-new-job-id / no-fabrication guard — a catalogue entry pointing at a non-existent id fails). Cluster gate green. Commit.

## 2. Protocol — the wire shape + the write command (packet: "editable … Values carry the `{value, layer}` provenance contract"; Reconciliations 2/4)

- [x] 2.1 `packages/protocol/src/wire.ts`: `reviewRoleMappingSchema` — `{ id, label, hint, dual, claudeOnly, codexOnly }` where each scenario cell is `{ value: { model, effort } | null, layer }` (reuse the existing `Layered`/provenance contract the settings seam uses; `null` value = the role does not run there). Add `reviewRoles: z.array(reviewRoleMappingSchema).optional()` to `settingsViewSchema` (additive-optional, matching `keybindings`/`coachmarks`/`daemonHosts`). Add a `routing` overrides slice to `clientSettingsSchema` — `{ task?: Record<jobId, { model, effort }> }` (additive-optional; an untouched install omits it).
- [x] 2.2 `packages/protocol/src/commands/index.ts`: register **one** new command `settings.setRoleAssignment` — input `{ roleId: string, scenario: "dual" | "claudeOnly" | "codexOnly", assignment: { model, effort } | null }` (`null` = Reset to the council default), output `{ reviewRoles: z.array(reviewRoleMappingSchema) }` (the re-resolved mappings for the optimistic update). It is a WRITE (add to the mutation/side-effect list beside `settings.setKeybinding`). Model + effort only — no harness field (#89, Reconciliation 4). The READ needs no new command (rides `settings.get`, Reconciliation 2).
- [x] 2.3 Update the recorded command snapshots in `packages/protocol/src/commands/commands.test.ts` (the command list + the mutation set gain `settings.setRoleAssignment`). **Positive control:** the snapshot test is the guard — a registered-but-unrecorded command fails it; confirm the updated snapshot reflects exactly one new command. Cluster gate green. Commit.

## 3. Adapters + core resolver — persist the routing overrides (packet: "editable"; Reconciliation 4)

- [x] 3.1 `packages/adapters/src/file-config-store.ts` (+ the legacy migration): the `routing` overrides slice reads/writes `client-settings.json` (viewer-scoped, like `appearance`/`keybindings`). Additive: an untouched install omits it; a malformed config REFUSES the write (Rule 75, mirroring `setAppearance`/`setKeybinding`) rather than overwriting unparseable bytes.
- [x] 3.2 The settings resolver dep (`packages/core/src/settings-resolver.ts` + the server settings dep that feeds `deps.settings`): `reviewRoles()` loads the persisted `routing.task` overrides into `CouncilResolveContext.overrides.task` and returns `resolveReviewRoles(ctx)`; `setRoleAssignment(roleId, scenario, assignment | null)` maps the role→job id (cluster 1's catalogue), writes/clears that `routing.task[jobId]` entry (model + effort only), and returns the re-resolved mappings. `null` clears the override so the value falls back to the council-table default.
- [x] 3.3 Unit test: `setRoleAssignment` persists → a re-read reflects the override with `layer` = override and `source` = `task-override`; `null` clears back to the council-table default (`layer` = council-table); a malformed config refuses the write (throws, nothing written). **Positive control:** setting an override then reading shows the changed model; clearing it returns the exact table default (flip proves the override is real, not cosmetic). Cluster gate green. Commit.

## 4. Server — the dispatch handlers (packet: "binding … to live `settings.*` commands"; Reconciliation 5)

> **Landed with cluster 3, not by scope creep.** `buildDispatchTable`'s compile-time
> exhaustiveness guard (`packages/server/src/dispatch/index.ts`) makes a registry command
> with no handler a TYPE ERROR, so cluster 2 (which registers `settings.setRoleAssignment`)
> cannot compile — let alone pass a cluster gate — until its handler exists. Registration
> and handler are one atomic unit; splitting them across clusters was a task-ordering
> mistake in this file, not a decision to re-open.

- [x] 4.1 `packages/server/src/dispatch/settings.ts`: extend the `settings.get` handler so its output carries `reviewRoles` — from `deps.settings.reviewRoles()` when present, else the council DEFAULTS via core `resolveReviewRoles({ availability: … })` with `layer: "council-table"` (**honest-present, never empty** — the tables are static and always available, Reconciliation 5). Add the `settings.setRoleAssignment` handler — resolves `deps.settings.setRoleAssignment(...)` and returns the re-resolved mappings; absent dep ⇒ echo the re-resolved defaults (no persistence, but never a fake success). Wire the dep into `create-server.ts`.
- [x] 4.2 Dispatch test (`dispatch/settings.test.ts` or `settings.test.ts`): `settings.get` returns all eight roles across the three scenarios, each cell carrying `{value, layer}`; `second-seat` is null in the single-provider columns; `settings.setRoleAssignment` persists and a subsequent `settings.get` reflects the override with its provenance; `null` resets. Cluster gate green. Commit.

## 5. Client — bind the live projection + the provenance chip (packet: "binding `SettingsProjection.reviewRoles` and `setRoleAssignment`"; Reconciliation 1)

> **Cluster-5 deviations.** (a) Provenance rides `RoleAssignment.layer?: "default" |
> "override"` rather than a new cell wrapper — strictly additive, so `ReviewRole` and
> every existing fixture kept typechecking. (b) `defaultAssignment` / `isRoleDefault`
> in `settings/assets/model-council.ts` are DELETED: both re-derived "is this a
> default?" from a copied table, which the `layer` contract answers directly.
> `REVIEW_ROLE_DEFAULTS` stays as the honest-present fallback + test fixture.
> (c) The dialog's "once its Model Council is served" gap copy is deleted — with a
> served backend it was a false statement; an empty projection now falls back to the
> council defaults (honest-present). (d) A write's response OUTRANKS the `settings.get`
> read it invalidated, so the edited cell settles without blinking back.

- [x] 5.1 `packages/app-ui/src/settings/data/projections.tsx`: extend `RoleAssignment` (or the `ReviewRole` cell) to carry its `layer`/provenance so the surface can render a chip and derive "is this a default?" from the layer (Reconciliation 1) instead of the hardcoded `REVIEW_ROLE_DEFAULTS` comparison. Keep the shape additive so the existing `model-mappings.tsx` and its tests still typecheck; update the `EMPTY_SETTINGS_PROJECTION` default and the fixture helpers accordingly.
- [x] 5.2 `packages/app-ui/src/settings/data/live-projection.tsx`: fold `reviewRoles` from a `settings.get` read (compose it beside the existing `harness.detect` agents read), mapping the wire `reviewRoleMappingSchema` to the projection's `ReviewRole`; resolve `setRoleAssignment` to the `settings.setRoleAssignment` command (write, then adopt the returned re-resolved mappings — optimistic, re-read on settle). **Delete** the `reviewRoles: no Model-Council / mappings command exists` note (it is now false).
- [x] 5.3 `packages/app-ui/src/settings/environments/model-mappings.tsx`: render the **provenance chip** on a cell whose `layer` is an override (council default vs overridden); "Reset to default" now clears via the live write (`setRoleAssignment(role, scenario, null)`). A scenario cell with a `null` value renders an em dash (honest-unassigned), never a fabricated model. No rebuild of the switch/dialog — additive chip + wire the existing Reset to the null write.
- [x] 5.4 DOM test (`model-mappings.dom.test.tsx` — extend the existing one): over a fixture command bridge, the Review section renders live roles with provenance chips; a cell edit calls `settings.setRoleAssignment` and the re-read shows the override + its chip; Reset clears it back to the council default; `second-seat` renders an em dash in the single-provider columns. **Positive control (must be able to fail):** an absent/empty `reviewRoles` still renders the council defaults (honest-present — the section is never a blank when the tables exist), AND a role with a `null` scenario cell renders an em dash rather than any model string. Cluster gate green. Commit.

## 6. Packet verification — E2E + positive controls + docs, full gate

- [x] 6.1 The packet E2E over the real command path (drives the UI, not asserted): stage the Review section → **change a role assignment in one scenario** → the write command fires once → **reload** (re-read `settings.get`) → the change persists with its **provenance chip** → a role with no assignment in a scenario renders **honestly unassigned** (em dash). Evidence shown.

  > Landed as TWO halves, because the boundary check forbids one process holding
  > both (`app-ui` may not import `server`; `server` may not import `app-ui`).
  > Together they cover the whole path, and both run in `pnpm check`.
  >
  > - **Server half** — `packages/server/src/c16-council-mappings-e2e.test.ts`:
  >   the REAL `settings.*` dispatch handlers (every payload crosses
  >   `parseCommandInput`/`parseCommandOutput`), the REAL settings composition, the
  >   REAL core resolver over the REAL council tables, and the REAL on-disk
  >   `client-settings.json`. Reload = a brand-new store + composition + handler
  >   table over the same directory, so the bytes on disk are the only survivor.
  >   Proves: honest-present defaults (8 roles, every cell `default`), one write
  >   per edit, persistence across reload with `layer: "override"`, the on-disk
  >   slice is exactly `{ "lens-draft": { dual: … } }`, a second column overrides
  >   independently, `null` clears one cell only, and clearing the last cell drops
  >   the whole `routing` slice.
  > - **Client half** — `packages/app-ui/src/settings/data/live-projection.dom.test.tsx`
  >   (appended describe): the REAL `EnvironmentsPage` → `ReviewSettings` → Model
  >   Mappings dialog over the REAL `settings.*` command names, driven with
  >   user-event. Reload = unmount + a cold remount (fresh bridge, fresh command
  >   cache, fresh `settings.get`). Proves: two default cells unchipped, the edit
  >   fires ONE write naming `(lens-workers, dual)`, the chip appears on that cell
  >   only, the override survives the cold reload with its chip, the sibling column
  >   still reads the council default, `second-seat` renders an em dash before and
  >   after, and Reset clears back to two unchipped defaults.
- [x] 6.2 Positive controls that can fail (flip each once, see red, revert): (a) `REVIEW_ROLE_CATALOGUE` pointing at a job id absent from `JOB_CATALOGUE` fails the cluster-1 guard; (b) a scenario with no mapping renders no row / an em dash, not a fabricated default (cluster 5.4); (c) an override written then read shows the changed model and `layer` = override (cluster 3.3 / 4.2); (d) the command snapshot rejects an unrecorded command (cluster 2.3). Record the flip-to-red for each.

  > **Flip-to-red record (2026-08-28, cluster 6).** Each flip applied, run, seen
  > red, reverted (`git checkout --`). All five re-run after the cluster-5
  > re-scope, so none is a stale pre-re-scope record.
  >
  > | # | Flip | Red |
  > |---|---|---|
  > | (a) | `REVIEW_ROLE_CATALOGUE` post-process → `"board-postprocess" as CouncilJobId` | 8 failures in `model-council-roles.test.ts`, headed by *points only at job ids that exist in JOB_CATALOGUE* — `post-process → board-postprocess: expected undefined to be defined` |
  > | (b) | the dialog's `—` cell replaced with a literal `opus-4.8` | 3 failures: *a role that does not run in a mode renders an em dash*, *a null scenario cell renders an em dash*, and the new E2E |
  > | (c) | `resolveTableCell` ignores its override cell (`const cell = undefined`) | 6 failures across core, `server/settings.test.ts`, and the E2E — e.g. `expected { model: 'opus-4.8' … } to deeply equal { model: 'sonnet-5', effort: 'medium' }` |
  > | (c′) | `setRoleAssignment` resolves without persisting (`updateGlobal` → a pure read) | the E2E's write-count leg reddens: `expected +0 to be 1` |
  > | (d) | `"settings.setRoleAssignment"` deleted from the recorded snapshot | *matches the recorded command snapshot* — `expected [ 'app.bootstrap', …(79) ] to deeply equal [ …(78) ]` |
  >
  > **The re-scope's own control** (per-scenario, the cluster-6 headline), flipped
  > from both ends: server `setRoleAssignment` writing all three cells reddens
  > `expect(after.claudeOnly).toEqual(before.claudeOnly)` in the server E2E; the
  > dialog's `setModel` looping over `SCENARIOS` reddens the client E2E's
  > one-write assertion (`expected [ …(3) ] to have a length of 1`).
- [x] 6.3 Docs (definition of done): update `docs/developing/concepts/model-council.md` (the role→model mappings are now readable + editable from the Environments Review section under the honest-present ruling; edits write `routing.task.*` model+effort overrides, harness derives from provider #89; the tables remain the defaults) and `docs/developing/guides/settings-and-setup.md` (the Review section walkthrough). Grep `docs/` (excl. `docs/dist`) for the "no dedicated council screen" / "reviewRoles honest-empty" claims this change makes wrong; update or record the grep as a no-op. **Confirm the out-of-scope guard in prose:** no new job ids, no table-value change, no availability-override persistence.

  > **What landed (2026-08-28).** `model-council.md` gains a *Review roles in
  > Settings* section — the eight-role → job-id table (verified against
  > `REVIEW_ROLE_CATALOGUE`, no new ids), the honest-present read, the em-dash
  > null cell, the `{value, layer}` provenance, an *Editing a mapping* subsection
  > carrying the per-scenario ruling verbatim (Rai, 2026-08-28 — editing one
  > scenario never moves a sibling), model+effort only with the harness derived
  > from the provider (#89), and the out-of-scope guard in prose. The old
  > *"no dedicated council diagnostics screen"* sentence is narrowed to traces
  > (still true) and now points at the new section.
  > `settings-and-setup.md` gains the `routing.task[jobId][scenario]`
  > client-settings row, a *Model Mappings* walkthrough (two rendered columns —
  > Dual Harness and a provider-resolving Single Harness — honest-present values,
  > the three write properties, the Overridden chip, Reset-drops-the-layer, the
  > slice's appear/disappear lifecycle, malformed-config refusal), and the same
  > out-of-scope guard. Its stale *"the served model-mapping council … not live
  > yet"* clause is deleted; remote-host agent + per-host source-control detection
  > stay listed as honest-empty (still true — C17).
  >
  > **Grep record — effectively a no-op.** `grep -rn -iE "no dedicated
  > council|honest-empty|council screen|model-mapping council|served
  > model|reviewRoles|model mapping|edit mappings|review section|role
  > assignment|routing\.task" docs/` (excluding `docs/dist`) returned NO stale
  > claim outside the two files this task edits. The one third-party hit,
  > `docs/using/guides/getting-started.md:307` ("the model mappings for the review
  > roles" on the Environments card), was already true and is now truer; left
  > unchanged.

- [ ] 6.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm **zero new packages**, additive-only protocol — lint, typecheck, test, build). Commit. Output the completion sigil `<promise>C16-COMPLETE</promise>` and flip C16's entry in `BUILD-STATUS.json` (left to MAIN per dispatch — state the intent in the report).
