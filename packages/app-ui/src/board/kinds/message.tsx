import { cn } from "@rennet/ui";
import { AnchorReveal } from "../../review";
import type { ElementOf } from "../registry";
import { useCodeRefOf } from "./element-context";

// `message` (C05 3.5) — the conversational / ask kind. Surfaces the `role`, the ask
// `lifecycle` (a `detached` message is read DISTINCTLY and never dropped, #462 R34),
// the quoted span it replies to (`quote_target`/`quote`, surfaced here for cluster 5's
// durable highlight), and any cited `code_ref` anchor. The exchange TEXT lives
// transcript-side (the `review` slice, Reconciliation 5) — cluster 5 renders the
// thread; here the board element carries only its anchors and lifecycle.

const ROLE_LABEL: Record<ElementOf<"message">["data"]["role"], string> = {
  finding: "Finding",
  question: "Question",
  discuss: "Discuss",
  "request-change": "Request change",
};

export function MessageElement({ element }: { readonly element: ElementOf<"message"> }) {
  const { role, code_ref, quote, lifecycle } = element.data;
  const ref = useCodeRefOf(code_ref);
  const detached = lifecycle === "detached";
  return (
    <div
      data-kind="message"
      data-role={role}
      data-lifecycle={lifecycle ?? "none"}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-3 py-2",
        detached ? "border-dashed border-border opacity-70" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-2xs text-secondary-foreground uppercase tracking-wide">
          {ROLE_LABEL[role]}
        </span>
        {lifecycle && (
          <span
            className={cn(
              "text-2xs",
              detached ? "font-medium text-danger" : "text-muted-foreground",
            )}
          >
            {lifecycle}
          </span>
        )}
      </div>
      {quote && (
        <blockquote className="border-primary/50 border-l-2 pl-2 text-foreground/80 text-sm italic">
          {quote.quote}
        </blockquote>
      )}
      {ref && <AnchorReveal citations={[ref]} />}
    </div>
  );
}
