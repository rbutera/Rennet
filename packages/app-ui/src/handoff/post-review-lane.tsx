import type { Review } from "@rennet/protocol";
import { Badge, cn, Toggle, ToggleGroup } from "@rennet/ui";
import { Check, GitPullRequest, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useCoachAnchor } from "../coach/registry";
import {
  AnchorReveal,
  type CodeRef,
  type DraftHandlers,
  ProseSelectionLayer,
  RichText,
} from "../review";
import type { DispositionKind, ReviewState, StagedAsk } from "../store";
import { useRennetStore } from "../store";
import { HandoffAction } from "./handoff-action";
import {
  composeLivingDraft,
  type LineComment,
  type ReviewDraft,
  type ReviewThread,
  type ReviseSpan,
  reviseDraftSpan,
} from "./handoff-data";
import { OutboundMarkdown } from "./outbound-markdown";
import {
  type ProposedVerdict,
  type VerdictArithmetic,
  verdictArithmeticFromAsks,
} from "./selectors";

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
//     Revise (reaches the `handoff-data.ts` rework seam, now bound to B11's live
//     `review.reviseSpan`). The reviewer never types into the draft.
//   • RECEIPT-IS-UNDO: every drop/retire/delete/edit/verdict change reads back reversible from
//     the store; only the final sign-click (`onSubmit`) is irreversible. The draft above IS the
//     preview — no separate preview stage (R31).
//
// The spike's synthetic `openerFor()` prose is gone. The daemon drafts a grounded opener from
// persisted review evidence and returns the exact forge descriptor this lane previews and posts.
// The egress (`publish.compose` → `publish.review`) arrives as `onPost`; absent, the CTA renders
// disabled (honest), never a Post that posts nothing.
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

const INTENT_LABEL = {
  approve: "Approve",
  "request-change": "Request Change",
  comment: "Comment",
  question: "Question",
} satisfies Record<DispositionKind, string>;

function IntentTag({ type }: { type: DispositionKind }) {
  const requestChange = type === "request-change";
  return (
    <Badge variant={requestChange ? "destructive" : "secondary"} className="shrink-0">
      {INTENT_LABEL[type]}
    </Badge>
  );
}

function localResidueCounts(
  quoteThreads: ReviewState["quoteThreads"],
  codeComments: ReviewState["codeComments"],
): { readonly threads: number; readonly comments: number } {
  return {
    threads: Object.keys(quoteThreads).length,
    comments: Object.values(codeComments).reduce(
      (count, lines) => count + Object.keys(lines).length,
      0,
    ),
  };
}

function localResidueLine(
  quoteThreads: ReviewState["quoteThreads"],
  codeComments: ReviewState["codeComments"],
): string {
  const { threads, comments } = localResidueCounts(quoteThreads, codeComments);
  return `${threads} thread${threads === 1 ? "" : "s"} · ${comments} code comment${
    comments === 1 ? "" : "s"
  } stay local`;
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
   * The egress — posts the composed `draft` on the sign-click (cluster 6). Absent ⇒ the Post CTA
   * is present but disabled (no egress wired / review not composed yet).
   */
  readonly onPost?: () => Promise<PostReceipt>;
  /**
   * The composed outbound review (the daemon's `publish.compose` bytes). When present, the lane
   * PREVIEWS exactly these bytes and posts the same composition (the exact-preview contract,
   * architecture-contracts.md "Posting to GitHub"). Absent ⇒ the pre-compose working-draft view
   * over the store (used while composing and by unit mounts) with the CTA disabled.
   */
  readonly draft?: ReviewDraft;
  /**
   * Flip the composed review's verdict — a durable write that recomposes (#435). Absent ⇒ the
   * control renders the composed verdict and a flip does nothing (unit mounts).
   */
  readonly onSetVerdict?: (verdict: ProposedVerdict | null) => void;
  /**
   * Selection-steer Revise, bound to B11's `review.reviseSpan` (cluster 8). Absent ⇒ the Rework
   * control is disabled and the panel says so — never a pretend run.
   */
  readonly onRevise?: ReviseSpan;
  /** Why the daemon composed no outbound review, in its own words — stated beside the dead CTA. */
  readonly unavailable?: string;
}

export function PostReviewLane({
  review,
  onPost,
  draft,
  onSetVerdict,
  onRevise,
  unavailable,
}: PostReviewLaneProps) {
  // The composed preview IS what posts (exact-preview): when the daemon's composition is in hand,
  // render THOSE bytes, never the local working draft that recomposed to different bytes on click.
  if (draft)
    return (
      <ComposedReviewPreview
        review={review}
        draft={draft}
        onPost={onPost}
        onSetVerdict={onSetVerdict}
      />
    );
  return (
    <WorkingReviewDraft
      review={review}
      onPost={onPost}
      onSetVerdict={onSetVerdict}
      onRevise={onRevise}
      unavailable={unavailable}
    />
  );
}

function WorkingReviewDraft({
  review,
  onPost,
  onSetVerdict,
  onRevise,
  unavailable,
}: Omit<PostReviewLaneProps, "draft">) {
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
  const localResidue = useMemo(
    () => localResidueLine(quoteThreads, codeComments),
    [quoteThreads, codeComments],
  );

  // A verdict flip is DURABLE (#435): it writes the ask log, which is what `publish.compose`
  // reads, so the flip survives into the composition instead of being discarded the moment the
  // composed preview arrives. The local store keeps this pre-compose lane's control responsive
  // (there is no composition to read back from yet); the durable write is what makes it real.
  const flipVerdict = (verdict: ProposedVerdict | null): void => {
    setVerdictOverride(verdict);
    onSetVerdict?.(verdict);
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [receipt, setReceipt] = useState<PostReceipt | null>(null);

  // Coach marks on the post-review lane: `verdict` (the proposed-verdict control) and
  // `draft` (the living draft body). Both anchor the wrapper element around their region.
  const verdictRef = useCoachAnchor("verdict");
  const draftRef = useCoachAnchor("draft");

  // Inline edits are keyed by ask IDENTITY (id), not anchor — so an edit follows its ask and a
  // deleted ask's edit is dropped rather than haunting a later ask that shares the anchor.
  const blockText = (ask: StagedAsk): string => draftEdits[ask.id] ?? ask.body;

  // Selection steering matches a quoted span back to its body ask (the spike's fuzzy join over
  // the block text, tolerant of the browser trimming/extending the selection).
  const findBodyAsk = (quote: string): StagedAsk | undefined =>
    draft.body.find((ask) => {
      const text = blockText(ask);
      return text.includes(quote) || quote.includes(text.slice(0, 40));
    });

  // Land a reworked ask so the lane actually SHOWS it. This lane renders `blockText` — an inline
  // `draftEdits` shadow WINS over the ask body — so re-staging alone would leave the reviewer's
  // stale shadow on screen while the panel closed as success. Overwrite the shadow when one
  // exists (the rework supersedes the edit it was run against); never mint one where there is
  // none, or the composed preview would count a phantom "inline edit pending".
  const landRework = (reworked: StagedAsk) => {
    stageAsk(reworked);
    if (draftEdits[reworked.id] !== undefined) setDraftEdit(reworked.id, reworked.body);
  };

  const draftHandlers: DraftHandlers = {
    // Live span rework: resolve the span back to its ask, then route through the ONE seam.
    onRevise: onRevise
      ? async (quote, instruction) => {
          const ask = findBodyAsk(quote);
          if (!ask) return "That span no longer matches a staged ask.";
          return reviseDraftSpan(onRevise, landRework, ask, quote, instruction);
        }
      : undefined,
    onDrop: (quote) => {
      const ask = findBodyAsk(quote);
      if (!ask) return;
      retire(ask, "dropped by you");
      unstageAsk(ask.id);
    },
    explain: (quote) => {
      const ask = findBodyAsk(quote);
      if (ask)
        return `This block comes from “${ask.anchor}” — staged as a ${ask.type.replace("-", " ")}.`;
      return "This is drafted review prose — it follows from the staged asks.";
    },
  };

  function startEdit(ask: StagedAsk) {
    setEditingId(ask.id);
    setEditDraft(blockText(ask));
  }
  function saveEdit() {
    if (editingId === null) return;
    const text = editDraft.trim();
    if (text.length > 0) setDraftEdit(editingId, text);
    setEditingId(null);
    setEditDraft("");
  }
  function deleteAsk(ask: StagedAsk) {
    retire(ask, "deleted by you");
    unstageAsk(ask.id);
  }
  function restore(entryAsk: StagedAsk) {
    stageAsk(entryAsk);
    restoreRetired(entryAsk.id);
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

        <div ref={verdictRef}>
          <VerdictControl
            arithmetic={arithmetic}
            verdictOverride={verdictOverride}
            setVerdictOverride={flipVerdict}
          />
        </div>

        {/* The living draft body: sans-face prose, steered by selection (R32). The coach
            `draft` mark anchors this wrapper; the prose itself carries no extra chrome. */}
        <div ref={draftRef}>
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
                  <div key={ask.id} className="flex flex-col gap-1">
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
        </div>

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
                    key={comment.ask.id}
                    comment={comment}
                    patchsetId={patchsetId}
                    body={blockText(comment.ask)}
                    editing={editingId === comment.ask.id}
                    editDraft={editDraft}
                    onEditDraft={setEditDraft}
                    onStartEdit={() => startEdit(comment.ask)}
                    onSaveEdit={saveEdit}
                    onCancelEdit={() => setEditingId(null)}
                    onDelete={() => deleteAsk(comment.ask)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Residue: what stays local (no reassurance clause). */}
        <p className="text-xs text-muted-foreground/80">{localResidue}</p>

        {/* The Retired drawer: struck blocks, restorable with their whole provenance. */}
        {retired.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Retired
            </span>
            {retired.map((entry) => (
              <span key={entry.ask.id} className="flex items-baseline gap-2">
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

        {/* Post: the draft above is exactly what posts — no separate preview (R31). The CTA is
            dead until the daemon has composed; when it REFUSED to, say so in its own words rather
            than leaving a grey button and no account (`HandoffAction`'s error line only fires on a
            click, which a disabled button forbids). A statement, not a gate. */}
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <HandoffAction
            label="Post Review"
            pendingLabel="Posting review…"
            icon={GitPullRequest}
            onSubmit={
              onPost
                ? async () => {
                    setReceipt(await onPost());
                  }
                : undefined
            }
          />
          {unavailable !== undefined && (
            <p className="text-xs text-muted-foreground">{unavailable}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The verdict segmented control (R33): the proposal states its arithmetic beside itself and is
 * always flippable. An override says so and offers "use proposal" to revert. Shared by the
 * working draft (arithmetic proposed off staged asks) and the composed preview (proposed off the
 * daemon's composed verdict) — the arithmetic is passed in, the control never derives it.
 */
function VerdictControl({
  arithmetic,
  verdictOverride,
  setVerdictOverride,
}: {
  arithmetic: VerdictArithmetic;
  verdictOverride: ProposedVerdict | null;
  setVerdictOverride: (verdict: ProposedVerdict | null) => void;
}) {
  const effectiveVerdict = verdictOverride ?? arithmetic.proposed;
  const overridden = verdictOverride !== null;
  return (
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
  );
}

/**
 * The COMPOSED review preview (exact-preview contract, architecture-contracts.md "Posting to
 * GitHub"). `draft` is the daemon's `publish.compose(mode:"review")` bytes, and `onPost` posts
 * that SAME composition — so what the reviewer signs here IS what leaves the machine, byte for
 * byte, never a body recomposed after preview. The composed bytes render read-only: they are the
 * outbound payload, not the working set. Refinement (drop/edit/verdict-by-ask) happens over the
 * store in the diff and working-draft surfaces BEFORE compose; reopening the lane recomposes.
 *
 * Because `publish.compose` takes no inline-edit input, any local `draftEdits` (inline edits the
 * reviewer typed) cannot reach this composition — so they are marked pending-not-applied, never
 * silently dropped (the finding's "never silently divergent").
 */
function ComposedReviewPreview({
  review,
  draft,
  onPost,
  onSetVerdict,
}: {
  review: Review;
  draft: ReviewDraft;
  onPost?: () => Promise<PostReceipt>;
  onSetVerdict?: (verdict: ProposedVerdict | null) => void;
}) {
  const patchsetId = review.activePatchsetId;
  const postTarget = review.postTarget;
  const prRef = postTarget
    ? `${postTarget.repo.owner}/${postTarget.repo.name}#${postTarget.number}`
    : draft.destination;

  const draftEdits = useRennetStore((s) => s.review.draftEdits);
  const quoteThreads = useRennetStore((s) => s.review.quoteThreads);
  const codeComments = useRennetStore((s) => s.review.codeComments);
  const pendingEditCount = Object.keys(draftEdits).length;
  const localResidue = useMemo(
    () => localResidueLine(quoteThreads, codeComments),
    [quoteThreads, codeComments],
  );

  const [receipt, setReceipt] = useState<PostReceipt | null>(null);

  // The verdict shown is the COMPOSED one — the daemon binds it into the composition, so it is
  // exactly what posts (#435). Flipping it writes the durable override and recomposes; there is
  // no local verdict here to drift from the composition.
  const arithmetic: VerdictArithmetic = {
    proposed: draft.proposed,
    requestChanges: draft.arithmetic.requestChanges,
    comments: draft.arithmetic.comments,
  };
  const verdictOverride = draft.post.event === draft.proposed ? null : draft.post.event;
  const lineCommentCount = draft.post.threads.length;

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

        <VerdictControl
          arithmetic={arithmetic}
          verdictOverride={verdictOverride}
          setVerdictOverride={onSetVerdict ?? (() => undefined)}
        />

        {/* Any inline edit that cannot reach the composition, named — not silently dropped. */}
        {pendingEditCount > 0 && (
          <p className="rounded-md border border-border/60 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            {pendingEditCount} inline edit{pendingEditCount === 1 ? "" : "s"} pending — not in this
            composed review. Revise the underlying ask, then recompose.
          </p>
        )}

        {draft.artifact.bodyNotes.length > 0 && (
          <div className="flex flex-col gap-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Body Note Provenance
            </span>
            {draft.artifact.bodyNotes.map((note, index) => (
              <div
                key={note.id ?? `${note.anchor ?? "note"}-${index}`}
                className="flex flex-col gap-1"
              >
                <span className="flex items-center gap-1.5">
                  <IntentTag type={note.type} />
                  {note.anchor !== undefined && (
                    <span className="truncate text-2xs text-muted-foreground/80 italic">
                      {note.anchor}
                    </span>
                  )}
                </span>
                <RichText
                  text={note.body}
                  patchsetId={patchsetId}
                  paragraphClassName="text-base leading-[1.7] text-foreground/90"
                />
              </div>
            ))}
          </div>
        )}

        {/* The daemon-built body is the outbound body. Never rebuild it from the artifact. */}
        <div className="flex flex-col gap-4">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Review Body
          </span>
          <OutboundMarkdown
            markdown={draft.post.body}
            patchsetId={patchsetId}
            hideFinalReviewMarker
          />
        </div>

        {/* The exact daemon thread array, in descriptor order and without client regrouping. */}
        {draft.post.threads.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Review Threads · {lineCommentCount}
            </span>
            {draft.post.threads.map((thread, index) => (
              <ComposedThreadCard
                // biome-ignore lint/suspicious/noArrayIndexKey: the frozen descriptor permits duplicate threads and never reorders.
                key={`${thread.path}:${thread.startLine ?? thread.line}:${thread.line}:${thread.side}:${index}`}
                thread={thread}
                patchsetId={patchsetId}
              />
            ))}
          </div>
        )}

        {draft.ledger.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Outbound Accounting
            </span>
            {draft.ledger.map((entry, index) => (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: duplicate accounting entries are valid and the frozen ledger never reorders.
                key={`${entry.kind}:${entry.path}:${index}`}
                className="text-xs text-muted-foreground/80"
              >
                <span className="font-mono">
                  {entry.kind} · {entry.path}
                </span>{" "}
                · {entry.detail}
              </p>
            ))}
          </div>
        )}

        {/* Residue remains local metadata; it is not part of the composed outbound bytes. */}
        <p className="text-xs text-muted-foreground/80">{localResidue}</p>

        {/* The exact bytes above are what posts — no separate preview, no recomposition (R31/R33). */}
        <div className="flex items-center border-t border-border/60 pt-4">
          <HandoffAction
            label="Post Review"
            pendingLabel="Posting review…"
            icon={GitPullRequest}
            onSubmit={
              onPost
                ? async () => {
                    setReceipt(await onPost());
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

/** One exact daemon-built thread, read-only and kept in descriptor order. */
function ComposedThreadCard({ thread, patchsetId }: { thread: ReviewThread; patchsetId: string }) {
  const codeRef: CodeRef = {
    patchsetId,
    path: thread.path,
    side: thread.side === "LEFT" ? "base" : "head",
    startLine: thread.startLine ?? thread.line,
    endLine: thread.line,
  };
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <AnchorReveal citations={[codeRef]} />
        <span className="font-mono text-2xs text-muted-foreground">
          {thread.path}:{thread.startLine ?? thread.line}
          {thread.startLine === undefined || thread.startLine === thread.line
            ? ""
            : `–${thread.line}`}{" "}
          · {thread.side}
        </span>
      </div>
      <div className="mt-1.5">
        <RichText
          text={thread.body}
          patchsetId={patchsetId}
          paragraphClassName="text-sm leading-relaxed text-foreground/90"
        />
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
  const codeRef: CodeRef = comment.ask.codeRef ?? {
    patchsetId,
    path: comment.path,
    side: comment.side === "LEFT" ? "base" : "head",
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
