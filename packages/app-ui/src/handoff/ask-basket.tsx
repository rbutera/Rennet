import { Badge, Button, cn } from "@rennet/ui";
import { X } from "lucide-react";
import { useMemo } from "react";
import {
  type DispositionKind,
  type StagedAsk,
  stagedAskCodePosition,
  useRennetStore,
} from "../store";
import { partitionAsksByAnchor } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The ask basket (C08 cluster 3, Objective clause 2, R29) — the staged asks the review
// has gathered, each an intent + body + provenance, split into the review-body stratum and
// the code line-comment stratum by PLACEMENT alone (selectBodyVsLineAsks, R36) — no chrome
// copy explains the split, the two blocks ARE the statement.
//
// Findings never auto-stage: staging is always an act. The basket does not stage — it renders the
// staged set and gives every ask its own undo (`unstageAsk`). So no flight launch fires here (the
// pip is derived; the flight rides a staging GESTURE, which the basket does not own). The
// `useFlightBatcher().signal()` calls live at the real staging sites that own the gesture: the
// board finding renderer (`board/kinds/finding.tsx`), the noise-verdict "Not noise"
// (`board/kinds/noise-verdict.tsx`), the diff and code-block line editors' request-change
// (`review/diff-view.tsx`, `review/code-block.tsx`), and the quote toolbar's request-change
// (`review/selection-toolbar.tsx`) — each firing the act then one signal, never on unstage.
// ─────────────────────────────────────────────────────────────────────────────

/** The intent tag vocabulary — a label + a Badge variant per disposition kind. */
const INTENT: Record<DispositionKind, { label: string; variant: "destructive" | "secondary" }> = {
  "request-change": { label: "Request Change", variant: "destructive" },
  comment: { label: "Comment", variant: "secondary" },
  question: { label: "Question", variant: "secondary" },
  approve: { label: "Approve", variant: "secondary" },
};

function AskRow({ ask }: { ask: StagedAsk }) {
  const unstageAsk = useRennetStore((s) => s.reviewActions.unstageAsk);
  const intent = INTENT[ask.type];
  const lineAnchor = stagedAskCodePosition(ask);

  return (
    <li className="flex items-start gap-3 rounded-md border border-border/60 bg-card px-3 py-2">
      <Badge variant={intent.variant} className="mt-0.5 shrink-0">
        {intent.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{ask.body}</p>
        {lineAnchor ? (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {lineAnchor.path}:{lineAnchor.line}
          </p>
        ) : (
          <p className="mt-1 truncate text-xs text-muted-foreground italic">“{ask.anchor}”</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Unstage ${intent.label.toLowerCase()}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => unstageAsk(ask.id)}
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

export interface AskBasketProps {
  readonly className?: string;
}

/**
 * The staged-ask basket: the review-body asks above, the code line-comment asks below, each
 * with its own unstage receipt. Placement carries the routing (R36) — no explanatory copy.
 */
export function AskBasket({ className }: AskBasketProps) {
  // Subscribe to the stable `stagedAsks` map (it changes only on a real mutation) and memoize
  // the partition — a store selector returning `{ body, line }` would mint a fresh object each
  // render and trip zustand's snapshot cache into an update loop.
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const { body, line } = useMemo(() => partitionAsksByAnchor(stagedAsks), [stagedAsks]);

  if (body.length === 0 && line.length === 0) {
    return (
      <p className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}>
        No asks staged.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {body.length > 0 && (
        <ul className="flex flex-col gap-2">
          {body.map((ask) => (
            <AskRow key={ask.id} ask={ask} />
          ))}
        </ul>
      )}
      {line.length > 0 && (
        <ul className="flex flex-col gap-2">
          {line.map((ask) => (
            <AskRow key={ask.id} ask={ask} />
          ))}
        </ul>
      )}
    </div>
  );
}
