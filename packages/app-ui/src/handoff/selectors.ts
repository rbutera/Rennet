import type { RennetState, ReviewState, StagedAsk } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The derived exit arithmetic (C08 cluster 1, Objective clause 7, Reconciliation 2).
// The spike scattered these across `useState`/`useMemo` in an event-accumulating god
// store (autopsy S8); C08 makes them SELECTORS over the already-landed C01 `review`
// slice, so they read the same after any navigation because nothing stores them.
// DERIVE, DON'T STORE: a field a selector could compute is a bug (store discipline).
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed `path:line` code anchor. */
export interface LineAnchor {
  readonly path: string;
  readonly line: number;
}

/**
 * Parse a staged ask's anchor as a `path:line` code position, or `null` for a prose
 * span (R36). The trailing `:<digits>` is the line; everything before it is the path.
 * A prose span ("This holds up.") has no trailing `:<digits>` and resolves to the
 * review body; a code anchor ("src/store.ts:42") resolves to a line comment.
 */
export function parseLineAnchor(anchor: string): LineAnchor | null {
  const match = /^(.+):(\d+)$/.exec(anchor);
  const [, path, lineStr] = match ?? [];
  if (path === undefined || lineStr === undefined) return null;
  return { path, line: Number(lineStr) };
}

/**
 * The exit pip count (R50 amendments): staged asks + unclaimed line comments +
 * unclaimed quote threads. Explain threads never count (they raise no exit). A quote
 * thread CLAIMED by a staged ask's `threadId`, or a code comment CLAIMED by a staged
 * ask's `path:line` anchor, is counted ONCE via the ask — so a highlight request-change
 * (a quote thread + the ask that claims it) contributes one, not two. Derived from the
 * `review` slice content, never the accumulated event total the spike's module global held.
 */
export const selectExitPipCount = (s: RennetState): number => {
  const asks = Object.values(s.review.stagedAsks);
  const claimedThreadIds = new Set(
    asks.map((ask) => ask.threadId).filter((id): id is string => id !== undefined),
  );
  const claimedLineAnchors = new Set(
    asks.map((ask) => ask.anchor).filter((anchor) => parseLineAnchor(anchor) !== null),
  );

  const threadCount = Object.entries(s.review.quoteThreads).filter(
    ([id, thread]) => thread.kind !== "explain" && !claimedThreadIds.has(id),
  ).length;

  let lineCommentCount = 0;
  for (const [path, lines] of Object.entries(s.review.codeComments)) {
    for (const line of Object.keys(lines)) {
      if (!claimedLineAnchors.has(`${path}:${line}`)) lineCommentCount += 1;
    }
  }

  return asks.length + threadCount + lineCommentCount;
};

/** The proposed verdict, one of the three real GitHub review events. */
export type ProposedVerdict = NonNullable<ReviewState["verdictOverride"]>;

/** The verdict proposal with its arithmetic tally (R33). */
export interface VerdictArithmetic {
  readonly proposed: ProposedVerdict;
  /** Staged asks with request-change intent. */
  readonly requestChanges: number;
  /** Every other staged ask (the `N request changes · M comments` tally's M). */
  readonly comments: number;
}

/**
 * The verdict arithmetic (R33): any request-change ask ⇒ Request Changes; any other
 * staged ask ⇒ Comment; nothing staged ⇒ Approve. Returns the proposal WITH its tally,
 * so the segmented control can state "proposed from your review · N request changes ·
 * M comments" beside itself. This is the PROPOSAL only — the reviewer's `verdictOverride`
 * is applied where the control renders (it stays flippable, an approving review first-class).
 */
export const selectVerdictArithmetic = (s: RennetState): VerdictArithmetic => {
  const asks = Object.values(s.review.stagedAsks);
  const requestChanges = asks.filter((ask) => ask.type === "request-change").length;
  const comments = asks.length - requestChanges;
  const proposed: ProposedVerdict =
    requestChanges > 0 ? "REQUEST_CHANGES" : asks.length > 0 ? "COMMENT" : "APPROVE";
  return { proposed, requestChanges, comments };
};

/** The proposed verdict alone (the arithmetic's `proposed`). */
export const selectProposedVerdict = (s: RennetState): ProposedVerdict =>
  selectVerdictArithmetic(s).proposed;

/** Staged asks partitioned into review-body prose and code line comments (R36). */
export interface BodyVsLineAsks {
  /** Asks whose anchor is a prose span — they travel in the review body. */
  readonly body: readonly StagedAsk[];
  /** Asks whose anchor is a `path:line` code position — they become line comments. */
  readonly line: readonly StagedAsk[];
}

/**
 * Partition the staged asks into review-body prose vs code line comments (R36): an ask
 * whose anchor is a `path:line` code position is a line comment; an anchorless/prose ask
 * travels in the review body. Placement is the statement — no chrome copy explains it.
 * Insertion order is preserved (object key order), so the body/line lists read in the
 * order the reviewer staged them.
 */
export const selectBodyVsLineAsks = (s: RennetState): BodyVsLineAsks => {
  const body: StagedAsk[] = [];
  const line: StagedAsk[] = [];
  for (const ask of Object.values(s.review.stagedAsks)) {
    if (parseLineAnchor(ask.anchor)) line.push(ask);
    else body.push(ask);
  }
  return { body, line };
};
