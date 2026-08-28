import { basename } from "node:path";
import {
  parseCommandInput,
  parseCommandOutput,
  type Review,
  type SessionModel,
  type SessionTrail,
  type SidebarSession,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The client-facing SESSION READ dispatch layer B9 (the runtime) and B11 (the round WRITE)
 * deferred — the seam that unblocks C07's chat dock and C09's rounds ledger off their
 * MemoryBridge/honest-absent stubs.
 *
 *   • `session.transcript` (C07): the chat dock's read. The harness CLI stays the canonical
 *     conversation owner (#466 res. 3; Rennet persists only the `HarnessCursor` for resume) —
 *     but issue-set B adds an ADDITIVE display read-model: the turn loop captures the harness
 *     events it already sees, projects them to transcript rows (R19-scrubbed), and persists them
 *     so the dock shows history and survives reload. This read serves those rows via
 *     `transcriptRowsForReview`; honest-empty (`[]`) when no turns were captured yet. The live ask
 *     threads still arrive separately via `review.reattach`. The identity trail is Rennet's here.
 *
 *   • `session.list` + `session.rename` / `session.setPinned` / `session.archive` (C03, bound
 *     in C18): the sidebar's session rows and their writes, served from the durable session
 *     store. The sidebar was honestly EMPTY because protocol carried no `session.list`; these
 *     serve real rows and persist every edit, so a rename, a pin, or an archive survives
 *     reload. Restore is un-archive (the boolean), not a fourth command.
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

/**
 * One persisted session as the sidebar reads it (C18). Every field is a FACT of the record:
 * the title is the reviewer's own rename, else the claimed branch, else the honest "New
 * review" placeholder for a session that has claimed nothing yet. `target` distinguishes
 * only what the claim can prove — a PR number means `your-pr`, its absence means
 * `your-branch`; a teammate's PR is not knowable from the session record, so it is never
 * guessed. `targetState` and unread activity are likewise absent rather than invented.
 */
export function sidebarSessionOf(session: SessionModel): SidebarSession {
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title ?? session.claim?.branch ?? "New review",
    target: session.claim?.prNumber === undefined ? "your-branch" : "your-pr",
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.archivedAt === undefined ? {} : { archived: true }),
    createdAt: session.createdAt,
  };
}

export function sessionHandlers(rt: DispatchRuntime) {
  return {
    "session.transcript": async (rawInput) => {
      const name = "session.transcript" as const;
      const input = parseCommandInput(name, rawInput);
      // Freshness-pin the review (throws for a genuinely unknown id, like every review read);
      // the client only calls this once a slug has resolved to a real review.
      const review = rt.requireReviewById(input.reviewId);
      // The projected coding turns the turn loop captured for this session (issue-set B), already
      // R19-scrubbed at projection time. Honest-empty by construction: no store wired, or a session
      // with no captured turns yet, returns `[]` — capability present, never fabricated content.
      const rows = rt.deps.transcriptRowsForReview?.(input.reviewId) ?? [];
      return parseCommandOutput(name, { trail: sessionTrailForReview(review), rows: [...rows] });
    },
    "session.rounds": async (rawInput) => {
      const name = "session.rounds" as const;
      const input = parseCommandInput(name, rawInput);
      rt.requireReviewById(input.reviewId); // reachability: unknown review is a genuine error
      const records = rt.deps.roundRecordsForReview?.(input.reviewId) ?? [];
      return parseCommandOutput(name, { records: [...records] });
    },
    "session.roundEvents": async (rawInput) => {
      const name = "session.roundEvents" as const;
      const input = parseCommandInput(name, rawInput);
      rt.requireReviewById(input.reviewId); // reachability: unknown review is a genuine error
      // The catch-up read for the live round channel (C15 3.1): the ordered events this
      // review's round has emitted so far, which the client folds through the SAME
      // `advance` reducer the live push feeds. Empty until a round dispatches — a cold
      // mount with no round in flight is honestly absent, never a fabricated phase.
      const events = rt.deps.roundEventsForReview?.(input.reviewId) ?? [];
      return parseCommandOutput(name, { events: [...events] });
    },
    "session.list": async (rawInput) => {
      const name = "session.list" as const;
      parseCommandInput(name, rawInput);
      // The sidebar's rows, straight off the durable session store. No store wired ⇒ an
      // honest empty sidebar: the capability is present, the rows are simply not there.
      return parseCommandOutput(name, { sessions: [...(rt.deps.sessions?.list() ?? [])] });
    },
    "session.rename": async (rawInput) => {
      const name = "session.rename" as const;
      // An emptied title CLEARS the reviewer's title, so the row falls back to the
      // claimed branch — the same restore-the-default rule an emptied project name
      // follows. A session the store does not hold answers `null`: nothing was written.
      const input = parseCommandInput(name, rawInput);
      const session = rt.deps.sessions?.rename(input.sessionId, input.title) ?? null;
      return parseCommandOutput(name, { session });
    },
    "session.setPinned": async (rawInput) => {
      const name = "session.setPinned" as const;
      const input = parseCommandInput(name, rawInput);
      const session = rt.deps.sessions?.setPinned(input.sessionId, input.pinned) ?? null;
      return parseCommandOutput(name, { session });
    },
    "session.archive": async (rawInput) => {
      const name = "session.archive" as const;
      // Archive is the only release (a soft delete — the record survives on disk), and
      // `archived: false` is its inverse, so an accidental archive is recoverable.
      const input = parseCommandInput(name, rawInput);
      const session = rt.deps.sessions?.setArchived(input.sessionId, input.archived) ?? null;
      return parseCommandOutput(name, { session });
    },
  } satisfies Record<string, CommandHandler>;
}
