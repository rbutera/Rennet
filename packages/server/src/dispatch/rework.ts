import { carryQuoteAnchor } from "@rennet/core";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import { applyWrite } from "./ask";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The living-draft span-rework command (B11 cluster 5) — the host backing for the
 * client's gated `reviseDraftSpan` seam. A ONE-SHOT worker (a fresh model turn via
 * the injected `reworkSpan` producer, never the resident cursor) reworks one staged
 * ask's body per the reviewer's instruction, then:
 *
 *   1. RE-ANCHORS the reworked span across the regenerated body by quote match
 *      (`carryQuoteAnchor`, reusing the lineage matcher — never a second matcher);
 *      fail-closed, so a span that did not survive regeneration carries `null`.
 *   2. WRITES the regenerated body through the durable ask log — `ask.edit`'s
 *      `applyWrite`, the SOLE ask writer (cluster 2) — so it survives reload and the
 *      returned `receipt` reverses it (receipt-is-undo, like any hand edit).
 *
 * Serialized PER DOCUMENT (the review's ask log is the document): two reworks on one
 * review run one-at-a-time behind a per-review promise tail; reworks on different
 * reviews overlap freely. The tail mirrors B9's `ReworkQueue` per-key serializer —
 * replicated, not shared (B9's own note: a handful of lines, not worth coupling two
 * clusters), because this write lands an ASK edit, not a board op.
 *
 * The rework posts NOTHING — it stages a revised ask exactly as the reviewer typing
 * would (push ≠ publish; nothing egresses without Rai clicking post).
 */
export function reworkHandlers(rt: DispatchRuntime) {
  const { deps, requireReviewById } = rt;
  // Per-document (per-review) serialization tails. The stored tail swallows rejection
  // so one failed rework never wedges the review; the returned promise carries the real
  // outcome. Same shape as `ReworkQueue.#tails` and `round.dispatch`'s `inFlight`.
  const tails = new Map<string, Promise<unknown>>();

  return {
    "review.reviseSpan": async (rawInput) => {
      const name = "review.reviseSpan" as const;
      const input = parseCommandInput(name, rawInput);
      // Freshness-pin the review once (a stale/unknown id is refused) BEFORE queueing.
      const review = requireReviewById(input.reviewId);
      const key = review.id;
      const prior = tails.get(key) ?? Promise.resolve();
      const run = prior.then(async () => {
        const ask = deps.askLog.readProjection(review.id).stagedAsks[input.askId];
        if (!ask) {
          return { status: "unavailable", reason: "That ask is no longer staged." } as const;
        }
        if (!deps.reworkSpan) {
          return {
            status: "unavailable",
            reason: "Span rework is not available in this build.",
          } as const;
        }
        // The body the rework is based on — the CAS baseline (lost-update guard below).
        const priorBody = ask.body;
        // The one-shot worker: a fresh turn reworking the span. An unavailable/failed
        // turn is answered honestly — never the old body dressed as a rework.
        const result = await deps.reworkSpan({
          review,
          type: ask.type,
          span: input.span,
          instruction: input.instruction,
          // A `path:line` anchor grounds the turn on that file; a prose-span anchor does not.
          ...(/:\d+$/.test(ask.anchor) ? { path: ask.anchor.replace(/:\d+$/, "") } : {}),
        });
        if (result.status === "unavailable" || result.status === "failed") {
          return { status: "unavailable", reason: result.reason } as const;
        }
        if (result.status === "no-change") {
          return { status: "no-change", reason: "The rework produced no change." } as const;
        }
        // LOST-UPDATE GUARD (P1 finding 5). The per-review tail serializes rework-vs-rework,
        // but an ordinary `ask.edit` can land WHILE this one-shot worker is awaited above.
        // Re-read the ask now (synchronously, no further await before the write) and DISCARD
        // the rework if it changed — a stale worker result must never silently overwrite the
        // reviewer's newer edit. This is a compare-and-swap on the ask body (honest failure,
        // not a gate: the newer edit stands, and the caller learns the rework was discarded).
        const current = deps.askLog.readProjection(review.id).stagedAsks[input.askId];
        if (!current) {
          return { status: "unavailable", reason: "That ask is no longer staged." } as const;
        }
        if (current.body !== priorBody) {
          return {
            status: "unavailable",
            reason:
              "The ask changed while the rework was running — discarded so your edit is not overwritten.",
          } as const;
        }
        // SPLICE the refined span back into the FULL body — replace the selected span in
        // place — so revising one sentence never deletes the surrounding prose (finding 5).
        // Function replacer ⇒ the refined text is literal ($-sequences are not interpreted).
        const newBody = current.body.replace(input.span, () => result.refined);
        if (newBody === current.body) {
          return { status: "no-change", reason: "The rework produced no change." } as const;
        }
        // Re-anchor the reworked span across the SPLICED body (fail-closed): the refined text
        // is the span's new home, so match it against the full regenerated body.
        const carriedAnchor = carryQuoteAnchor(result.refined, newBody);
        // Land the spliced body through the SOLE ask writer (append + receipt + R19 push).
        const { receipt } = applyWrite(rt, review.id, {
          kind: "edit",
          id: input.askId,
          body: newBody,
        });
        return {
          status: "reworked",
          carriedAnchor,
          reworkedBody: newBody,
          receipt,
        } as const;
      });
      // Keep the tail rejection-proof; the caller still awaits the real outcome.
      tails.set(
        key,
        run.catch(() => undefined),
      );
      return parseCommandOutput(name, await run);
    },
  } satisfies Record<string, CommandHandler>;
}
