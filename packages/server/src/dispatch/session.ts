import { basename } from "node:path";
import {
  parseCommandInput,
  parseCommandOutput,
  type Review,
  type SessionTrail,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The client-facing SESSION READ dispatch layer B9 (the runtime) and B11 (the round WRITE)
 * deferred — the seam that unblocks C07's chat dock and C09's rounds ledger off their
 * MemoryBridge/honest-absent stubs.
 *
 *   • `session.transcript` (C07): the chat dock's read. Honest-absent by construction — the
 *     harness CLI owns the coding transcript (#466 res. 3; Rennet persists only the
 *     `HarnessCursor`), so there are no server-side coding turns to return. `rows` is empty
 *     and `contextWindow` absent until a harness-transcript read port lands (a future
 *     capability, not a projection). The live ask threads arrive separately via
 *     `review.reattach`, already wired. Only the identity trail is Rennet's to project here.
 *
 *   • `session.rounds` (C09): the rounds-ledger read. Projects the live rounds runtime's
 *     `RoundRecord[]` for the review's session (resolved read-only from the ask-log/target
 *     claim). Empty until a round RECORDS (`runRound`); the dispatch WRITE (B11) runs the
 *     workers but the record wiring is a separate deferred piece — so the read honestly
 *     returns `[]` today and real rows once a round records.
 */

/**
 * The chat dock's header trail from the review's identity facts (C07). Honest-minimal — no
 * fabrication: `title` is the branch, else the PR number, else "New review"; `target` is the
 * own-branch/own-PR/teammate-PR fact (same signal round.ts routes exits on); `projectName` is
 * the repo folder name. `targetState` (needs-you/merged/reviewed) is left absent — it is not a
 * plain fact of the review and is never invented here.
 */
export function sessionTrailForReview(review: Review): SessionTrail {
  const activePatchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
  const branch = activePatchset?.repository.headRef;
  const target: SessionTrail["target"] = review.postTarget
    ? review.postTarget.viewerDidAuthor === false
      ? "teammate-pr"
      : "your-pr"
    : "your-branch";
  const title = branch ?? (review.postTarget ? `PR #${review.postTarget.number}` : "New review");
  const projectName = basename(review.repositoryRoot) || undefined;
  return { title, target, ...(projectName ? { projectName } : {}) };
}

export function sessionHandlers(rt: DispatchRuntime) {
  return {
    "session.transcript": async (rawInput) => {
      const name = "session.transcript" as const;
      const input = parseCommandInput(name, rawInput);
      // Freshness-pin the review (throws for a genuinely unknown id, like every review read);
      // the client only calls this once a slug has resolved to a real review.
      const review = rt.requireReviewById(input.reviewId);
      return parseCommandOutput(name, { trail: sessionTrailForReview(review), rows: [] });
    },
    "session.rounds": async (rawInput) => {
      const name = "session.rounds" as const;
      const input = parseCommandInput(name, rawInput);
      rt.requireReviewById(input.reviewId); // reachability: unknown review is a genuine error
      const records = rt.deps.roundRecordsForReview?.(input.reviewId) ?? [];
      return parseCommandOutput(name, { records: [...records] });
    },
  } satisfies Record<string, CommandHandler>;
}
