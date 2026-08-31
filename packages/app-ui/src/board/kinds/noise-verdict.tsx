import { cn } from "@rennet/ui";
import { Sparkles } from "lucide-react";
import { Icon } from "../../components/icon";
import { useFlightBatcher } from "../../handoff/exit-flight";
import { useRennetStore } from "../../store";
import { QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefOf } from "./element-context";

// `noise_verdict` (C05 3.6) — a per-hunk noise/signal verdict, judged by `llm` or a
// `deterministic` rule (nothing dropped, #462). A `noise` verdict reads dimmed; the
// reason renders as markdown. The "Not noise" affordance lets the reviewer disagree —
// it stages a comment ask against the hunk's cited position on the REAL `review`
// slice, so a rescued hunk enters the same staged set every other exit uses.
//
// The card shape is the prototype's noise group (`lens-board.tsx:469-501`): a bordered
// container, a `border-b` header carrying the hunk's identity, the judge chip and the
// disagree control, and the reason beneath. The prototype's card covered a GROUP of
// hunks sharing one verdict; the wire has no grouping to bind to — `noiseVerdictData`
// (`protocol/src/board/schema.ts:177-182`) is `{hunk, verdict, reason, judge}` with no
// group id, label or shared reason, and C05's Reconciliation 4 already re-ruled the
// spike's `noise-group` composite into per-hunk `noise_verdict` elements. So the card
// is per hunk, and the header's label is the hunk's own path. Inventing a grouping key
// would mean inventing the label and reason that go with it.
export function NoiseVerdictElement({ element }: { readonly element: ElementOf<"noise_verdict"> }) {
  const { hunk, verdict, reason, judge } = element.data;
  const patchsetId = useBoardPatchsetId();
  const ref = useCodeRefOf(hunk);
  const { stageAsk, unstageAsk } = useRennetStore((s) => s.reviewActions);
  const flight = useFlightBatcher();
  const anchor = ref ? `${ref.path}:${ref.startLine}` : element.id;
  // Identity is the element id (stable, unique per hunk verdict) so the toggle is idempotent.
  const askId = element.id;
  const staged = useRennetStore((s) => Boolean(s.review.stagedAsks[askId]));
  const noise = verdict === "noise";
  const modelJudged = judge === "llm";
  return (
    <div
      data-kind="noise_verdict"
      data-verdict={verdict}
      data-element-id={element.id}
      // The dim is ONE opacity on the card, so a set-aside hunk fades as a unit.
      className={cn("rounded-md border border-border", noise && "opacity-50")}
    >
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <h3 className="min-w-0 truncate font-mono text-12-5 text-foreground">
          {ref?.path ?? hunk}
        </h3>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-10 uppercase tracking-wide",
            noise ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary",
          )}
        >
          {verdict}
        </span>
        <span
          data-kind="noise-judge"
          className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-10 text-muted-foreground"
        >
          {modelJudged && <Icon icon={Sparkles} className="size-2.5" />}
          {modelJudged ? "model judged" : "rule"}
        </span>
        <button
          type="button"
          onClick={() => {
            if (staged) {
              unstageAsk(askId);
              return;
            }
            stageAsk({ id: askId, anchor, type: "comment", body: `not noise: ${reason}` });
            flight.signal(); // a real staging act flies one bubble to the FAB (never unstage)
          }}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {staged ? "Staged · Not noise" : "Not noise"}
        </button>
      </div>
      <div className="px-3 py-2.5">
        <QuoteHighlightLayer
          text={reason}
          elementId={element.id}
          patchsetId={patchsetId}
          paragraphClassName="text-12-5 text-muted-foreground leading-relaxed"
        />
      </div>
    </div>
  );
}
