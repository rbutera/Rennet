import type { FindingAccord } from "@rennet/protocol";
import { Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon";
import { useFlightBatcher } from "../../handoff/exit-flight";
import { useAnchoredAsk } from "../../review";
import { useRennetStore } from "../../store";
import { findingLifecycle } from "../finding-lifecycle";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { BoardAnchorReveal } from "./board-anchor-reveal";
import { useBoardGeneration, useBoardId, useBoardPatchsetId, useCodeRefs } from "./element-context";

// `finding` (C05 3.3) — a raised review finding. Folds to its first line (findings
// carry no title field, only `concern` markdown); a severity chip and the per-model
// concurrence tally stay visible folded. A durable reviewer disposition overlays the
// frozen board status without changing its bytes. The inline `**Fix:**` is lifted into
// a callout when present; every finding keeps its actions even without that optional marker.

const SEVERITY_CHIP: Record<"high" | "medium" | "low", string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-warn-soft text-warn",
  low: "bg-secondary text-muted-foreground",
};

/** Split the concern markdown into its body and the optional lifted `**Fix:**`. */
function splitFix(concern: string): { body: string; fix: string | null } {
  const [body = concern, ...rest] = concern.split(/\*\*Fix:\*\*/);
  if (rest.length === 0) return { body: concern.trim(), fix: null };
  return { body: body.trim(), fix: rest.join("**Fix:**").trim() };
}

/** What the pill can actually claim, once the tallies AND the accord stamp are in. */
type ConcurrenceRead = "concur" | "split" | "conflict" | "solo" | "unstamped";

const CONCURRENCE_TONE: Record<ConcurrenceRead, string> = {
  // Every seat raised it, at comparable severity — the one green claim.
  concur: "border-green-line text-green",
  // A real disagreement between seats: the verdigris model register.
  split: "border-model-line text-model",
  conflict: "border-model-line text-model",
  // Nothing to compare (one seat) or nothing verifiable (no stamp): state it, quietly.
  solo: "border-border text-muted-foreground",
  unstamped: "border-border text-muted-foreground",
};

/**
 * The cross-model concurrence read, as ONE bordered tinted pill (prototype
 * `lens-board.tsx:503-516`) rather than a row of plain per-model counts.
 *
 * **The tallies alone cannot answer the question this pill asks.** `foldConcurrence`
 * (`server/runtime/lens-pipeline.ts:226-241`) stamps `[{a,1,1},{b,1,1}]` for a concurring
 * pair — and for a severity CONFLICT, where both seats raised the finding at materially
 * different severities and neither answered "no concern" (`core/finding-reconcile.ts`,
 * the conflict arm of `reconcileFindings`). Byte-identical. Reading `sum(agree) ===
 * sum(total)` as agreement therefore printed a green "concur 2/2" over a disagreement.
 *
 * So the pipeline also stamps `accord`, and the green concurrence claim is made ONLY on
 * `accord === "concur"`. The other reads:
 *
 * - `conflict` — both raised it, incompatible severities. Named, in the model register.
 * - `split` — one seat raised it, another answered "no concern" (`agree: 0`). Names who did.
 * - `solo` — ONE tally, the single-harness degrade (`stampSingleSeatConcurrence`, `:398-410`).
 *   No second opinion exists, so there is no split to report: it reads as the seat, muted.
 * - `unstamped` — a board drafted before `accord`, whose tallies are the ambiguous pair.
 *   It may be either, so it states the tally and claims nothing. Never green.
 */
function Concurrence({
  tallies,
  accord,
}: {
  readonly tallies: readonly { model: string; agree: number; total: number }[];
  readonly accord: FindingAccord | undefined;
}) {
  if (tallies.length === 0) return null;
  const agree = tallies.reduce((sum, t) => sum + t.agree, 0);
  const total = tallies.reduce((sum, t) => sum + t.total, 0);
  const raisers = tallies.filter((t) => t.agree > 0).map((t) => t.model);
  const detail = tallies.map((t) => `${t.model}: ${t.agree} of ${t.total} agree`).join(", ");
  // Absent accord: a partial tally is unambiguously a split (a seat said no concern), but a
  // FULL one is exactly the pair a conflict produces — so it degrades, it does not guess.
  const read: ConcurrenceRead =
    tallies.length === 1 ? "solo" : (accord ?? (agree === total ? "unstamped" : "split"));
  const label =
    read === "solo"
      ? (tallies[0]?.model ?? "")
      : read === "concur"
        ? `concur ${agree}/${total}`
        : read === "conflict"
          ? "severity split"
          : read === "split" && raisers.length > 0
            ? `${raisers.join(" · ")} only`
            : `${agree}/${total} flagged`;
  return (
    <span
      data-kind="finding-concurrence"
      data-accord={read}
      data-concur={read === "concur"}
      className={cn("shrink-0 rounded border px-1.5 py-0.5 text-10", CONCURRENCE_TONE[read])}
      title={detail}
    >
      {label}
    </span>
  );
}

export function FindingElement({ element }: { readonly element: ElementOf<"finding"> }) {
  const { severity, concern, status: boardStatus, code, concurrence, accord } = element.data;
  const generation = useBoardGeneration();
  const boardId = useBoardId();
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(code);
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const findingDispositions = useRennetStore((s) => s.review.findingDispositions);
  const { addQuoteComment, dismissFinding, restoreFinding, stageAsk, unstageAsk } = useRennetStore(
    (s) => s.reviewActions,
  );
  const focusChatComposer = useRennetStore((s) => s.uiActions.focusChatComposer);
  const sendAnchoredAsk = useAnchoredAsk();
  const flight = useFlightBatcher();

  const { body, fix } = splitFix(concern);
  const actionText = fix ?? body;
  const summary = body.split("\n")[0];
  const lifecycle = findingLifecycle(element, generation, boardId, {
    stagedAsks,
    findingDispositions,
  });
  const { askId, dismissedByReviewer, ref, requested: staged, status } = lifecycle;
  // Folded on arrival like every other foldable (Rai, 2026-09-04): the reader reads the
  // claim lines first. Leaving `open` therefore COLLAPSES — dismissing or addressing a
  // finding rolls it up — but returning to `open` never forces it back out, because that
  // would reopen a card the reader had deliberately folded.
  const [open, setOpen] = useState(false);
  const dimmed = status === "dismissed" || status === "addressed";

  useEffect(() => {
    if (status !== "open") setOpen(false);
  }, [status]);

  // The ask's source anchor is the finding's first cited position, mirroring C4's
  // `path:line` anchor convention; with no citation it falls back to the element id.
  const firstCitation = citations[0];
  const anchor = firstCitation ? `${firstCitation.path}:${firstCitation.startLine}` : element.id;
  function toggleDismissal() {
    if (dismissedByReviewer) {
      restoreFinding(ref);
      return;
    }
    dismissFinding(ref);
    setOpen(false);
  }

  function discussFinding() {
    const question = fix === null ? "Discuss this finding." : "Discuss this fix.";
    const threadId = addQuoteComment(actionText, question, "explain", {
      target: element.id,
      generation,
    });
    focusChatComposer();
    void sendAnchoredAsk?.({
      threadId,
      question,
      excerpt: actionText,
      target: element.id,
      generation,
    });
  }

  return (
    <div
      data-kind="finding"
      data-status={status}
      data-element-id={element.id}
      className={cn("transition-opacity", dimmed && "opacity-50")}
    >
      <h3 className="contents">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-start gap-2 text-left"
        >
          <Icon
            icon={ChevronDown}
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-semibold text-2xs uppercase tracking-wide",
              SEVERITY_CHIP[severity],
            )}
          >
            {severity}
          </span>
          <span className="min-w-0 flex-1 font-semibold text-base text-foreground leading-snug">
            {summary}
            {status !== "open" && <span className="sr-only">, {status}</span>}
          </span>
          <Concurrence tallies={concurrence} accord={accord} />
        </button>
      </h3>
      <Collapse open={open}>
        <div className="flex flex-col gap-2 pt-1 pl-5">
          <QuoteHighlightLayer
            text={body}
            elementId={element.id}
            patchsetId={patchsetId}
            paragraphClassName="text-foreground/90 text-sm leading-relaxed"
          />
          <div
            className={cn(
              "flex flex-col gap-1.5",
              fix && "mt-1 rounded-md border border-border bg-secondary/30 px-3 py-2.5",
            )}
          >
            {fix ? (
              <>
                <h4 className="font-medium text-2xs text-muted-foreground uppercase tracking-wide">
                  Fix
                </h4>
                <QuoteHighlightLayer
                  text={fix}
                  elementId={element.id}
                  patchsetId={patchsetId}
                  paragraphClassName="text-foreground/90 text-sm leading-relaxed"
                />
              </>
            ) : null}
            <div className="flex items-center justify-end gap-1.5 pt-0.5">
              {boardStatus === "open" && (!staged || dismissedByReviewer) ? (
                <button
                  type="button"
                  onClick={toggleDismissal}
                  className="rounded border border-border px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {dismissedByReviewer ? "Dismissed · Undo" : "Dismiss"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={discussFinding}
                className="rounded border border-border px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Discuss
              </button>
              {boardStatus === "open" && (!dismissedByReviewer || staged) ? (
                <button
                  type="button"
                  onClick={() => {
                    if (staged) {
                      unstageAsk(askId);
                      return;
                    }
                    stageAsk({
                      id: askId,
                      anchor,
                      type: "request-change",
                      body: actionText,
                      finding: ref,
                      ...(firstCitation === undefined
                        ? {}
                        : {
                            side: firstCitation.side === "base" ? "LEFT" : "RIGHT",
                            codeRef: firstCitation,
                          }),
                    });
                    flight.signal();
                  }}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs transition-colors",
                    staged
                      ? "border border-border bg-secondary/60 text-muted-foreground"
                      : "bg-foreground font-medium text-background hover:bg-foreground/90",
                  )}
                >
                  {staged ? "Staged · Request Change" : "Request This Change"}
                </button>
              ) : null}
            </div>
          </div>
          {citations.length > 0 && <BoardAnchorReveal citations={citations} />}
        </div>
      </Collapse>
    </div>
  );
}
