import { Button } from "@rennet/ui";
import { useState } from "react";
import { useMutation } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// Where the round's commits are, when they are not on the branch the reviewer has out
// (workspace-settings D4). One line on the round card, and the action that closes the gap.
//
// This exists because `workspace: own` makes a true sentence about the reviewer's branch
// stop being true: the round committed on `rennet/feat/x`, so `feat/x` did not move, and
// after a pull request is submitted `feat/x` is behind its upstream. Neither fact is
// visible anywhere else, and a reviewer who does not know either will `git log feat/x` and
// see nothing the round did.
//
// The line names THE BRANCH — not Rennet, not the workspace setting, not the binding.
// "Rennet worked in its own worktree" is a fact about Rennet's machinery; "the round's
// commits are on rennet/feat/x" is a fact about the reviewer's repository, and it is the
// one that tells them what to type next.
//
// There is no confirmation step. The button runs `git merge --ff-only` in the checkout that
// has the branch out, and what stops it is git — whose refusal is printed here verbatim,
// with the action still offered, because the reviewer's next move (commit, or stash their
// own work) makes the same click succeed.
// ─────────────────────────────────────────────────────────────────────────────

/** What a click left behind: git's own sentence, or where the branch now points. */
type LandOutcome =
  | { readonly kind: "landed"; readonly headOid: string }
  | { readonly kind: "message"; readonly text: string };

export function WorkBranchNote({
  sessionId,
  branch,
  workBranch,
  pushed,
}: {
  readonly sessionId: string;
  /** The branch the review is about — the one the reviewer has checked out. */
  readonly branch: string;
  /** The branch the round committed on. Equal to `branch` ⇒ nothing to say. */
  readonly workBranch: string;
  /** True once the work branch reached `branch`'s name on the remote. */
  readonly pushed?: boolean;
}) {
  const [outcome, setOutcome] = useState<LandOutcome | undefined>(undefined);
  const { mutate, pending } = useMutation("session.landWorkBranch", {
    // The sidebar row carries `workBranch`/`workBranchPushed`, and a landing can make the
    // sibling collectable — so the rows the surface reads are re-asked after a click.
    invalidates: ["session.list"],
  });
  // Under `share` the two names are the same branch and there is nothing to report.
  if (workBranch === branch) return null;
  return (
    <div data-testid="round-work-branch" className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-sm">
        {pushed === true ? (
          <>
            <code>{branch}</code> is behind its upstream — the round's commits went out from{" "}
            <code>{workBranch}</code>.
          </>
        ) : (
          <>
            The round's commits are on <code>{workBranch}</code>. <code>{branch}</code> has not
            moved.
          </>
        )}
      </p>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          data-testid="land-work-branch"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={async () => {
            const answer = await mutate({ sessionId });
            setOutcome(
              answer.status === "landed"
                ? { kind: "landed", headOid: answer.headOid }
                : { kind: "message", text: answer.reason },
            );
          }}
          className="self-start"
        >
          Fast-forward {branch}
        </Button>
        {outcome !== undefined && (
          // Git's own words, or where the branch landed. Never rewritten, never softened:
          // the refusal is the instruction.
          <span
            data-testid="land-work-branch-outcome"
            className="whitespace-pre-wrap text-muted-foreground text-xs"
          >
            {outcome.kind === "landed"
              ? `${branch} is at ${outcome.headOid.slice(0, 7)}`
              : outcome.text}
          </span>
        )}
      </div>
    </div>
  );
}
