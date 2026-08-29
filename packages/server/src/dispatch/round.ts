import {
  applyAskEvent,
  buildHandoffBundle,
  emptyAskProjection,
  handoffDispositionsFromProjection,
  mechanicalComposition,
} from "@rennet/core";
import {
  type AskEvent,
  type AskOccurrence,
  type AskProjection,
  type ComposedHandoffBundle,
  parseCommandInput,
  parseCommandOutput,
  ROUND_NO_REGEN,
  type RoundRecord,
  sha256Hex,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

interface ActiveAskState {
  readonly projection: AskProjection;
  readonly revisions: ReadonlyMap<string, number>;
}

/** Fold the durable log while tracking the event sequence that created or last changed
 * each currently staged occurrence. An ask id can be restored or staged again; the id
 * alone is therefore not a dispatch identity. */
function activeAskState(events: readonly AskEvent[]): ActiveAskState {
  let projection = emptyAskProjection();
  const revisions = new Map<string, number>();
  for (const event of events) {
    const prior = projection;
    switch (event.kind) {
      case "stage":
        revisions.set(event.ask.id, event.seq);
        break;
      case "edit":
        if (prior.stagedAsks[event.id] !== undefined) revisions.set(event.id, event.seq);
        break;
      case "restore":
        if (prior.retired[event.id] !== undefined) revisions.set(event.id, event.seq);
        break;
      case "unstage":
        revisions.delete(event.id);
        break;
      case "retire":
        if (prior.stagedAsks[event.id] !== undefined) revisions.delete(event.id);
        break;
      default:
        break;
    }
    projection = applyAskEvent(projection, event);
  }
  for (const id of revisions.keys()) {
    if (projection.stagedAsks[id] === undefined) revisions.delete(id);
  }
  return { projection, revisions };
}

function occurrencesFor(
  bundle: ComposedHandoffBundle,
  revisions: ReadonlyMap<string, number>,
): AskOccurrence[] {
  return bundle.tasks.flatMap((task) =>
    task.asks.map((ask) => {
      const revision = revisions.get(ask.id);
      if (revision === undefined) {
        throw new Error(`Round dispatch lost the active occurrence for ask ${ask.id}.`);
      }
      return { id: ask.id, revision };
    }),
  );
}

function dispatchIdentity(
  reviewId: string,
  sourcePatchsetId: string,
  askOccurrences: readonly AskOccurrence[],
): string {
  return sha256Hex(JSON.stringify({ reviewId, sourcePatchsetId, askOccurrences }));
}

function projectionForRecordedOccurrences(
  events: readonly AskEvent[],
  state: ActiveAskState,
  askOccurrences: readonly AskOccurrence[],
): AskProjection {
  const stagedAsks: AskProjection["stagedAsks"] = {};
  const occurrencesByRevision = new Map<number, AskOccurrence[]>();
  for (const occurrence of askOccurrences) {
    const atRevision = occurrencesByRevision.get(occurrence.revision) ?? [];
    atRevision.push(occurrence);
    occurrencesByRevision.set(occurrence.revision, atRevision);
  }
  let historical = emptyAskProjection();
  for (const event of events) {
    historical = applyAskEvent(historical, event);
    for (const occurrence of occurrencesByRevision.get(event.seq) ?? []) {
      const ask = historical.stagedAsks[occurrence.id];
      if (ask === undefined) {
        throw new Error(
          `Round dispatch cannot reconstruct ask ${occurrence.id} at revision ${occurrence.revision}.`,
        );
      }
      stagedAsks[occurrence.id] = ask;
    }
  }
  if (Object.keys(stagedAsks).length !== askOccurrences.length) {
    throw new Error("Round dispatch cannot reconstruct every recorded ask occurrence.");
  }
  return { ...state.projection, stagedAsks };
}

function completedTerminalOccurrences(
  records: readonly RoundRecord[],
  reviewId: string,
): AskOccurrence[] {
  return records.flatMap((record) =>
    record.outcome === "completed" &&
    (record.boardGeneration !== ROUND_NO_REGEN || record.regeneration !== "pending") &&
    record.askOccurrences !== undefined &&
    record.dispatchId !== undefined &&
    record.sourcePatchsetId !== undefined &&
    record.dispatchId === dispatchIdentity(reviewId, record.sourcePatchsetId, record.askOccurrences)
      ? record.askOccurrences
      : [],
  );
}

/**
 * The round exit's dispatch command (B11 cluster 4, #458 R29-R36) - fold the review's
 * durable ask projection into ONE work-order and hand it to the rounds runtime, serialized
 * per session and idempotent.
 *
 * The ask-log session id IS the review id (the contract the client honours when it calls
 * `ask.*`), so the dispatched asks are `deps.askLog.readProjection(review.id)`. The round exit
 * consumes EVERY staged ask (prose + code-anchored) - disjoint from the review exit, which
 * posts only the code-anchored subset - and `buildHandoffBundle` keeps the addressed types
 * (request-change / comment), so a review of only questions/approvals composes an empty order.
 *
 * The round exit is OWN-BRANCH ONLY (P1 finding 8, handoff-and-exits.md "Work orders are
 * own-branch only"): a teammate-PR review's lane is *Post review*, not a coding round, and a
 * retrospective review has no exits. The lane is ABSENT there - the command answers an honest
 * `dispatched:false` with an empty order, never kicking a coding worker on someone else's PR.
 *
 * The composed work-order IS the concrete deliverable the command returns. Once fsynced, the
 * completed RoundRecord keyed by the exact ask occurrences prevents worker re-entry; the local
 * memo coalesces concurrent calls before that commit point exists.
 */
export function roundHandlers(rt: DispatchRuntime) {
  const { deps, requireReviewById, activePatchsetOf } = rt;
  // Same-process coalescing, keyed by the same durable identity written into RoundRecord.
  // Model-authored work-order bytes never enter the key.
  const inFlight = new Map<string, Promise<ComposedHandoffBundle>>();

  const consumeCurrent = (reviewId: string, occurrences: readonly AskOccurrence[]): boolean => {
    const state = activeAskState(deps.askLog.read(reviewId));
    const seen = new Set<string>();
    const ids = occurrences.flatMap((occurrence) => {
      if (seen.has(occurrence.id) || state.revisions.get(occurrence.id) !== occurrence.revision) {
        return [];
      }
      seen.add(occurrence.id);
      return [occurrence.id];
    });
    if (ids.length === 0) return false;
    deps.askLog.appendMany(
      reviewId,
      ids.map((id) => ({ kind: "unstage" as const, id })),
    );
    deps.broadcastAskProjection?.(reviewId, deps.askLog.readProjection(reviewId));
    return true;
  };

  return {
    "round.dispatch": async (rawInput) => {
      const name = "round.dispatch" as const;
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      // OWN-BRANCH-ONLY routing (P1 finding 8). A retrospective review has no exits; a
      // teammate-PR review (a postTarget the viewer did NOT author) posts a review, never a
      // coding round. In both the round lane is ABSENT - answer an honest empty order rather
      // than kicking a worker on a PR the reviewer does not own. `viewerDidAuthor` is the SAME
      // own-branch signal the Hand off toggle consults; absent fails safe to teammate.
      if (!isOwnBranchReview(review)) {
        const activePatchset = activePatchsetOf(review);
        const bundle = buildHandoffBundle({
          reviewId: review.id,
          patchset: activePatchset,
          dispositions: handoffDispositionsFromProjection(
            deps.askLog.readProjection(review.id),
            activePatchset,
          ),
        });
        return parseCommandOutput(name, {
          workOrder: mechanicalComposition(bundle),
          dispatched: false,
        });
      }
      const durableRecords = deps.roundRecordsForReview?.(review.id) ?? [];
      // Crash repair before a new bundle: a completed REAL generation is proof that these
      // exact occurrences finished end to end. Consume only revisions that are still current;
      // an edit, restore, or re-stage after that round is a new occurrence and survives.
      consumeCurrent(review.id, completedTerminalOccurrences(durableRecords, review.id));
      const askEvents = deps.askLog.read(review.id);
      const askState = activeAskState(askEvents);
      const activePatchset = activePatchsetOf(review);
      const resumable = [...durableRecords]
        .reverse()
        .find(
          (record) =>
            record.outcome === "completed" &&
            record.boardGeneration === ROUND_NO_REGEN &&
            record.regeneration === "pending" &&
            record.dispatchId !== undefined &&
            record.sourcePatchsetId !== undefined &&
            record.askOccurrences !== undefined &&
            record.dispatchId ===
              dispatchIdentity(review.id, record.sourcePatchsetId, record.askOccurrences),
        );
      const sourcePatchset =
        resumable === undefined
          ? activePatchset
          : (review.patchsets.find((patchset) => patchset.id === resumable.sourcePatchsetId) ??
            activePatchset);
      const projection =
        resumable?.askOccurrences === undefined
          ? askState.projection
          : projectionForRecordedOccurrences(askEvents, askState, resumable.askOccurrences);
      const bundle = buildHandoffBundle({
        reviewId: review.id,
        patchset: sourcePatchset,
        dispositions: handoffDispositionsFromProjection(projection, sourcePatchset),
      });
      // Nothing addressed means nothing to dispatch - decided on the DETERMINISTIC bundle,
      // before any compose. An honest empty order, no kick, no round.
      if (bundle.tasks.length === 0) {
        return parseCommandOutput(name, {
          workOrder: mechanicalComposition(bundle),
          dispatched: false,
        });
      }
      const sourcePatchsetId = resumable?.sourcePatchsetId ?? bundle.patchsetId;
      const askOccurrences = resumable?.askOccurrences
        ? [...resumable.askOccurrences]
        : occurrencesFor(mechanicalComposition(bundle), askState.revisions);
      const key =
        resumable?.dispatchId ?? dispatchIdentity(review.id, sourcePatchsetId, askOccurrences);
      let run = inFlight.get(key);
      if (run === undefined) {
        run = (async () => {
          // ONE coherent work-order (issue #72 composer): the council-routed authoring turn
          // when wired, else the mechanical floor - never a throw, always answerable.
          const workOrder =
            resumable !== undefined
              ? mechanicalComposition(bundle)
              : deps.composeBundle
                ? await deps.composeBundle({ bundle, repoRoot: review.repositoryRoot })
                : mechanicalComposition(bundle);
          // The command returns the order while the round runs behind it. The durable
          // completed placeholder/real record is the cross-restart guard. Only after the
          // full dispatch (including regeneration) succeeds are its still-current asks
          // removed in one atomic batch.
          const kicked = deps.dispatchRound?.({
            review,
            workOrder,
            dispatchId: key,
            sourcePatchsetId,
            askOccurrences,
          });
          if (kicked !== undefined) {
            void kicked
              .then(() => consumeCurrent(review.id, askOccurrences))
              .catch(() => inFlight.delete(key));
          }
          return workOrder;
        })();
        inFlight.set(key, run);
        // A compose failure is retryable too - evict so a re-dispatch recomposes.
        run.catch(() => inFlight.delete(key));
      }
      return parseCommandOutput(name, { workOrder: await run, dispatched: true });
    },
  } satisfies Record<string, CommandHandler>;
}

/**
 * Is this an OWN-BRANCH review, the only mode the round (coding-worker) exit exists for?
 * (P1 finding 8.) True when the review is not retrospective AND either has no post target (a
 * pure own-branch capture that opens its own PR) or has a post target the viewer authored
 * (their own PR - rounds continue on it). A teammate PR (a post target the viewer did not
 * author, or the fail-safe absence of the signal) is NOT own-branch: its exit is Post review.
 * `viewerDidAuthor` is the target-aware signal handoff-and-exits.md routes the toggle on.
 */
function isOwnBranchReview(review: {
  retrospective?: boolean;
  // The index signature keeps this assignable from the concrete `Review.postTarget` (which
  // has no `viewerDidAuthor` until origin/main folds in the own-PR ownership fact) while still
  // reading the field structurally — no weak-type mismatch, and correct after the fold.
  postTarget?: { viewerDidAuthor?: boolean; [k: string]: unknown };
}): boolean {
  if (review.retrospective) return false;
  if (!review.postTarget) return true;
  return review.postTarget.viewerDidAuthor === true;
}
