// The reviewed pull request's own paper, as a session context file (review finding 6).
//
// The Design seat is told that the commit messages of the reviewed range and the PULL
// REQUEST BODY are the strongest clue to which specification this branch was written
// against. It then drafts in a DETACHED PR worktree, where `gh pr view` has no branch to
// resolve — so the one clue the prompt calls strongest is the one clue the seat cannot
// reach. The title and body were already frozen on the patchset's captured intent (#136),
// so they belong in the session's context directory like everything else a turn may read.

import type { PromptContextFile } from "@rennet/prompts";
import type { Review } from "@rennet/protocol";

/** The one name the reviewed PR's paper is written and read under, per session. */
export const PR_PAPER_FILE = "pr.md";

/**
 * The reviewed pull request's title and description as a context file, or `undefined`
 * when there is no PR paper to write.
 *
 * `undefined` in two cases, both honest absences rather than empty files:
 *
 *   • the review has no post target — a working-tree or branch capture, which never had a
 *     pull request at all; and
 *   • the capture recorded no PR title and no PR body (`prBodyAbsent`, or a PR whose
 *     author wrote nothing). A `pr.md` holding an empty body is a file that claims the
 *     author said something, and the seat would read it as evidence.
 *
 * The body is NOT bounded: this is a file, not a prompt, and a file is not billed. What
 * the prompt carries is the path.
 */
export function prPaperContextFile(review: Review): PromptContextFile | undefined {
  if (review.postTarget === undefined) return undefined;
  const intent = review.patchsets.find(
    (patchset) => patchset.id === review.activePatchsetId,
  )?.intent;
  const title = intent?.prTitle?.trim() ?? "";
  const body = intent?.prBody?.trim() ?? "";
  if (title === "" && body === "") return undefined;
  const heading = title === "" ? `Pull request #${review.postTarget.number}` : title;
  return {
    name: PR_PAPER_FILE,
    body: `# ${heading}\n\n${body}\n`,
    holds: "The reviewed pull request's own title and description, as the capture froze them.",
    readWhen:
      "when you need what the author SAID this change is for — it names the spec, the issue or the story.",
  };
}
