import { cn } from "@rennet/ui";
import { RichText } from "../../review";
import { useRennetStore } from "../../store";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefOf } from "./element-context";

// `noise_verdict` (C05 3.6) — a per-hunk noise/signal verdict, judged by `llm` or a
// `deterministic` rule (nothing dropped, #462). A `noise` verdict reads dimmed; the
// reason renders as markdown. The "Not noise" affordance lets the reviewer disagree —
// it stages a comment ask against the hunk's cited position on the REAL `review`
// slice, so a rescued hunk enters the same staged set every other exit uses.

export function NoiseVerdictElement({ element }: { readonly element: ElementOf<"noise_verdict"> }) {
  const { hunk, verdict, reason, judge } = element.data;
  const patchsetId = useBoardPatchsetId();
  const ref = useCodeRefOf(hunk);
  const { stageAsk, unstageAsk } = useRennetStore((s) => s.reviewActions);
  const anchor = ref ? `${ref.path}:${ref.startLine}` : element.id;
  const staged = useRennetStore((s) => Boolean(s.review.stagedAsks[anchor]));
  const noise = verdict === "noise";
  return (
    <div
      data-kind="noise_verdict"
      data-verdict={verdict}
      className={cn("flex flex-col gap-1.5", noise && "opacity-70")}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium text-2xs uppercase tracking-wide",
            noise ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary",
          )}
        >
          {verdict}
        </span>
        <span className="text-2xs text-muted-foreground">{judge}</span>
        <button
          type="button"
          onClick={() =>
            staged
              ? unstageAsk(anchor)
              : stageAsk({ anchor, type: "comment", body: `not noise: ${reason}` })
          }
          className="ml-auto rounded border border-border px-2 py-0.5 text-muted-foreground text-xs hover:bg-secondary hover:text-foreground"
        >
          {staged ? "Staged · Not noise" : "Not noise"}
        </button>
      </div>
      <RichText
        text={reason}
        patchsetId={patchsetId}
        paragraphClassName="text-foreground/85 text-sm leading-relaxed"
      />
    </div>
  );
}
