import { Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../components/icon";
import { AnchorReveal, RichText } from "../../review";
import { useRennetStore } from "../../store";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs } from "./element-context";

// `finding` (C05 3.3) — a raised review finding. Folds to its first line (findings
// carry no title field, only `concern` markdown); a severity chip and the per-model
// concurrence tally stay visible folded. `status` dims a dismissed/addressed finding.
// The inline `**Fix:**` is lifted into an actionable callout whose button stages a
// request-change ask against the finding's first cited position — reading and writing
// the REAL `review` slice (no `store?.` shim, autopsy S3).

const SEVERITY_CHIP: Record<"high" | "medium" | "low", string> = {
  high: "bg-danger-soft text-danger",
  medium: "bg-primary/15 text-primary",
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
  const { severity, concern, status, code, concurrence } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(code);
  const [open, setOpen] = useState(status === "open");
  const { stageAsk, unstageAsk } = useRennetStore((s) => s.reviewActions);

  const { body, fix } = splitFix(concern);
  const summary = body.split("\n")[0];
  const dimmed = status === "dismissed" || status === "addressed";

  // The ask's source anchor is the finding's first cited position, mirroring C4's
  // `path:line` anchor convention; with no citation it falls back to the element id.
  const anchor = citations[0] ? `${citations[0].path}:${citations[0].startLine}` : element.id;
  const staged = useRennetStore((s) => Boolean(s.review.stagedAsks[anchor]));

  return (
    <div data-kind="finding" data-status={status} className={cn(dimmed && "opacity-60")}>
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
        <span className="min-w-0 flex-1 font-semibold text-foreground text-sm leading-snug">
          {summary}
          {status !== "open" && <span className="sr-only">, {status}</span>}
        </span>
        <Concurrence tallies={concurrence} />
      </button>
      <Collapse open={open}>
        <div className="flex flex-col gap-2 pt-1 pl-5">
          <RichText
            text={body}
            patchsetId={patchsetId}
            paragraphClassName="text-foreground/90 text-sm leading-relaxed"
          />
          {fix && (
            <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
              <span className="font-medium text-2xs text-muted-foreground uppercase tracking-wide">
                Fix
              </span>
              <RichText
                text={fix}
                patchsetId={patchsetId}
                paragraphClassName="text-foreground/90 text-sm leading-relaxed"
              />
              <div className="flex justify-end pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    staged
                      ? unstageAsk(anchor)
                      : stageAsk({ anchor, type: "request-change", body: fix })
                  }
                  className={cn(
                    "rounded px-2.5 py-1 text-xs transition-colors",
                    staged
                      ? "border border-border bg-secondary/60 text-muted-foreground"
                      : "bg-foreground font-medium text-background hover:bg-foreground/90",
                  )}
                >
                  {staged ? "Staged · Request Change" : "Request This Change"}
                </button>
              </div>
            </div>
          )}
          {citations.length > 0 && <AnchorReveal citations={citations} />}
        </div>
      </Collapse>
    </div>
  );
}
