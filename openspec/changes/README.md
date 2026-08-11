# OpenSpec changes

Two changes are active. Everything else shipped and was archived on 2026-08-11, with its requirements promoted into `openspec/specs/`.

Rule Zero (`AGENTS.md`) outranks every spec in here and in `openspec/specs/`.

## Active

| change | state |
|---|---|
| `build-repo-map-lifecycle` | 4/30. Wave 1 landed (`knowledge.ts`, `escape-path.ts`); the delta-pass half has not. Tracked as #243. |
| `add-review-intelligence-core` | 35/40. Verified task-by-task against `main`. The five open tasks are genuinely unbuilt: the per-review turn ceiling (0.5), the ProjectSnapshot projection into `runHypothesisPass` (5.2), and the `ReviewPipelineInput`/`Result` extension carrying hypothesis and cross-checks (6.1). |

## Archived

24 changes, under `archive/2026-08-11-*`. Their checkboxes were verified against the code on `main` before archiving, not ticked on trust — four changes were found to have real gaps, and those boxes were left open.

Three things were deliberately **not** promoted into `openspec/specs/` during archiving, because archiving would have made retired doctrine canonical:

- **The read-only harness posture** (`build-harness-adapter-protocol`) — capability denial. Still live in code; tracked as #259.
- **"Signing is blocked until run degradations are acknowledged"** (`build-publish-safety-gate`) — a consent gate. The rest of that change is good and did land: emit fidelity (published bytes byte-equal previewed bytes), hold-gate wiring, and the keyboard-accessibility fix.
- **The fail-closed invocation budget** — it appeared in four separate spec deltas (`invocation-budget-gate`, `comprehension-ordering-pass`, `decomposition-angle-generation`, `review-pipeline`), each specifying that an exhausted or absent budget refuses every turn and both phases fall to the deterministic floor. That renders a review with zero model turns as though it were real. Tracked as #260.

`build-local-review-mvp`'s "MVP performs no external mutation or provider call" was also dropped — GitHub mutation, source push, and harness invocation have all since shipped deliberately.
