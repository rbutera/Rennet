import { Button } from "@rennet/ui";
import { useState } from "react";
import { useCommand, useMutation } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// Where the round's commits are, when they are not on the branch the reviewer has out
// (workspace-settings D4). One line beside the session's branch, and the action that
// closes the gap.
//
// This exists because `workspace: own` makes a true sentence about the reviewer's branch
// stop being true: the round committed on `rennet/feat/x`, so `feat/x` did not move, and
// after a pull request is submitted `feat/x` is behind `origin/feat/x`. Neither fact is
// visible anywhere else, and a reviewer who does not know either will `git log feat/x` and
// see nothing the round did.
//
// The line names THE BRANCH — not Rennet, not the workspace setting, not the binding.
// "Rennet worked in its own worktree" is a fact about Rennet's machinery; "the round's
// commits are on rennet/feat/x" is a fact about the reviewer's repository, and it is the
// one that tells them what to type next. The remote-tracking ref is NAMED for the same
// reason: `origin/feat/x` is a ref they can `git log`, where "its upstream" is a concept.
//
// EVERY SENTENCE IS READ FROM GIT AT RENDER (`session.workBranchState`), not from a flag on
// the session row. The row used to carry `workBranchPushed`, stamped once by a push that
// succeeded, and it went on saying "behind its upstream" after a landing or a pull had
// made that false — a durable claim about a ref that keeps moving. The read costs four
// `rev-parse`s and cannot be stale.
//
// It is mounted wherever the workspace shows the session's branch, not only on the round
// greeting: the gap between `feat/x` and `rennet/feat/x` is open from the round that
// created it until the reviewer lands or pulls, and it was invisible on every view but the
// one card that happened to be showing a fresh report.
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

export function WorkBranchNote({ sessionId }: { readonly sessionId: string }) {
  const [outcome, setOutcome] = useState<LandOutcome | undefined>(undefined);
  const { data } = useCommand(
    "session.workBranchState",
    { sessionId },
    { enabled: sessionId.length > 0 },
  );
  const { mutate, pending } = useMutation("session.landWorkBranch", {
    // A landing moves the reviewed branch and can make the sibling collectable, so the
    // sidebar rows are re-asked — and so is THIS read, which is what makes the line change
    // from "has not moved" to nothing at all without a reload. Naming it here rather than
    // refetching by hand is what keeps it true for every mounted copy of this note.
    invalidates: ["session.list", "session.workBranchState"],
  });
  const branch = data?.branch;
  const workBranch = data?.workBranch;
  // Under `share` the two names are the same branch, and after a landing the branch IS the
  // work branch's tip: there is nothing to report in either case.
  if (branch === undefined || workBranch === undefined || workBranch === branch) return null;
  if (data?.landed === true) return null;
  // TWO SENTENCES, TWO NUMBERS. The remote sentence counts what `origin/feat/x` holds that
  // `feat/x` does not (`behindRemote`); the local one counts what the sibling holds that
  // the branch does not (`aheadOfBranch`). They were one number, `ahead`, and the remote
  // sentence rendered the sibling's count — right only while nobody else had pushed, and
  // silently wrong the moment a teammate or a second session moved that ref.
  const behindRemote = data?.behindRemote ?? 0;
  const aheadOfBranch = data?.aheadOfBranch ?? 0;
  const behind = data?.pushed === true && behindRemote > 0 ? data.remoteRef : undefined;
  // A sibling holding nothing the branch does not have leaves no gap to report. It is the
  // shape a collected sibling wears — the ref is gone, so every count reads 0 and `landed`
  // reads false — and "the round's commits are on `rennet/feat/x`" over a branch that no
  // longer exists is the sentence this whole module was rewritten to stop printing.
  if (behind === undefined && aheadOfBranch === 0) return null;
  return (
    // THE NOTE OWNS ITS CHROME (review finding W-strip). The bordered, padded strip used
    // to be the route's, wrapped around this component whether or not it had anything to
    // say — so a landed sibling drew an empty band across the top of the workspace. Only
    // this component knows whether there is a sentence, because the answer is the git read
    // above; every `return null` before this point now renders nothing at all.
    <div
      data-testid="workspace-work-branch"
      className="flex shrink-0 flex-col border-line border-b bg-surface px-6 py-2"
    >
      <div data-testid="round-work-branch" className="flex flex-col gap-1.5">
        <p className="text-muted-foreground text-sm">
          {behind !== undefined ? (
            <>
              <code>{branch}</code> is behind <code>{shortRef(behind)}</code> by {behindRemote}{" "}
              {behindRemote === 1 ? "commit" : "commits"}.
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
    </div>
  );
}

/** `refs/remotes/origin/feat/x` → `origin/feat/x` — what `git log` and `git branch -r`
 *  print, and what the reviewer would type. The fully qualified form is the host's, kept
 *  on the wire so a tag of the same name cannot be mistaken for it. */
function shortRef(ref: string): string {
  const prefix = "refs/remotes/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}
