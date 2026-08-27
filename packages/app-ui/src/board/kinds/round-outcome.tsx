import type { HostElement } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { AnchorReveal, RichText } from "../../review";
import { useBoardPatchsetId, useCodeRefOf } from "./element-context";

// `round_outcome` (C09 2.1) — one item of a round report (#486 R57/R58): how a
// dispatched ask fared this round. It is the ONE kind excluded from every LENS board
// (`BOARD_EXCLUDED_KINDS`), so it renders ONLY on the round-report surface, through the
// report registry (`rounds/report-registry.ts`) — never on a lens board. Shape mirrors
// the sibling `board/kinds/` renderers: a status pill with its tint, the ask reference,
// the note through C4's `RichText`, and the optional `code_ref` through `AnchorReveal`.

type RoundOutcome = Extract<HostElement, { kind: "round_outcome" }>;
type OutcomeStatus = "addressed" | "partial" | "untouched" | "beyond";

/** One tint per status — addressed reads resolved (gold), untouched wants attention,
 *  partial and beyond each take a distinct neutral/accent so all four are legible apart. */
const STATUS_PILL: Record<OutcomeStatus, string> = {
  addressed: "bg-primary/15 text-primary",
  partial: "bg-accent-soft text-accent-ink",
  untouched: "bg-danger-soft text-danger",
  beyond: "bg-secondary text-secondary-foreground",
};

export function RoundOutcomeElement({ element }: { readonly element: RoundOutcome }) {
  const { status, ask, note, code_ref } = element.data;
  const patchsetId = useBoardPatchsetId();
  const ref = useCodeRefOf(code_ref);
  return (
    <div
      data-kind="round_outcome"
      data-status={status}
      data-element-id={element.id}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-semibold text-2xs uppercase tracking-wide",
            STATUS_PILL[status as OutcomeStatus],
          )}
        >
          {status}
        </span>
        <span className="min-w-0 flex-1 font-medium text-foreground text-sm leading-snug">
          {ask.text}
        </span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{ask.ref}</span>
      </div>
      <RichText
        text={note}
        patchsetId={patchsetId}
        paragraphClassName="text-foreground/90 text-sm leading-relaxed"
      />
      {ref && <AnchorReveal citations={[ref]} />}
    </div>
  );
}
