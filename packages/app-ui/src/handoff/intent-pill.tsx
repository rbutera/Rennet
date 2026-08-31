import { cn } from "@rennet/ui";
import type { DispositionKind } from "../store";

// The intent micro-cap, shared by both hand-off lanes (`rounds-lanes`, `post-review-lane`).
// It was written twice, identically, and the reason it must stay identical is the reason it
// is now written once: a soft COPPER fill for a change request, neutral for the rest, and no
// danger red — an ask is not an error (prototype `rounds-lanes.tsx:160-168`). Red here would
// also have put a red tag beside the copper warn verdict dot inside the post-review lane.

const INTENT_LABEL: Record<DispositionKind, string> = {
  "request-change": "Request Change",
  comment: "Comment",
  question: "Question",
  approve: "Approve",
};

export function IntentPill({ type }: { type: DispositionKind }) {
  return (
    <span
      data-kind="intent"
      data-intent={type}
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-semibold text-10 uppercase tracking-wide",
        type === "request-change" ? "bg-warn-soft text-warn" : "bg-secondary text-muted-foreground",
      )}
    >
      {INTENT_LABEL[type]}
    </span>
  );
}
