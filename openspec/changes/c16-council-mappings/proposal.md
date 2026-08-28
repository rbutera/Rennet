# C16 — Council mappings: the Review section made real (readable + editable role→model assignments) (#485)

## Why

The Environments settings page has a Review section, built in C10 (`packages/app-ui/src/settings/environments/model-mappings.tsx`): a review-mode switch, a roles list, and a Model Mappings dialog whose cells edit a role's model per availability scenario. It renders today over an **honest-empty** projection seam — `SettingsProjection.reviewRoles` resolves to `[]` in the live client and `setRoleAssignment` is a no-op, because no `settings.*` command serves the Model Council's tables. The seam's note says so verbatim: *"reviewRoles: no Model-Council / mappings command exists."* So the section is a truthful blank, not a lie — but it is blank.

The council's role→model assignments already **exist** and are authoritative: `packages/core/src/model-council.ts` holds `ASSIGNMENT_TABLES` (the `both` / `claude-only` / `codex-only` tables, one pick per job id) and `resolveAssignment(jobId, ctx)` — a pure resolver that already layers a `ctx.overrides.task[jobId]` on top of the table default and reports its resolution source. What is missing is the **boundary**: `app-ui` cannot import `core`, so the tables reach the surface only through a command. C16 builds that command path and binds it, turning the Review section from honest-empty into honest-present — the real council rows, per scenario, each carrying `{value, layer}` provenance, editable, with an unassigned role rendered honestly unassigned (an em dash, never a fabricated pick).

This lands under Rai's honest-present ruling (context packet header, 2026-08-28), which scopes and reverses #460 §4's "no new settings surface" and the Model Council doc's "no dedicated council screen" **for the mapping display + override only** — a feature under Rule Zero, not a gate. C16 does not re-open that ruling.

## What Changes

- **Core** gains an authoritative review-role catalogue (`REVIEW_ROLE_CATALOGUE`) mapping each of the eight user-legible roles (Orchestrator, Context-Map Workers, Confirmation Worker, Lens Drafters, Flagged Second Seat, Adjudication, Post-Process, Utility) to its backing council **job id — reusing ids that already exist in `JOB_CATALOGUE`** (no new job ids), and a pure `resolveReviewRoles(ctx)` that resolves every role across all three scenarios, honest-null where a role does not run in a scenario, each cell carrying its resolution source.
- **Protocol** gains the wire shape `reviewRoleMappingSchema` (role id/label/hint + per-scenario `{ value: {model,effort} | null, layer }`), an additive `reviewRoles?` field on `settingsViewSchema` (read rides the existing `settings.get`, matching the `keybindings` / `coachmarks` / `daemonHosts` additive-optional precedent), a `routing` overrides slice on `clientSettingsSchema`, and **one new command** `settings.setRoleAssignment` (the mappings dialog cell edit / Reset).
- **Adapters + core resolver** persist the `routing` overrides to `client-settings.json` and load them into `CouncilResolveContext.overrides.task`, so an edit is a config write layered above the council-table default — model + effort only (#89: harness derives from provider, an override never pins a harness), refused on malformed config (Rule 75), `null` clears back to the council default.
- **Client** binds the live projection: `reviewRoles` folds from `settings.get`, `setRoleAssignment` resolves the write command; the honest-empty note is deleted and the Review section's cell renders a **provenance chip** (council default vs overridden).
- **Docs** update `model-council.md` and `settings-and-setup.md` in the same change.

## Out of scope

- Host and tool detection — C17. C16 touches only the review-role mappings, not the Agents/Source-Control detection rows.
- **Adding council job ids or changing routing.** C16 *exposes* the existing table; it does not re-decide it. The role catalogue reuses ids already in `JOB_CATALOGUE`; no assignment value in any table changes.
- The review-mode switch as a *persisted routing override*. The switch selects which availability column is displayed; the detected availability (`harness.detect`) highlights the active one. C16 adds no availability-override persistence (that would be #485's open question 2, not settled by this packet).

## Objective clause → cluster map (every packet clause lands a task)

| Packet clause | Cluster |
| --- | --- |
| Expose `reviewRoles` as **readable** over the existing council tables | 1 (resolve-all) · 2 (`settings.get.reviewRoles`) · 4 (handler) · 5 (bind) |
| Expose `setRoleAssignment` as **editable** across `dual`/`claudeOnly`/`codexOnly` | 2 (`settings.setRoleAssignment`) · 3 (persist) · 4 (handler) · 5 (cell edit + Reset) |
| Values carry the `{value, layer}` provenance contract | 2 (wire schema) · 5 (provenance chip) |
| An unassigned role is honestly unassigned, never a guess | 1 (honest-null) · 5 (em dash) · 6 (positive control) |
| Over the council tables that already exist (no re-decision) | 1 (reuse `ASSIGNMENT_TABLES`, no new job ids) · 6.3 (out-of-scope guard) |

## Reconciliations (part of the spec — hold these, do not re-open)

1. **The UI already exists.** `model-mappings.tsx` (switch, roles list, dialog, "Reset to default") was built in C10 over the honest-empty seam and must not be rebuilt. C16 feeds it real data and adds only the provenance chip the live data now carries. `REVIEW_ROLE_DEFAULTS` in `app-ui/src/settings/assets/model-council.ts` is a hardcoded presentation copy of the tables; once the live read carries both the effective value AND its layer, "is this a default?" derives from `layer`, so that copy stops being the source of truth (kept, if useful, only as the client-side Reset fallback).
2. **Read rides `settings.get`, not a new read command.** `reviewRoles?` is additive-optional on `settingsViewSchema`, exactly as `keybindings` / `coachmarks` / `daemonHosts` already are — one fewer command, matching the house pattern. The lone new command is the **write**, `settings.setRoleAssignment`, whose output echoes the re-resolved mappings for the optimistic update.
3. **The Flagged Second Seat is the honest-null exemplar.** It is a dual-model construct (a Codex seat paired against the Claude drafter via `dual-seat.ts`), not a `both`-table job that also runs single-provider — so it resolves to a real assignment in `dual` and **null** in `claudeOnly`/`codexOnly`. This is the primary case the "never a guess" control must cover.
4. **Overrides are `routing.task.*`, model + effort only (#89).** The write sets the task override the resolver already honours; harness always follows the resolved model's provider. An override can never pin an incoherent harness, so the write schema carries no harness field.
5. **Honest-present, not honest-empty, is now the truthful default** for this section: the council tables are static and always available, so even with no persisted override and no settings dep the read returns the eight roles at their table defaults (`layer: "council-table"`). Empty is reserved for a genuine resolver failure, not for "unconfigured".

## Impact

- Packages: `protocol` (schema + one command), `core` (role catalogue + resolve-all), `adapters` (override persistence), `server` (handlers), `app-ui` (projection bind + provenance chip). No new packages. No new npm dependency.
- Protocol change: additive-optional `reviewRoles?` field + one new command + a `routing` client-settings slice. Old callers ignore the field; an untouched install omits the slice.
- Docs: `docs/developing/concepts/model-council.md`, `docs/developing/guides/settings-and-setup.md`.

## Verification (packet)

`pnpm check` green. E2E over the real command path: change a role assignment in one scenario, reload, and the change persists with its provenance chip; a role with no assignment renders honestly unassigned. **Positive control (must be able to fail):** a scenario with no mapping renders no row / an em dash rather than a fabricated default; the role catalogue naming a job id absent from `JOB_CATALOGUE` fails a test (the no-new-job-id / no-fabrication guard).

## Completion sigil

`<promise>C16-COMPLETE</promise>`
