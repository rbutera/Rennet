import {
  codePositionKey,
  type RennetState,
  type ReviewState,
  type StagedAsk,
  stagedAskCodePosition,
} from "../store";

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
  // THE DUAL-CLAIM RULE (finding 8): an ask counts ONCE and claims EVERY source it names — both
  // the quote thread its `threadId` points at AND the code comment at its `path:line` anchor. So an
  // ask carrying both suppresses both and still contributes one: it is ONE thing the reviewer wants,
  // not two. This is not a miscount — the two "sources" are facets of the single ask. (Today no
  // staging site mints such an ask: a quote ask's anchor is prose, a line ask carries no thread — so
  // the rule is defined here against a future site that legitimately anchors an ask to both.)
  const claimedThreadIds = new Set(
    asks.map((ask) => ask.threadId).filter((id): id is string => id !== undefined),
  );
  const claimedLinePositions = new Set(
    asks.flatMap((ask) => {
      const position = stagedAskCodePosition(ask);
      return position === null ? [] : [codePositionKey(position)];
    }),
  );

  const threadCount = Object.entries(s.review.quoteThreads).filter(
    ([id, thread]) => thread.kind !== "explain" && !claimedThreadIds.has(id),
  ).length;

  let lineCommentCount = 0;
  for (const [path, lines] of Object.entries(s.review.codeComments)) {
    for (const line of Object.keys(lines)) {
      if (!claimedLinePositions.has(codePositionKey({ path, line: Number(line), side: "RIGHT" }))) {
        lineCommentCount += 1;
      }
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
export const verdictArithmeticFromAsks = (
  asks: Readonly<Record<string, StagedAsk>>,
): VerdictArithmetic => {
  const list = Object.values(asks);
  const requestChanges = list.filter((ask) => ask.type === "request-change").length;
  const comments = list.length - requestChanges;
  const proposed: ProposedVerdict =
    requestChanges > 0 ? "REQUEST_CHANGES" : list.length > 0 ? "COMMENT" : "APPROVE";
  return { proposed, requestChanges, comments };
};

export const selectVerdictArithmetic = (s: RennetState): VerdictArithmetic =>
  verdictArithmeticFromAsks(s.review.stagedAsks);

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
 * Partition a staged-ask map into review-body prose vs code line comments (R36): an ask
 * whose anchor is a `path:line` code position is a line comment; an anchorless/prose ask
 * travels in the review body. Placement is the statement — no chrome copy explains it.
 * Insertion order is preserved (object key order), so the body/line lists read in the order
 * the reviewer staged them. The single routing truth: `selectBodyVsLineAsks` reads it off the
 * store, and a surface subscribing to the stable `stagedAsks` map memoizes over it directly
 * (a store-derived object selector would return a fresh reference each render).
 */
export const partitionAsksByAnchor = (
  asks: Readonly<Record<string, StagedAsk>>,
): BodyVsLineAsks => {
  const body: StagedAsk[] = [];
  const line: StagedAsk[] = [];
  for (const ask of Object.values(asks)) {
    if (stagedAskCodePosition(ask)) line.push(ask);
    else body.push(ask);
  }
  return { body, line };
};

/** Partition the store's staged asks into review-body prose vs code line comments (R36). */
export const selectBodyVsLineAsks = (s: RennetState): BodyVsLineAsks =>
  partitionAsksByAnchor(s.review.stagedAsks);
