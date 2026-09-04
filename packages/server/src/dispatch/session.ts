import { basename } from "node:path";
import { parseUnifiedDiffFiles } from "@rennet/adapters";
import {
  parseCommandInput,
  parseCommandOutput,
  type Review,
  ROUND_NO_REGEN,
  type RoundLedgerRecord,
  type RoundRecord,
  type SessionModel,
  type SessionTrail,
  type SidebarSession,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The client-facing SESSION dispatch layer — the seam C07's chat dock and C09's rounds
 * ledger read through, off their old MemoryBridge/honest-absent stubs.
 *
 *   • `session.transcript` (C07): the chat dock's read. The harness CLI stays the canonical
 *     conversation owner (#466 res. 3; Rennet persists only the `HarnessCursor` for resume) —
 *     but issue-set B adds an ADDITIVE display read-model: the turn loop captures the harness
 *     events it already sees, projects them to transcript rows and persists them verbatim
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
 *   • `session.mint` (C21): the New Chat front door's WRITE. A row click mints a durable
 *     session AND claims its target in one act, through the same `SessionEntry` the round
 *     dispatch already mints with — so a target claimed from New Chat and a target claimed
 *     by a dispatched round are the SAME session, never two. Mint-or-reattach: a second
 *     click on a claimed target returns the session owning it. No branch ⇒ a no-target
 *     session (the "talk about the project" row), which claims nothing.
 *
 *   • `session.rounds` (C09): the rounds-ledger read. Projects the live rounds runtime's
 *     `RoundRecord[]` for the review's session (resolved read-only from the ask-log/target
 *     claim). A session that has dispatched no round is honestly `[]`; from the first round
 *     onward it carries real rows, because BOTH `runRound` and `dispatchRound` record a
 *     `RoundRecord` — the dispatch-only one stamped `ROUND_NO_REGEN` for the generation it
 *     did not mint, superseded in the durable ledger when the regeneration lands.
 */

/**
 * The chat dock's header trail from the review's identity facts (C07). Honest-minimal — no
 * fabrication: `title` is the branch, else the PR number, else "New review"; `target` is the
 * own-branch/own-PR/teammate-PR fact (same signal round.ts routes exits on); `projectName` is
 * the repo folder name. `targetState` (needs-you/merged/reviewed) is left absent — it is not a
 * plain fact of the review and is never invented here.
 */
export function sessionTrailForReview(review: Review, workspace?: string): SessionTrail {
  const activePatchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
  const branch = activePatchset?.repository.headRef;
  const target: SessionTrail["target"] = review.postTarget
    ? review.postTarget.viewerDidAuthor === false
      ? "teammate-pr"
      : "your-pr"
    : "your-branch";
  const title = branch ?? (review.postTarget ? `PR #${review.postTarget.number}` : "New review");
  const projectName = basename(review.repositoryRoot) || undefined;
  // The workspace every turn of this session runs in (session-bound-workspace): shown beside
  // the branch so the reviewer can see WHICH checkout a seat read. Absent when nothing has
  // bound one, rather than guessing the repository root.
  return {
    title,
    target,
    ...(projectName ? { projectName } : {}),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/**
 * One persisted session as the sidebar reads it (C18). Every field is a FACT of the record:
 * the title is the reviewer's own rename, else the claimed branch, else the honest "New
 * review" placeholder for a session that has claimed nothing yet. `target` distinguishes
 * only what the claim can prove — a PR number means `your-pr`, its absence means
 * `your-branch`; a teammate's PR is not knowable from the session record, so it is never
 * guessed. `subtitle` is projected only from the latest terminal completed row in the
 * durable rounds ledger. `targetState` and unread activity are likewise absent rather than
 * invented.
 */
function latestCompletedRoundNumber(records: readonly RoundRecord[]): number | undefined {
  const index = records.findLastIndex(
    (record) =>
      record.outcome === "completed" &&
      (record.boardGeneration !== ROUND_NO_REGEN || record.regeneration !== "pending"),
  );
  return index < 0 ? undefined : index + 1;
}

export function sidebarSessionOf(
  session: SessionModel,
  roundRecords: readonly RoundRecord[] = [],
): SidebarSession {
  const completedRoundNumber = latestCompletedRoundNumber(roundRecords);
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title ?? session.claim?.branch ?? "New review",
    target: session.claim?.prNumber === undefined ? "your-branch" : "your-pr",
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.archivedAt === undefined ? {} : { archived: true }),
    // The claimed target, verbatim off the record (C21) — New Chat hides every row matching
    // either half of it while the claim holds. A no-target session carries none, so it hides
    // nothing; archive is still the only release, read off `archived`.
    ...(session.claim === undefined ? {} : { claim: session.claim }),
    // Which repo the claim is IN (#580). `repositoryRoot` is a host path and stays here;
    // this is the `owner/name` identity, and New Chat needs it to keep the row-hide
    // repo-precise across a workspace project's several repositories.
    ...(session.repository === undefined ? {} : { repository: session.repository }),
    ...(session.forgeRepository === undefined ? {} : { forgeRepository: session.forgeRepository }),
    // The attached review (#587): the front door captures the clicked target's change and
    // binds it here, so `/s/<sessionId>` resolves to the review workspace. Absent means
    // nothing has been captured for this session — honestly, there is no diff.
    ...(session.reviewId === undefined ? {} : { reviewId: session.reviewId }),
    ...(session.preparation === undefined ? {} : { preparation: session.preparation }),
    ...(completedRoundNumber === undefined
      ? {}
      : { subtitle: `Round ${completedRoundNumber} is back` }),
    createdAt: session.createdAt,
  };
}

/**
 * A ledger record with its ROUND DIFF split per file (#571). `RoundRecord.diff` is the
 * checkpoint-measured working-tree diff of the round's coding turn — the change the round
 * actually made — and the durable store deliberately keeps it across the regeneration that
 * supersedes the dispatch placeholder. So the round diff is derivable from what is already
 * stored; nothing needs a per-round patchset projection.
 *
 * Split HERE, at the one read seam, through the SAME hardened parser the degraded REST
 * changeset source uses (`parseUnifiedDiffFiles` — it owns the #310 in-hunk-header trap and
 * the same-path type-change coalescing), so the round diff and a PR diff are parsed by one
 * grammar. Derived on read and never persisted: the durable ledger keeps one copy.
 *
 * A round with no captured diff (a regeneration-only round) gets NO `diffFiles`, and a diff
 * that parses to nothing gets none either — the ledger then offers no Round-diff control,
 * rather than a control that lands on an empty surface.
 */
function withRoundDiffFiles(record: RoundRecord): RoundLedgerRecord {
  if (record.diff === undefined || record.diff.trim().length === 0) return record;
  const diffFiles = parseUnifiedDiffFiles(record.diff);
  return diffFiles.length === 0 ? record : { ...record, diffFiles };
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
      // stored raw (R19 runs at the wire, for a projected connection). Honest-empty by
      // construction: no store wired, or a session
      // with no captured turns yet, returns `[]` — capability present, never fabricated content.
      const rows = rt.deps.transcriptRowsForReview?.(input.reviewId) ?? [];
      const workspace = rt.deps.boundWorkspaceForReview?.(input.reviewId)?.root;
      return parseCommandOutput(name, {
        trail: sessionTrailForReview(review, workspace),
        rows: [...rows],
      });
    },
    "session.rounds": async (rawInput) => {
      const name = "session.rounds" as const;
      const input = parseCommandInput(name, rawInput);
      rt.requireReviewById(input.reviewId); // reachability: unknown review is a genuine error
      const records = rt.deps.roundRecordsForReview?.(input.reviewId) ?? [];
      const projected = await Promise.all(
        records.map(async (record) => {
          const base = withRoundDiffFiles(record);
          if (record.reportBoard === ROUND_NO_REGEN) return base;
          const report = await rt.deps.reportBoardForReview?.(input.reviewId, record.reportBoard);
          return report === undefined ? base : { ...base, report };
        }),
      );
      return parseCommandOutput(name, { records: projected });
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
    "session.mint": async (rawInput) => {
      const name = "session.mint" as const;
      // The New Chat front door (C21, #587/#668). Starting a session is ONE host-owned act:
      // mint and claim durably, return immediately, then capture and draft behind the
      // session's preparation state. The client cannot resolve which repo a workspace row named. No store
      // wired ⇒ `session: null`: nothing was started, said in the same honest language
      // the sibling writes use, never a fabricated row the client would navigate into.
      const input = parseCommandInput(name, rawInput);
      const started = await rt.deps.sessions?.start({
        projectId: input.projectId,
        commandId: input.commandId,
        ...(input.replacesSessionId === undefined
          ? {}
          : { replacesSessionId: input.replacesSessionId }),
        ...(input.branch === undefined
          ? {}
          : {
              target: {
                branch: input.branch,
                ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
                // The row's `owner/name` (#580): a workspace's two `main` branches are two
                // targets, not one — and it is what resolves the capture to the right repo.
                ...(input.repository === undefined ? {} : { repository: input.repository }),
                ...(input.forgeRepository === undefined
                  ? {}
                  : { forgeRepository: input.forgeRepository }),
              },
            }),
      });
      return parseCommandOutput(name, {
        session: started?.session ?? null,
        reattached: started?.reattached ?? false,
      });
    },
    "session.cancelPreparation": async (rawInput) => {
      const name = "session.cancelPreparation" as const;
      const input = parseCommandInput(name, rawInput);
      const session = rt.deps.sessions?.cancelPreparation(input.sessionId) ?? null;
      return parseCommandOutput(name, { session });
    },
    "session.retryPreparation": async (rawInput) => {
      const name = "session.retryPreparation" as const;
      const input = parseCommandInput(name, rawInput);
      const session =
        (await rt.deps.sessions?.retryPreparation(input.sessionId, input.commandId)) ?? null;
      return parseCommandOutput(name, { session });
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
      // AWAITED: archiving aborts and awaits the session's own preparation first, so the
      // sweep below cannot race a seat still able to bind a thread (review finding 2).
      const session =
        (await rt.deps.sessions?.setArchived(input.sessionId, input.archived)) ?? null;
      // Archiving is also the sidecar's pruning act (t3-lens-threads 1.7): the session's
      // own thread and every seat thread its generations left behind are deleted and their
      // bindings dropped, AFTER the archive has persisted. Un-archiving restores nothing —
      // the next use creates fresh threads. Both ids are swept because the two kinds are
      // bound under different ones: the session thread under the REVIEW id (that is what
      // `chat.t3Session` and the handoff bind on), the seat threads under the session id.
      if (input.archived && session !== null) {
        const ids = [
          input.sessionId,
          ...(session.reviewId === undefined ? [] : [session.reviewId]),
        ];
        // The session's context files go on the SAME boundary as its threads
        // (session-context-files): they are kept until archive precisely so a reopened
        // transcript or a resumed round still finds them, and removed here because after
        // an archive nothing will read them again. The host resolves the bound root.
        rt.deps.purgeSessionContext?.(input.sessionId);
        // `forgetSession` never throws: an absent sidecar has nothing to delete and still
        // drops the bindings. Awaited so the command answers after the cleanup, not before.
        await rt.deps.t3Sidecar?.forgetSession(ids);
      }
      return parseCommandOutput(name, { session });
    },
  } satisfies Record<string, CommandHandler>;
}
