import type { Review } from "@rennet/protocol";
import { Badge, cn, Toggle, ToggleGroup } from "@rennet/ui";
import { Check, GitPullRequest, Pencil, RotateCcw, Trash2 } from "lucide-react";
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
import { composeLivingDraft, type LineComment, reviseDraftSpan } from "./handoff-data";
import { type ProposedVerdict, verdictArithmeticFromAsks } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The Post Review lane (C08 cluster 4, Objective clauses 4/5, teammate-PR mode). Ported from
// the spike's PostReviewLane, rewritten onto the real `review` slice + C08 selectors:
//
//   • the VERDICT is proposed (never derived-and-locked, R33): `verdictArithmeticFromAsks`
//     proposes, the control states its arithmetic beside it, and it is always flippable — an
//     override says so and offers "use proposal" to revert (`setVerdictOverride(null)`).
//   • the LIVING DRAFT renders in GitHub's two-strata shape: a sans-face body (one block per
//     body ask) then line-comment cards grouped by file path — `composeLivingDraft` owns the
//     routing (R36), placement is the statement, no chrome copy explains the split.
//   • steering is by SELECTION (R32): the body mounts inside C4's `ProseSelectionLayer` with
//     Drop (retire + unstage, real) / Explain (provenance over the slice, raises no exit) /
//     Revise (reaches the `handoff-data.ts` rework seam — the affordance renders, execution is
//     gated, cluster 8). The reviewer never types into the draft.
//   • RECEIPT-IS-UNDO: every drop/retire/delete/edit/verdict change reads back reversible from
//     the store; only the final sign-click (`onSubmit`) is irreversible. The draft above IS the
//     preview — no separate preview stage (R31).
//
// The spike's synthetic `openerFor()` prose is DROPPED (fabricated demo text): the composed
// opening is B11's living draft (gated cluster 8). Today the body is the staged body asks.
// The egress (`publish.compose` → `publish.review`) is cluster 6's wiring — the lane takes it
// as `onPost`; absent, the CTA renders disabled (honest), never a Post that posts nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** The three real GitHub review events, with their segmented-control presentation. */
const VERDICTS: readonly { value: ProposedVerdict; label: string; dot: string }[] = [
  { value: "APPROVE", label: "Approve", dot: "bg-green" },
  { value: "REQUEST_CHANGES", label: "Request Changes", dot: "bg-destructive" },
  { value: "COMMENT", label: "Comment", dot: "bg-muted-foreground/50" },
];

const VERDICT_LABEL: Record<ProposedVerdict, string> = {
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request Changes",
  COMMENT: "Comment",
};

function IntentTag({ type }: { type: DispositionKind }) {
  const requestChange = type === "request-change";
  return (
    <Badge variant={requestChange ? "destructive" : "secondary"} className="shrink-0">
      {requestChange ? "Request Change" : "Comment"}
    </Badge>
  );
}

/** The receipt the egress returns once the review posts (verdict + line-comment count + link). */
export interface PostReceipt {
  readonly verdict: ProposedVerdict;
  readonly lineCommentCount: number;
  readonly url: string;
}

export interface PostReviewLaneProps {
  readonly review: Review;
  /**
   * The egress — resolves `publish.compose` → `publish.review` on the sign-click (cluster 6).
   * Absent ⇒ the Post CTA is present but disabled (no egress wired); the lane is otherwise fully
   * live over the store, so every drop/edit/retire/restore is real without it.
   */
  readonly onPost?: (args: { verdict: ProposedVerdict }) => Promise<PostReceipt>;
}

export function PostReviewLane({ review, onPost }: PostReviewLaneProps) {
  const patchsetId = review.activePatchsetId;
  const postTarget = review.postTarget;
  const prRef = postTarget
    ? `${postTarget.repo.owner}/${postTarget.repo.name}#${postTarget.number}`
    : "";

  // Subscribe to the stable slices (they change only on a real mutation) and memoize the derived
  // shapes over them — a store selector returning a fresh `{ body, lineGroups }` / `{ proposed }`
  // object each render would trip zustand's snapshot cache into an update loop (the C08 pattern).
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const draftEdits = useRennetStore((s) => s.review.draftEdits);
  const retired = useRennetStore((s) => s.review.retired);
  const verdictOverride = useRennetStore((s) => s.review.verdictOverride);
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const codeComments = useRennetStore((s) => s.review.codeComments);
  const { stageAsk, unstageAsk, retire, restoreRetired, setVerdictOverride, setDraftEdit } =
    useRennetStore((s) => s.reviewActions);

  const draft = useMemo(() => composeLivingDraft(stagedAsks), [stagedAsks]);
  const arithmetic = useMemo(() => verdictArithmeticFromAsks(stagedAsks), [stagedAsks]);
  const commentsStaying = useMemo(
    () => Object.values(codeComments).reduce((n, lines) => n + Object.keys(lines).length, 0),
    [codeComments],
  );
  const threadsStaying = Object.keys(quoteThreads).length;

  const effectiveVerdict = verdictOverride ?? arithmetic.proposed;
  const overridden = verdictOverride !== null;

  const [editingAnchor, setEditingAnchor] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [receipt, setReceipt] = useState<PostReceipt | null>(null);

  const blockText = (ask: StagedAsk): string => draftEdits[ask.anchor] ?? ask.body;

  // Selection steering matches a quoted span back to its body ask (the spike's fuzzy join over
  // the block text, tolerant of the browser trimming/extending the selection).
  const findBodyAsk = (quote: string): StagedAsk | undefined =>
    draft.body.find((ask) => {
      const text = blockText(ask);
      return text.includes(quote) || quote.includes(text.slice(0, 40));
    });

  const draftHandlers: DraftHandlers = {
    onRevise: (quote, instruction) => reviseDraftSpan(quote, instruction),
    onDrop: (quote) => {
      const ask = findBodyAsk(quote);
      if (!ask) return;
      retire(ask, "dropped by you");
      unstageAsk(ask.anchor);
    },
    explain: (quote) => {
      const ask = findBodyAsk(quote);
      if (ask)
        return `This block comes from “${ask.anchor}” — staged as a ${ask.type.replace("-", " ")}.`;
      return "This is drafted review prose — it follows from the staged asks.";
    },
  };

  function startEdit(ask: StagedAsk) {
    setEditingAnchor(ask.anchor);
    setEditDraft(blockText(ask));
  }
  function saveEdit() {
    if (editingAnchor === null) return;
    const text = editDraft.trim();
    if (text.length > 0) setDraftEdit(editingAnchor, text);
    setEditingAnchor(null);
    setEditDraft("");
  }
  function deleteAsk(ask: StagedAsk) {
    retire(ask, "deleted by you");
    unstageAsk(ask.anchor);
  }
  function restore(entryAsk: StagedAsk) {
    stageAsk(entryAsk);
    restoreRetired(entryAsk.anchor);
  }

  if (receipt) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-start gap-3 px-8 py-10">
        <span className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Check className="size-4 text-green" aria-hidden="true" />
          Review posted to {prRef}
        </span>
        <p className="text-sm text-muted-foreground">
          {VERDICT_LABEL[receipt.verdict]} · {receipt.lineCommentCount} line comment
          {receipt.lineCommentCount === 1 ? "" : "s"} · body
        </p>
        <a
          href={receipt.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {receipt.url.replace(/^https?:\/\//, "")}
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div className="flex items-center gap-2.5">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Post Review · {prRef}
          </h1>
        </div>

        {/* Verdict: proposed, always flippable (R33). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs text-muted-foreground">Verdict</span>
          {/* Single-select segmented control — ToggleGroup, not a hand-rolled aria-pressed group
              (no-handrolled-toggle, autopsy S6). A review always carries a verdict, so a deselect
              (the empty array) is ignored; "use proposal" is the explicit revert. */}
          <ToggleGroup
            value={[effectiveVerdict]}
            onValueChange={(next: string[]) => {
              const picked = next[0] as ProposedVerdict | undefined;
              if (!picked) return;
              setVerdictOverride(picked === arithmetic.proposed ? null : picked);
            }}
            aria-label="Review verdict"
          >
            {VERDICTS.map((option) => (
              <Toggle key={option.value} value={option.value} size="sm">
                <span className={cn("size-1.5 rounded-full", option.dot)} />
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground/80">
            {overridden ? (
              <>
                overridden — proposed {VERDICT_LABEL[arithmetic.proposed].toLowerCase()}{" "}
                <button
                  type="button"
                  onClick={() => setVerdictOverride(null)}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  use proposal
                </button>
              </>
            ) : (
              `proposed from your review · ${arithmetic.requestChanges} request change${
                arithmetic.requestChanges === 1 ? "" : "s"
              } · ${arithmetic.comments} comment${arithmetic.comments === 1 ? "" : "s"}`
            )}
          </span>
        </div>

        {/* The living draft body: sans-face prose, steered by selection (R32) — no wrapper. */}
        <ProseSelectionLayer draftHandlers={draftHandlers}>
          <div className="flex flex-col gap-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Review Body
            </span>
            {draft.body.length === 0 ? (
              <p className="text-sm text-muted-foreground/70">
                No review body yet — staged prose asks compose it.
              </p>
            ) : (
              draft.body.map((ask) => (
                <div key={ask.anchor} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5">
                    <IntentTag type={ask.type} />
                    <span className="truncate text-2xs text-muted-foreground/80 italic">
                      {ask.anchor}
                    </span>
                  </span>
                  <RichText
                    text={blockText(ask)}
                    patchsetId={patchsetId}
                    paragraphClassName="text-base leading-[1.7] text-foreground/90"
                  />
                </div>
              ))
            )}
          </div>
        </ProseSelectionLayer>

        {/* Line comments: the discrete objects, grouped by file path (GitHub's shape). */}
        {draft.lineGroups.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Line Comments · {draft.lineGroups.reduce((n, g) => n + g.comments.length, 0)}
            </span>
            {draft.lineGroups.map((group) => (
              <div key={group.path} className="flex flex-col gap-2">
                <span className="font-mono text-2xs text-muted-foreground">{group.path}</span>
                {group.comments.map((comment) => (
                  <LineCommentCard
                    key={comment.ask.anchor}
                    comment={comment}
                    patchsetId={patchsetId}
                    body={blockText(comment.ask)}
                    editing={editingAnchor === comment.ask.anchor}
                    editDraft={editDraft}
                    onEditDraft={setEditDraft}
                    onStartEdit={() => startEdit(comment.ask)}
                    onSaveEdit={saveEdit}
                    onCancelEdit={() => setEditingAnchor(null)}
                    onDelete={() => deleteAsk(comment.ask)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Residue: what stays local (no reassurance clause). */}
        <p className="text-xs text-muted-foreground/80">
          {threadsStaying} thread{threadsStaying === 1 ? "" : "s"} · {commentsStaying} code comment
          {commentsStaying === 1 ? "" : "s"} stay local
        </p>

        {/* The Retired drawer: struck blocks, restorable with their whole provenance. */}
        {retired.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Retired
            </span>
            {retired.map((entry) => (
              <span key={entry.ask.anchor} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground line-through">
                  {entry.ask.body}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground/70">{entry.reason}</span>
                <button
                  type="button"
                  onClick={() => restore(entry.ask)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <RotateCcw className="size-2.5" aria-hidden="true" />
                  Restore
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Post: the draft above is exactly what posts — no separate preview (R31). */}
        <div className="flex items-center border-t border-border/60 pt-4">
          <HandoffAction
            label="Post Review"
            pendingLabel="Posting review…"
            icon={GitPullRequest}
            onSubmit={
              onPost
                ? async () => {
                    setReceipt(await onPost({ verdict: effectiveVerdict }));
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

/** One line-comment card: the anchor reveal, its intent tag, the body, and Edit / Delete. */
function LineCommentCard({
  comment,
  patchsetId,
  body,
  editing,
  editDraft,
  onEditDraft,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  comment: LineComment;
  patchsetId: string;
  body: string;
  editing: boolean;
  editDraft: string;
  onEditDraft: (value: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const codeRef: CodeRef = {
    patchsetId,
    path: comment.path,
    side: "head",
    startLine: comment.line,
    endLine: comment.line,
  };
  return (
    <div className="group rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <AnchorReveal citations={[codeRef]} />
        <IntentTag type={comment.ask.type} />
        {!editing && (
          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={onStartEdit}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Pencil className="size-3" aria-hidden="true" />
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Trash2 className="size-3" aria-hidden="true" />
              Delete
            </button>
          </span>
        )}
      </div>
      <div className="mt-1.5">
        {editing ? (
          <>
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the editor opens on an explicit Edit click; focus belongs in the box.
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
            <div className="mt-1.5 flex items-center justify-end gap-1">
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
            text={body}
            patchsetId={patchsetId}
            paragraphClassName="text-sm leading-relaxed text-foreground/90"
          />
        )}
      </div>
    </div>
  );
}
