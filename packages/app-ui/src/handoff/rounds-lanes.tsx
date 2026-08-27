import type { Review } from "@rennet/protocol";
import { Badge, cn } from "@rennet/ui";
import { Check, GitBranch, GitPullRequest } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AnchorReveal,
  type CodeRef,
  type DraftHandlers,
  ProseSelectionLayer,
  RichText,
} from "../review";
import type { DispositionKind, StagedAsk } from "../store";
import { useRennetStore } from "../store";
import { HandoffAction } from "./handoff-action";
import { reviseDraftSpan } from "./handoff-data";
import { parseLineAnchor } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The rounds lanes (C08 cluster 5, Objective clause 3, R37) — the own-branch hand-off.
// One goal in two states, and the page's SHAPE states which one you're in (no wrapper, no
// "This Round", no ripening language — law 10):
//
//   • while asks REMAIN → the surface is **Changes**: the ask count beside the heading, one
//     card per staged ask (intent pill, provenance, text, anchor reveal), **Dispatch Round**
//     beneath (inert while nothing is staged), and the pull request a single muted destination
//     line at the foot.
//   • when NOTHING is left to ask and the PR is ready → the surface **IS the pull request**:
//     the title as heading, the drafted description (the `## ` + `**bold**` subset through the
//     same `RichText` pipeline), **Open Pull Request** primary, then a receipt naming the PR
//     number + link.
//   • no asks + an unripe PR → "Nothing staged yet."
//
// Ported from the spike's RoundsLanes, rewritten onto the real `review` slice: the asks are the
// store's `stagedAsks` (not a god-store), steering is C4's `ProseSelectionLayer` (Drop retires +
// unstages, Explain answers with provenance over the slice, Revise reaches the `handoff-data.ts`
// rework seam — execution gated cluster 8). The spike's `applyRevision` string-surgery and
// `StreamingProse` are dropped (Reconciliation 4/5). The reviewer never types into the draft (R32).
//
// The PR draft + egress arrive as props (cluster 6 wires `publish.submitPr`; B11 the durable
// draft): absent them the lane is fully live over the store — every card, Drop, and the Dispatch
// gating are real — it simply cannot become the pull request until a drafted, ready PR is handed in.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_LABEL: Record<DispositionKind, string> = {
  "request-change": "Request Change",
  comment: "Comment",
  question: "Question",
  approve: "Approve",
};

function IntentPill({ type }: { type: DispositionKind }) {
  return (
    <Badge variant={type === "request-change" ? "destructive" : "secondary"} className="shrink-0">
      {INTENT_LABEL[type]}
    </Badge>
  );
}

/** The receipt the egress returns once the own-branch PR opens (number + link). */
export interface PrReceipt {
  readonly number: number;
  readonly url: string;
}

/** The drafted own-branch pull request — the destination the rounds drain toward. */
export interface DraftedPr {
  readonly title: string;
  readonly body: string;
  /** Whether the PR is ready to open (nothing left to ask, the branch pushed). */
  readonly ready: boolean;
}

export interface RoundsLanesProps {
  readonly review: Review;
  /**
   * The drafted own-branch PR. Absent or unripe ⇒ the page stays **Changes** / "Nothing staged
   * yet." (the store-derived draft that becomes the PR body is B11's, gated cluster 8).
   */
  readonly pr?: DraftedPr;
  /** Dispatch a work-order round (the C9 run it navigates to is out of scope). Absent ⇒ a no-op. */
  readonly onDispatch?: () => void;
  /**
   * Open the own-branch PR — resolves `publish.submitPr` on the sign-click (cluster 6). Absent ⇒
   * the Open-PR CTA is present but disabled (honest); nothing another human sees leaves without it.
   */
  readonly onOpenPr?: () => Promise<PrReceipt>;
}

export function RoundsLanes({ review, pr, onDispatch, onOpenPr }: RoundsLanesProps) {
  const patchsetId = review.activePatchsetId;

  // Subscribe to the stable `stagedAsks` map (it changes only on a real mutation) and memoize the
  // derived list — a store selector minting a fresh array each render would trip zustand's
  // snapshot cache into an update loop (the C08 pattern, shared with ask-basket / post-review-lane).
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const { retire, unstageAsk } = useRennetStore((s) => s.reviewActions);
  const asks = useMemo(() => Object.values(stagedAsks), [stagedAsks]);
  const gathering = asks.length > 0;

  const [receipt, setReceipt] = useState<PrReceipt | null>(null);

  // Selection steering matches a quoted span back to its ask (the spike's fuzzy join over the ask
  // text, tolerant of the browser trimming/extending the selection). Same seam as the review draft.
  const findAsk = (quote: string): StagedAsk | undefined =>
    asks.find((ask) => ask.body.includes(quote) || quote.includes(ask.body.slice(0, 40)));

  const draftHandlers: DraftHandlers = {
    onRevise: (quote, instruction) => reviseDraftSpan(quote, instruction),
    onDrop: (quote) => {
      const ask = findAsk(quote);
      if (!ask) return;
      retire(ask, "dropped from the round");
      unstageAsk(ask.anchor);
    },
    explain: (quote) => {
      const ask = findAsk(quote);
      if (ask)
        return `This change comes from “${ask.anchor}” — staged as a ${ask.type.replace("-", " ")}.`;
      return "This is drafted from the staged asks.";
    },
  };

  // ── State: the pull request is the page ──────────────────────────────────────
  if (!gathering && pr?.ready) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-8">
          <div className="flex items-center gap-2.5">
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{pr.title}</h1>
          </div>
          <PrBody body={pr.body} patchsetId={patchsetId} />
          {receipt ? (
            <div className="flex flex-col gap-1 pt-1">
              <span className="flex items-center gap-2 text-base font-medium text-foreground">
                <Check className="size-4 text-green" aria-hidden="true" />
                Pull request opened · #{receipt.number}
              </span>
              <a
                href={receipt.url}
                target="_blank"
                rel="noreferrer"
                className="w-fit text-sm text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              >
                {receipt.url.replace(/^https?:\/\//, "")}
              </a>
            </div>
          ) : (
            <HandoffAction
              label="Open Pull Request"
              pendingLabel="Opening pull request…"
              icon={GitPullRequest}
              onSubmit={
                onOpenPr
                  ? async () => {
                      setReceipt(await onOpenPr());
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>
    );
  }

  // ── State: changes remain (or nothing staged yet) ────────────────────────────
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-8">
        <div className="flex items-center gap-2.5">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Changes</h1>
          {gathering && <span className="text-xs text-muted-foreground">{asks.length}</span>}
        </div>

        {gathering ? (
          <ProseSelectionLayer draftHandlers={draftHandlers}>
            <div className="flex flex-col gap-3">
              {asks.map((ask) => (
                <AskCard key={ask.anchor} ask={ask} patchsetId={patchsetId} />
              ))}
            </div>
          </ProseSelectionLayer>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing staged yet.</p>
        )}

        {/* Dispatch Round: inert while nothing is staged (R37). */}
        <button
          type="button"
          disabled={!gathering}
          onClick={onDispatch}
          className="w-fit rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Dispatch Round
        </button>

        {/* The destination, held quietly until the changes are gone. */}
        {pr && (
          <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-4">
            <GitPullRequest
              className="size-3.5 shrink-0 text-muted-foreground/50"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-xs text-muted-foreground/60">{pr.title}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** One ask card: intent pill, provenance, the ask text, and — for a code anchor — its reveal. */
function AskCard({ ask, patchsetId }: { ask: StagedAsk; patchsetId: string }) {
  const lineAnchor = parseLineAnchor(ask.anchor);
  const codeRef: CodeRef | null = lineAnchor
    ? {
        patchsetId,
        path: lineAnchor.path,
        side: "head",
        startLine: lineAnchor.line,
        endLine: lineAnchor.line,
      }
    : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border px-4 py-3">
      <span className="flex items-center gap-1.5">
        <IntentPill type={ask.type} />
        <span className="truncate text-2xs text-muted-foreground/80 italic">{ask.anchor}</span>
      </span>
      <RichText
        text={ask.body}
        patchsetId={patchsetId}
        paragraphClassName="text-sm leading-relaxed text-foreground/90"
      />
      {codeRef && <AnchorReveal citations={[codeRef]} />}
    </div>
  );
}

/** The PR body's minimal markdown: `## ` headings and `**bold**` spans through `RichText`. */
function PrBody({ body, patchsetId }: { body: string; patchsetId: string }) {
  const blocks = body.split(/\n{2,}/).filter((block) => block.trim().length > 0);
  return (
    <div className="flex flex-col">
      {blocks.map((block, index) => {
        const key = `${index}-${block.slice(0, 16)}`;
        if (block.startsWith("## ")) {
          return (
            <h3
              key={key}
              className={cn("text-sm font-semibold text-foreground", index > 0 && "mt-4")}
            >
              {block.slice(3)}
            </h3>
          );
        }
        return (
          <RichText
            key={key}
            text={block.replace(/\*\*([^*]+)\*\*/g, "$1")}
            patchsetId={patchsetId}
            paragraphClassName={cn(
              "text-sm leading-relaxed text-foreground/85",
              index > 0 && "mt-2",
            )}
          />
        );
      })}
    </div>
  );
}
