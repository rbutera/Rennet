import type { HostElement } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { Check, CircleDashed, Minus, Sparkles } from "lucide-react";
import { Icon } from "../../components/icon";
import { AnchorReveal } from "../../review";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import { useBoardPatchsetId, useCodeRefOf } from "./element-context";

// `round_outcome` (C09 2.1) — one item of a round report (#486 R57/R58): how a
// dispatched ask fared this round. It is the ONE kind excluded from every LENS board
// (`BOARD_EXCLUDED_KINDS`), so it renders ONLY on the round-report surface, through the
// report registry (`rounds/report-registry.ts`) — never on a lens board. Shape mirrors
// the sibling `board/kinds/` renderers: a status pill with its tint, the ask reference,
// the note through C4's `RichText`, and the optional `code_ref` through `AnchorReveal`.

type RoundOutcome = Extract<HostElement, { kind: "round_outcome" }>;
type OutcomeStatus = "addressed" | "partial" | "untouched" | "beyond";

/** One glyph + one tint per status, no fill: the four outcomes read apart by icon and
 *  colour the way the prototype's report does (`round-report.tsx:10-15`). Gold is the
 *  reserve accent, so addressed takes evidence green; partial the copper warn; untouched
 *  stays muted (nothing happened); beyond takes the verdigris model hue. */
const STATUS_MARK: Record<OutcomeStatus, { readonly icon: typeof Check; readonly tint: string }> = {
  addressed: { icon: Check, tint: "text-green" },
  partial: { icon: CircleDashed, tint: "text-warn" },
  untouched: { icon: Minus, tint: "text-muted-foreground" },
  beyond: { icon: Sparkles, tint: "text-model" },
};

export function RoundOutcomeElement({ element }: { readonly element: RoundOutcome }) {
  const { status, ask, note, code_ref } = element.data;
  const patchsetId = useBoardPatchsetId();
  const ref = useCodeRefOf(code_ref);
  const mark = STATUS_MARK[status as OutcomeStatus];
  return (
    <div
      data-kind="round_outcome"
      data-status={status}
      data-element-id={element.id}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-baseline gap-2">
        <Icon icon={mark.icon} className={cn("size-3.5 shrink-0 self-center", mark.tint)} />
        <span className={cn("shrink-0 font-semibold text-2xs uppercase tracking-wide", mark.tint)}>
          {status}
        </span>
        <span className="min-w-0 flex-1 font-medium text-foreground text-sm leading-snug">
          <InlineQuoteHighlight text={ask.text} elementId={element.id} />
        </span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{ask.ref}</span>
      </div>
      <QuoteHighlightLayer
        text={note}
        elementId={element.id}
        patchsetId={patchsetId}
        paragraphClassName="text-foreground/90 text-sm leading-relaxed"
      />
      {ref && <AnchorReveal citations={[ref]} />}
    </div>
  );
}
