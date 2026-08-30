import type { Review } from "@rennet/protocol";
import { Badge } from "@rennet/ui";
import { Check, GitBranch, GitPullRequest, Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { useCoachAnchor } from "../coach/registry";
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
import { type ReviseSpan, reviseDraftSpan } from "./handoff-data";
import { OutboundMarkdown } from "./outbound-markdown";
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
// rework seam, now bound to B11's live `review.reviseSpan`). The spike's `applyRevision`
// string-surgery and `StreamingProse` are dropped (Reconciliation 4/5). Save Edit replaces the
// same durable ask body the work order carries.
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

/** The receipt the egress returns once the own-branch change request opens. */
export interface PrReceipt {
  readonly number: number;
  readonly url: string;
}

/** The drafted own-branch change request — the destination the rounds drain toward. */
export interface DraftedPr {
  /** The forge's name for the outbound change request. */
  readonly requestKind: "pull-request" | "merge-request";
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
  /** The provider-qualified repository and branch range resolved for this exact preview. */
  readonly destination: string;
  /** Whether the change request is ready to open. */
  readonly ready: boolean;
}

type ChangeRequestCopy = {
  readonly opened: string;
  readonly open: string;
  readonly opening: string;
  readonly numberPrefix: string;
};

const CHANGE_REQUEST_COPY = {
  "pull-request": {
    opened: "Pull request opened",
    open: "Open Pull Request",
    opening: "Opening pull request…",
    numberPrefix: "#",
  },
  "merge-request": {
    opened: "Merge request opened",
    open: "Open Merge Request",
    opening: "Opening merge request…",
    numberPrefix: "!",
  },
} satisfies Record<DraftedPr["requestKind"], ChangeRequestCopy>;

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
  /** Why the daemon composed no pull request, in its own words — stated, never a silent absence. */
  readonly unavailable?: string;
  /**
   * Selection-steer Revise, bound to B11's `review.reviseSpan` (cluster 8). Absent ⇒ the Rework
   * control is disabled and the panel says so — never a pretend run.
   */
  readonly onRevise?: ReviseSpan;
}

export function RoundsLanes({
  review,
  pr,
  onDispatch,
  onOpenPr,
  onRevise,
  unavailable,
}: RoundsLanesProps) {
  const patchsetId = review.activePatchsetId;

  // Subscribe to the stable `stagedAsks` map (it changes only on a real mutation) and memoize the
  // derived list — a store selector minting a fresh array each render would trip zustand's
  // snapshot cache into an update loop (the C08 pattern, shared with ask-basket / post-review-lane).
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const { retire, unstageAsk, stageAsk, editAsk } = useRennetStore((s) => s.reviewActions);
  const asks = useMemo(() => Object.values(stagedAsks), [stagedAsks]);
  const gathering = asks.length > 0;

  // The `dispatch` coach mark anchors the Dispatch Round button.
  const dispatchRef = useCoachAnchor("dispatch");

  const [receipt, setReceipt] = useState<PrReceipt | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const startEdit = (ask: StagedAsk): void => {
    setEditingId(ask.id);
    setEditDraft(ask.body);
  };
  const saveEdit = (): void => {
    if (editingId === null) return;
    const body = editDraft.trim();
    if (body.length > 0) editAsk(editingId, body);
    setEditingId(null);
    setEditDraft("");
  };

  // Selection steering matches a quoted span back to its ask (the spike's fuzzy join over the ask
  // text, tolerant of the browser trimming/extending the selection). Same seam as the review draft.
  const findAsk = (quote: string): StagedAsk | undefined =>
    asks.find((ask) => ask.body.includes(quote) || quote.includes(ask.body.slice(0, 40)));

  const draftHandlers: DraftHandlers = {
    // Live span rework: resolve the span back to its ask, then route through the ONE seam.
    onRevise: onRevise
      ? async (quote, instruction) => {
          const ask = findAsk(quote);
          if (!ask) return "That span no longer matches a staged ask.";
          return reviseDraftSpan(onRevise, stageAsk, ask, quote, instruction);
        }
      : undefined,
    onDrop: (quote) => {
      const ask = findAsk(quote);
      if (!ask) return;
      retire(ask, "dropped from the round");
      unstageAsk(ask.id);
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
    const changeRequest = CHANGE_REQUEST_COPY[pr.requestKind];
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-8">
          <div className="flex items-center gap-2.5">
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{pr.title}</h1>
          </div>
          <p className="text-xs text-muted-foreground">
            {pr.base} ← {pr.head} · {pr.draft ? "Draft" : "Ready for review"}
          </p>
          <OutboundMarkdown markdown={pr.body} patchsetId={patchsetId} />
          <p className="text-xs text-muted-foreground">{pr.destination}</p>
          {receipt ? (
            <div className="flex flex-col gap-1 pt-1">
              <span className="flex items-center gap-2 text-base font-medium text-foreground">
                <Check className="size-4 text-green" aria-hidden="true" />
                {changeRequest.opened} · {changeRequest.numberPrefix}
                {receipt.number}
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
              label={changeRequest.open}
              pendingLabel={changeRequest.opening}
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
                <AskCard
                  key={ask.id}
                  ask={ask}
                  patchsetId={patchsetId}
                  editing={editingId === ask.id}
                  editDraft={editDraft}
                  onEditDraft={setEditDraft}
                  onStartEdit={() => startEdit(ask)}
                  onSaveEdit={saveEdit}
                  onCancelEdit={() => setEditingId(null)}
                />
              ))}
            </div>
          </ProseSelectionLayer>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing staged yet.</p>
        )}

        {/* Dispatch Round: inert while nothing is staged (R37), and inert when no round run is
            wired (`onDispatch`) — a live button with no handler would be a dead click that lies.
            The shipping tree DOES wire it (`routes/app.tsx` → `LiveRoundsScope`), so absent
            `onDispatch` means a mount with no rounds source, not a permanently dead exit. */}
        <button
          ref={dispatchRef}
          type="button"
          disabled={!gathering || !onDispatch}
          onClick={onDispatch}
          className="w-fit rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Dispatch Round
        </button>

        {/* The daemon refused to compose the pull request (a detached HEAD, a review that should
            post as a review instead). Without this the lane just never became the PR and said
            nothing about why — a silent dead end, not honest absence. A statement, not a gate. */}
        {unavailable !== undefined && (
          <p className="text-xs text-muted-foreground">{unavailable}</p>
        )}

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
function AskCard({
  ask,
  patchsetId,
  editing,
  editDraft,
  onEditDraft,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  ask: StagedAsk;
  patchsetId: string;
  editing: boolean;
  editDraft: string;
  onEditDraft: (value: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  const lineAnchor = parseLineAnchor(ask.anchor);
  const codeRef: CodeRef | null =
    ask.codeRef ??
    (lineAnchor
      ? {
          patchsetId,
          path: lineAnchor.path,
          side: ask.side === "LEFT" ? "base" : "head",
          startLine: lineAnchor.line,
          endLine: lineAnchor.line,
        }
      : null);
  return (
    <div className="group flex flex-col gap-1.5 rounded-md border border-border px-4 py-3">
      <span className="flex items-center gap-1.5">
        <IntentPill type={ask.type} />
        <span className="truncate text-2xs text-muted-foreground/80 italic">{ask.anchor}</span>
        {!editing && (
          <button
            type="button"
            onClick={onStartEdit}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Pencil className="size-3" aria-hidden="true" />
            Edit
          </button>
        )}
      </span>
      {editing ? (
        <>
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the editor opens on an explicit Edit click.
            autoFocus
            value={editDraft}
            onChange={(event) => onEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSaveEdit();
              }
              if (event.key === "Escape") onCancelEdit();
            }}
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-sm leading-relaxed text-foreground focus-visible:border-ring focus-visible:outline-none"
          />
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={onCancelEdit}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSaveEdit}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <RichText
          text={ask.body}
          patchsetId={patchsetId}
          paragraphClassName="text-sm leading-relaxed text-foreground/90"
        />
      )}
      {codeRef && <AnchorReveal citations={[codeRef]} />}
    </div>
  );
}
