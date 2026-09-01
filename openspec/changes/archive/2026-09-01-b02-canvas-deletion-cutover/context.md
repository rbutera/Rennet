# Context packet — B2 canvas-deletion-cutover

Read `openspec/BUILD-LOOP.md` first. Plan row: B2.

## Objective

Delete-first cutover (decided, Q3): execute the #459 deletion census wholesale. Delete the `Canvas` state model block (`packages/types`→now `protocol` after B1), `core/canvas.ts` + `canvas-ops` + `canvas-change-feed`, protocol `canvas.*` commands + schemas, `packages/adapters/canvas-ops-*`, `packages/app-ui/src/canvas/*` (KEEP only `registrar`, `read-state`, `symbol` — Q17; the other ~22 modules and their 60 DOM tests die), `collation-draft-canvas.tsx`, and stub the mobile canvas route (mobile-on-boards is a separate future effort, Q10). Delete `packages/instructions`; rename `packages/lens-instructions` → `packages/prompts` and absorb survivors. Fold in the `delta-account.ts` → `successor-account` rename.

**Mandatory reconciliation** (engine asset risk 5): #459's KEEP list is stale where #464 overrode it. The model-backed generation passes die (`angle-generation`, `finding-generation`, `decision-generation`, `hypothesis-generation`, `finding-adjudication`, `adjudication-corpus`, `ui-verification`, `ordering-pass`, `rollup-narration`); the deterministic producers survive (`element-diffs`, collation/counterpart, blast-radius, openspec parse, noise pre-classify, `finding-reconcile`). List every file with its verdict in the proposal before deleting.

## Out of scope

Building anything new. `main` stays gate-green (compiles, tests pass); the product being mid-rebuild is accepted (plan: releasable-main suspended at product level).

## Blocked by

B1.

## Sources

- Deletion census: https://github.com/rbutera/rennet/issues/459
- Override: https://github.com/rbutera/rennet/issues/464 (dec. 2 — drafters replace generators)
- Engine asset §1–2 + risk 5: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Docs: delete/rewrite `docs/developing/concepts/canvas-model.md` per #490's scope; coordinate, don't skip

## Verification

- `pnpm check` green; `grep -ri "CanvasAngle\|canvas\." packages/ --include="*.ts"` shows no survivors outside the KEEP verdicts.
- Positive control: the reconciliation file-verdict list in the proposal matches what git actually deleted (diff the lists).

## Completion sigil

`<promise>B02-COMPLETE</promise>`
