---
name: docs-refresh
description: Use when the user wants the Rennet documentation brought back in line with shipped behavior — "refresh the docs", "update stale docs", "docs drift", after a docs-audit produced findings, or as the follow-through of a periodic docs sweep.
---

# Docs refresh

Audit → fix → gate → PR. Fixes only what an audit proved stale, with evidence.

## Steps

1. **Audit first.** If there is no fresh findings list, run the `docs-audit` skill. Never edit from memory of "what probably changed".
2. **Resolve conflicts before dispatch.** Where findings disagree (or contradict a page already verified current), the orchestrator checks git log + issue state itself and writes ONE canonical status phrasing per contested fact. Fix agents receive that phrasing as verified ground truth so all pages reconcile the same way.
3. **Branch:** `docs/refresh-<YYYY-MM-DD>`.
4. **Dispatch fix agents** (opus, parallel) on **disjoint file sets** — no two agents touch the same file. Each prompt carries: the verified ground truth block, the per-file finding + fix, "minimal surgical edits", "no nx/pnpm runs, no commits", and the style rules from `docs/src/content/docs/developing/contributing/docs-style-guide.md`.
   - Authority pages (`contracts-and-rulings.md`, `architecture-contracts.md`, `product-and-vision.md`): status-fact updates only; a ruling's decision text never changes.
   - Stale code comments found along the way are fair game (a comment that lies is a bug), but keep code edits to comments.
5. **Review the diff yourself** (`git diff`) — check every edit against its finding; revert anything an agent invented beyond its brief.
6. **Gate:** `sh -c 'pnpm nx affected -t lint,typecheck,test,build'` minimum; `pnpm check` before push. Docs build must pass (`rennet-docs` project).
7. **Commit** as `docs: refresh against shipped behavior (<date>)`, push the branch, open a PR. One `nx` invocation at a time; wrap git/pnpm in `sh -c '...'`.

## Definition of done

Same as the repo's: if someone reads the docs after this change and is now wrong, the change is not done. Every finding is either fixed, or listed in the PR body as deliberately left with a reason.

## Rule Zero

No fix may add a gate, confirmation, or restrictive language, whatever the finding says.

## Periodic use

Run after each merged feature wave, or on a schedule (e.g. weekly via `/loop` or a scheduled agent that invokes `/docs-refresh`). The trigger check is cheap: compare `delivery-order.md`'s "Last checked" stamp and the newest `feat` commits — drift there predicts drift everywhere.
