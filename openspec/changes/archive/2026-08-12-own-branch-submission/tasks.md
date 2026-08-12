# Tasks — own-branch-submission (N1)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof every fix with the prediction named first, then a full green pass. Assert the contract, never your own implementation.

## 1. Locate the live seams
- [x] 1.1 Confirm the own-branch short-circuit in `signPaper()` (`packages/ui/src/app.tsx`, ~1202) and the drafted title/body source from #74 (the collation draft the human edits).
- [x] 1.2 Confirm the GitHub egress path #235 uses for `other-pr` (push/post) and how the desktop main exposes it to the renderer.
- [x] 1.3 Confirm the head-ref bug: `titleFromHead` / `prSubmissionPayload` (`packages/ui/src/canvas/publish.ts:150`) consuming `headOid.slice(0,7)`.

## 2. Supply a real branch ref (#107)
- [x] 2.1 Thread the review's head **branch ref** into the own-branch `PrSubmissionContext` instead of the sliced SHA.
- [x] 2.2 If the branch ref crosses IPC, add it to the `packages/protocol` Zod schema (required or `z.ZodType<T>`-annotated; optional gets stripped silently).
- [x] 2.3 Red-proof: a payload built for own-branch carries `head = <branch ref>`, not a SHA. Assert against the PR-create contract.

## 3. Wire sign → push → PR create
- [x] 3.1 Replace the own-branch `{ kind: "handoff" }` no-op with a real action: push the branch, create the PR via the #235 egress path, carry the #74 drafted title/body (with human edits), return the PR URL.
- [x] 3.2 Surface the returned PR URL to the user on success; surface the failure honestly on error (no fabricated success).
- [x] 3.3 Ensure exactly one push + one PR per sign click (no double-fire on re-render).

## 4. Remove the gate framing
- [x] 4.1 Delete the `publish.egress` "separate GATED #21 act" comment (`app.tsx:1197`) and the matching dead-state framing in `components/publish-sheet.tsx:81`.
- [x] 4.2 Retire the own-branch `handoff` publish-result state if nothing else uses it (verify with `find_referencing_symbols` before deleting).

## 5. Prove it, and prove the neighbour is intact
- [x] 5.1 Red-then-green test: own-branch sign pushes the branch and opens a PR once, head is a branch ref, title/body is the human's edited draft.
- [x] 5.2 Regression: the `other-pr` (#235) payload/behaviour is byte-identical to `main` (a wired own-branch path must not perturb the other-pr path).
- [x] 5.3 Full gate green. State the tip sha and the gate total reconciled against the `main` baseline.
