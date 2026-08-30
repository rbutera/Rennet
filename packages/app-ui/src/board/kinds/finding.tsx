import { Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon";
import { useFlightBatcher } from "../../handoff/exit-flight";
import { AnchorReveal, useAnchoredAsk } from "../../review";
import { useRennetStore } from "../../store";
import { findingLifecycle } from "../finding-lifecycle";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
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

function Concurrence({
  tallies,
}: {
  readonly tallies: readonly { model: string; agree: number; total: number }[];
}) {
  if (tallies.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
      {tallies.map((t) => (
        <span key={t.model} title={`${t.model}: ${t.agree} of ${t.total} agree`}>
          {t.model} {t.agree}/{t.total}
        </span>
      ))}
    </span>
  );
}

export function FindingElement({ element }: { readonly element: ElementOf<"finding"> }) {
  const { severity, concern, status: boardStatus, code, concurrence } = element.data;
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
  const [open, setOpen] = useState(status === "open");
  const dimmed = status === "dismissed" || status === "addressed";

  useEffect(() => {
    setOpen(status === "open");
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
          <Concurrence tallies={concurrence} />
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
          {citations.length > 0 && <AnchorReveal citations={citations} />}
        </div>
      </Collapse>
    </div>
  );
}
