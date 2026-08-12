# Design — own-branch-submission (N1 / #257 + #107)

## The approach: reuse the shipped egress, do not invent a second

#235 already ships a real GitHub egress for the `other-pr` destination (line-anchored comments on someone else's PR). Own-branch submission is a **different verb on the same pipe**: push a branch, then create a PR. The design is to reuse that egress path — the same authenticated GitHub client, the same one-human-click trigger — and add the push + PR-create action, **not** to build a parallel submission path. Two egress paths would diverge; one path with two verbs stays honest.

## Rule Zero framing (why the blocker was doctrine)

R33 ("the preview is pure; Rennet never pushes source code") and the `publish.egress` "separate GATED act" were written when own-branch was preview-only. Rule Zero supersedes them: **submitting a PR requires a push**, so a product that reviews your branch and cannot open the PR is not doing its job. Pushing a branch is not publishing. The one thing that stays is the **single human sign-click** — not as a consent gate, but because the review is the human's, in their voice, over their signature. That click is the product. Remove the `handoff` no-op and the gate comments; keep the click.

## #107 — a branch ref, not a SHA

The own-branch `PrSubmissionContext` currently carries `patchset.repository.headOid.slice(0, 7)` — a short commit SHA — where GitHub's PR `head` requires a **branch ref**. It was a harmless honest placeholder while the path was preview-only; the moment sign actually creates a PR it becomes a bug (GitHub cannot open a PR with a bare SHA as `head`). Thread the review's real head **branch ref** into that context. If the branch ref crosses the IPC boundary, add it to the `packages/protocol` Zod schema — an **optional** field is silently stripped with every unit test still green (this class has already killed shipped features), so make it required or annotate the schema type.

## One click, one push, one PR

The action must fire **exactly once** per sign click. React re-renders must not double-push or double-create. Guard the trigger so a re-render during the async push/create does not re-enter, and surface the returned PR URL on success. On failure, surface the failure honestly — never a fabricated success (a "ran clean" shown when the push failed is a Rule Zero lie).

## Wireframes

`13-paper-sign` is the sign action; `12-collation-draft` is the editable draft whose title/body must be what lands on the PR (including the human's edits). Read their source under `wireframes/src/`. Where a frame and the issue prose disagree, the frame wins and the PR says so.

## What stays untouched

The `other-pr` path (#235) must be byte-identical after this change — a regression test proves its payload and behaviour are unchanged. Wiring own-branch must not perturb the path that already works.
