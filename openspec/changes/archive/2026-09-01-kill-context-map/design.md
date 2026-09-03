## Context

See proposal.md for motivation. This design is recorded as built: the change landed in two commits on 2026-09-01 (`52920b749` "Kill the context map: lens agents investigate the checkout", `a5bf28522` "Kill follow-up: pinned-tree diff range, journal compat") before its design and tasks artifacts were written, and the artifacts are completed here so the change can be archived truthfully. Verified against `main` on 2026-09-03: `packages/core/src/knowledge` is gone, the three `project.context*` commands and the three council jobs are gone, `graphology` is out of every manifest, the drafter prompt carries a task line naming the reviewed range and an inventory with hunk bodies redacted at render, and the add-project ready card reads "Project Ready".

## Goals / Non-Goals

**Goals:**
- A lens drafter reads the change itself in the reviewed checkout; nothing pre-computes its reading for it.
- Nothing model-backed survives in the repo map path. `rennet map` calls no model.
- The Delta packet identifies the reviewed range and inventories the change; it never carries verbatim hunk bodies into a prompt.

**Non-Goals:**
- Touching the deterministic Repo Map (snapshot, symbol and reference shards, import graph, fan-in, overlays, novelty, nested composition).
- Rewording `nested-repo-maps` and `repo-map-net-novel`, whose remaining "knowledge" mentions are vacuous; a follow-up edit.

## Decisions

**The drafter's context is a task line plus an inventory, not a dump.** The prompt is three layers: the lens instructions (payload), one task line stating the reviewed range by `baseOid`/`baseRef`/`headOid` (or the pinned tree for a working-tree review) and that the working directory is the reviewed checkout, and the packet inventory (file rows, hunk ids, headers, spans, derived signals) with hunk bodies redacted at render. The seat runs `git diff`, `git show` and file reads itself. Alternative rejected: keep the verbatim diff under a byte cap; a cap only moves the prompt-too-long failure to a different branch size, and the agent already has the checkout.

**Coverage keeps its contract over hunk ids.** Taught-or-skipped coverage is asserted over the inventory's exact hunk ids, so removing the bodies removes bytes, not accountability.

**The five lens prompts say "investigate before you draft" once, as a shared partial.** `packages/prompts/src/prompts/investigate-before-you-draft.md` is included by every lens prompt; `design.md`'s "do not rediscover files with tools" is rescoped to artifact selection.

**Delete, do not gate.** The knowledge swarm, the Context Map surface, the Map pill, the `--enrich` CLI leg and the knowledge half of the packet are removed outright; no feature flag or compatibility layer remains.

**Spec handling.** The four killed capabilities' specs were removed from `openspec/specs/`, and `repo-map-delta-pass` and `wsl-execution-mode` were amended in place; this change's `specs/` carries the same edits as deltas for the record. Archive therefore runs with `--skip-specs`, because the promoted specs already match.

## Risks / Trade-offs

- [A seat that does not investigate cites nothing and drafts from the inventory alone] → the lint ladder rejects boards whose citations do not resolve to inventory hunks, and the investigate partial is in every prompt.
- [A very large branch still costs the seat many tool calls] → this is the seat reading the change, which is the product; the cost is visible per seat since seats became T3 threads (`t3-lens-threads`).
