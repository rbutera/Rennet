# own-branch-submission (N1)

**Issues:** #257 (feature), absorbs #107 (internal). **Owner:** Navi (Zone A). **Review:** dual Opus.
**Wireframes:** `13-paper-sign`, `12-collation-draft`. **Depends on:** nothing. Unblocks the own-branch destination end to end.

## Why

Rennet's one-line pitch ends "…and open the PR." Today it can't, on your own branch. `signPaper()` (`packages/ui/src/app.tsx:1202`) short-circuits the entire own-branch path:

```ts
if (destinationMode === "own-branch") {
  setError(undefined);
  setPublishResult({ kind: "handoff" });   // no-op
  return;
}
```

Real GitHub posting shipped in #235 — but **only for `other-pr`** (line-anchored comments on someone else's PR). So Rennet can review your branch, refine the notes, compose the handoff, and draft the PR body (#74), then stops dead at the one action the product is named for. This is the single largest hole in the product.

The blocker is doctrine, not difficulty. R33 ("the preview is pure; Rennet never pushes source code") and the `publish.egress` "gated act" framing are **superseded by Rule Zero**: submitting a PR *requires* a push. Pushing a branch is not publishing. Publishing is a human clicking sign, and that stays — not as a gate, but because the review is his, in his voice, over his signature. That human click is the product, not a consent screen.

## What Changes

- **Wire own-branch sign to a real action.** On sign, push the review's branch and create the PR with the drafted title/body from #74, then return the PR URL. Reuse the existing GitHub egress path that #235 already proved for `other-pr`; do not invent a second one.
- **Drop the `publish.egress` gate framing.** One plain command. Remove the "separate GATED #21 act" comment at `app.tsx:1197` and the matching dead-state framing in `components/publish-sheet.tsx:81`. The `{ kind: "handoff" }` no-op state goes away for own-branch.
- **Fix #107 in the same pass.** The payload carries `patchset.repository.headOid.slice(0, 7)` — a commit SHA — where a branch **ref** is required (`app.tsx` publish context → `titleFromHead` → `prSubmissionPayload` at `packages/ui/src/canvas/publish.ts:150`). A GitHub PR cannot open with a bare SHA as `head`. Supply the real head branch ref to the own-branch `PrSubmissionContext`.

## Acceptance

- Signing an own-branch review pushes the branch and opens a real PR, **once**, on an explicit human click. The returned PR URL surfaces to the user.
- The PR `head` is a **branch ref**, never a SHA.
- The drafted title/body from #74 — including the human's edits in the collation draft — is exactly what lands on the PR.
- The `other-pr` path (#235) is unchanged: a regression test proves its payload/behaviour is byte-identical.
- Red-proof: with the wiring reverted, own-branch sign produces no push and no PR (the current no-op), and the test for the wired behaviour fails.

## Impact

- **Zone A / renderer.** `packages/ui/src/app.tsx` (the `signPaper` own-branch branch), `packages/ui/src/canvas/publish.ts` (`prSubmissionPayload` head ref), `packages/ui/src/components/publish-sheet.tsx` (dead-state framing).
- **GitHub egress.** The push + PR-create action in the desktop main/adapters — the same egress the `other-pr` post already travels. If the branch-ref shape crosses IPC, add the field to the `packages/protocol` Zod schema (optional fields are silently stripped — make it required or annotate).
- **Leaves the machine** → dual Opus review. This is the one proposal that opens a PR under Rai's name, so the reviewers verify: the push targets the review's own branch (not an unintended ref), the PR opens exactly once per click, and the title/body are the human's edited draft.

## Deferred

- Nothing material. The own-branch path becomes fully live. `other-pr` is untouched.
- Not in scope: any approval ceremony, are-you-sure dialog, or egress gate. The single human sign-click is the whole authorization, by design (`AGENTS.md`: "Pushing a branch is not publishing").
