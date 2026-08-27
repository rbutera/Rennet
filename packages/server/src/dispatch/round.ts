import {
  buildHandoffBundle,
  handoffDispositionsFromProjection,
  mechanicalComposition,
} from "@rennet/core";
import {
  type ComposedHandoffBundle,
  parseCommandInput,
  parseCommandOutput,
} from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

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
 * The composed work-order IS the concrete deliverable the command returns; handing it to the
 * runtime is a failure-isolated post-commit kick (the knowledge-swarm / project-scout
 * precedent). Same-asks idempotency lives HERE: a dispatch of a work-order already in flight
 * (or already dispatched) for this review coalesces onto the SAME kick, so the workers run once
 * per distinct work-order - never a second run.
 */
export function roundHandlers(rt: DispatchRuntime) {
  const { deps, requireReviewById, activePatchsetOf } = rt;
  // The same-asks coalescing memo. Keyed on the DETERMINISTIC INPUT digest (patchset +
  // `bundle.digest`, a content hash over the sorted addressed dispositions) - NOT the composed
  // work-order digest, which folds in model-authored titles/order and so is nondeterministic
  // (P1 finding 3: a nondeterministic key let a double-click / reconnect / retry re-compose to
  // a DIFFERENT key and dispatch the same asks TWICE - two real coding-agent runs). Coalescing
  // happens BEFORE the live composer, and the memo holds the COMPOSED order so a repeat returns
  // the same work-order without recomposing. A FAILED compose or kick evicts the key so an
  // identical re-dispatch retries (finding 4); a live or succeeded one stays memoised so a
  // repeat coalesces onto it (idempotent: dispatch twice, one run).
  const inFlight = new Map<string, Promise<ComposedHandoffBundle>>();

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
        const bundle = buildHandoffBundle({
          reviewId: review.id,
          patchset: activePatchsetOf(review),
          dispositions: handoffDispositionsFromProjection(deps.askLog.readProjection(review.id)),
        });
        return parseCommandOutput(name, {
          workOrder: mechanicalComposition(bundle),
          dispatched: false,
        });
      }
      const projection = deps.askLog.readProjection(review.id);
      const bundle = buildHandoffBundle({
        reviewId: review.id,
        patchset: activePatchsetOf(review),
        dispositions: handoffDispositionsFromProjection(projection),
      });
      // Nothing addressed means nothing to dispatch - decided on the DETERMINISTIC bundle,
      // before any compose. An honest empty order, no kick, no round.
      if (bundle.tasks.length === 0) {
        return parseCommandOutput(name, {
          workOrder: mechanicalComposition(bundle),
          dispatched: false,
        });
      }
      // The deterministic key: (review, patchset, input digest). Including the patchset stops a
      // successor patchset with the same ask digest colliding onto a stale dispatch.
      const key = `${review.id} ${bundle.patchsetId} ${bundle.digest}`;
      let run = inFlight.get(key);
      if (run === undefined) {
        run = (async () => {
          // ONE coherent work-order (issue #72 composer): the council-routed authoring turn
          // when wired, else the mechanical floor - never a throw, always answerable.
          const workOrder = deps.composeBundle
            ? await deps.composeBundle({ bundle, repoRoot: review.repositoryRoot })
            : mechanicalComposition(bundle);
          // Failure-isolated post-commit kick (the swarm/scout precedent): the round runs
          // BEHIND the command. A FAILED kick evicts the key so an identical re-dispatch
          // RETRIES (finding 4: a failed round must be retryable - honest failure).
          deps.dispatchRound?.({ review, workOrder }).catch(() => inFlight.delete(key));
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
