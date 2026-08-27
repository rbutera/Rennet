# Context packet — C16 council-mappings

Read `openspec/BUILD-LOOP.md` first. Added 2026-08-28 under Rai's honest-present
ruling; not in the original 32.

## Objective

Make the Review section of the Environments settings page real. Expose the Model
Council's review-role → model assignments as readable and editable config across
all three scenarios (`dual`, `claudeOnly`, `codexOnly`), binding
`SettingsProjection.reviewRoles` and `setRoleAssignment` to live `settings.*`
commands over the council tables that already exist in
`packages/core/src/model-council*`. Per #485: the review-mode switch, the roles
list, and the mappings dialog cell edit. Values carry the `{value, layer}`
provenance contract; an unassigned role is honestly unassigned, never a guess.

## Out of scope

Host and tool detection (C17). Adding council job ids or changing routing —
this change exposes the existing table, it does not re-decide it.

## Blocked by

B10 (settings ladder + `settings.*` commands). C10 (the pages that render this).

## Sources

- The spec: https://github.com/rbutera/rennet/issues/485 · settings ladder: https://github.com/rbutera/rennet/issues/476
- Council tables: `packages/core/src/model-council*`
- The seam this deletes a slice of: `packages/app-ui/src/settings/data/projections.tsx`
- Docs: `docs/developing/concepts/model-council.md`, `docs/developing/guides/settings-and-setup.md`

## Verification

- `pnpm check` green. E2E: change a role assignment in one scenario, reload, and
  the change persists with its provenance chip; a role with no assignment renders
  honestly unassigned. Positive control: a scenario with no mapping renders no row
  rather than a fabricated default.

## Completion sigil

`<promise>C16-COMPLETE</promise>`
