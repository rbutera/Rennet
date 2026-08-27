import type { StateCreator } from "zustand";
import type { RennetState } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The `review` slice (C01 §3): the reviewer's IN-FLIGHT interaction state for an open
// review — staged asks, per-line code comments, quote threads, the focused thread, the
// retired ledger, a verdict override, and draft-block edits. This is transient renderer
// state (no persist): reload restores LOCATION from the URL and resets interaction clean.
//
// DERIVE, DON'T STORE: counts, tallies, and highlights are selectors over this slice +
// the projection cache — never fields. The review surface (C3+) fills these shapes in;
// C01 lands the owned state, the core mutators, and the derived-count selectors that make
// the discipline enforceable. `ponytail:` foundation slice — actions grow with C3+.
// ─────────────────────────────────────────────────────────────────────────────

/** A disposition kind (mirrors protocol's `dispositionType`; kept local to avoid coupling). */
export type DispositionKind = "approve" | "request-change" | "comment" | "question";

/** A staged ask against an anchor — the reviewer's pending request-change/comment/question. */
export interface StagedAsk {
  /** The ask's SOURCE anchor — a `path:line` code position, or the quoted prose span. */
  readonly anchor: string;
  readonly type: DispositionKind;
  readonly body: string;
  /**
   * The quote thread this ask CLAIMS, when it was minted alongside one (prose
   * request-change). Kept distinct from `anchor` (the source provenance) so an exit
   * tally counts the claimed thread once — via this ask — instead of twice.
   */
  readonly threadId?: string;
}

/** One message in a quote thread — the reviewer's, or the orchestrator's reply. */
export interface QuoteMessage {
  readonly author: "user" | "orchestrator";
  readonly text: string;
}

/**
 * A quote-anchored thread on board prose (C4, extends C01's placeholder). `anchor`
 * is the highlighted span; `messages` is the exchange (opener + replies); an
 * `explain` thread is a question to the orchestrator — it never raises the exit count.
 */
export interface QuoteThread {
  readonly anchor: string;
  readonly kind?: "comment" | "explain";
  readonly messages: readonly QuoteMessage[];
}

// A per-process thread-id counter — monotonic, deterministic, and independent of any
// store instance (a fresh `createRennetStore` shares no OTHER state, so unique ids
// across instances is all that's needed; no crypto, no collision).
let quoteThreadSeq = 0;
const nextQuoteThreadId = (): string => `qt-${++quoteThreadSeq}`;

export interface ReviewState {
  /** Staged asks keyed by anchor id. */
  readonly stagedAsks: Readonly<Record<string, StagedAsk>>;
  /** Per-line code comments, keyed path → line → body. */
  readonly codeComments: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /** Quote threads keyed by thread id — the anchored span, its kind, and the exchange. */
  readonly quoteThreads: Readonly<Record<string, QuoteThread>>;
  /** The focused thread id, or null. */
  readonly focusedThreadId: string | null;
  /** The retired ledger: ids the reviewer withdrew from the staged set. */
  readonly retired: readonly string[];
  /** An explicit verdict override, or null (derive from dispositions). */
  readonly verdictOverride: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
  /** Draft-block edits keyed by block id (the PR body / handoff draft blocks). */
  readonly draftEdits: Readonly<Record<string, string>>;
}

export interface ReviewSlice {
  readonly review: ReviewState;
  readonly reviewActions: {
    stageAsk(ask: StagedAsk): void;
    unstageAsk(anchor: string): void;
    setCodeComment(path: string, line: number, body: string): void;
    clearCodeComment(path: string, line: number): void;
    /** Mint a quote thread on `anchor` with `text` as the opener; returns the new thread id. */
    addQuoteComment(anchor: string, text: string, kind?: "comment" | "explain"): string;
    /** Append a reply to an existing thread (no-op if the thread is gone). */
    addQuoteReply(threadId: string, author: "user" | "orchestrator", text: string): void;
    /** Drop a quote thread. */
    removeQuoteComment(threadId: string): void;
    setFocusedThread(threadId: string | null): void;
    retire(id: string): void;
    setVerdictOverride(verdict: ReviewState["verdictOverride"]): void;
    setDraftEdit(blockId: string, body: string): void;
    resetReview(): void;
  };
}

const initialReview: ReviewState = {
  stagedAsks: {},
  codeComments: {},
  quoteThreads: {},
  focusedThreadId: null,
  retired: [],
  verdictOverride: null,
  draftEdits: {},
};

export const createReviewSlice: StateCreator<RennetState, [], [], ReviewSlice> = (set) => ({
  review: initialReview,
  reviewActions: {
    stageAsk: (ask) =>
      set((s) => ({
        review: { ...s.review, stagedAsks: { ...s.review.stagedAsks, [ask.anchor]: ask } },
      })),
    unstageAsk: (anchor) =>
      set((s) => {
        const rest = { ...s.review.stagedAsks };
        delete rest[anchor];
        return { review: { ...s.review, stagedAsks: rest } };
      }),
    setCodeComment: (path, line, body) =>
      set((s) => ({
        review: {
          ...s.review,
          codeComments: {
            ...s.review.codeComments,
            [path]: { ...s.review.codeComments[path], [line]: body },
          },
        },
      })),
    clearCodeComment: (path, line) =>
      set((s) => {
        const forPath = s.review.codeComments[path];
        if (!forPath) return {};
        const restLines = { ...forPath };
        delete restLines[line];
        return {
          review: { ...s.review, codeComments: { ...s.review.codeComments, [path]: restLines } },
        };
      }),
    addQuoteComment: (anchor, text, kind) => {
      const id = nextQuoteThreadId();
      set((s) => ({
        review: {
          ...s.review,
          quoteThreads: {
            ...s.review.quoteThreads,
            [id]: { anchor, kind, messages: [{ author: "user", text }] },
          },
        },
      }));
      return id;
    },
    addQuoteReply: (threadId, author, text) =>
      set((s) => {
        const thread = s.review.quoteThreads[threadId];
        if (!thread) return {};
        return {
          review: {
            ...s.review,
            quoteThreads: {
              ...s.review.quoteThreads,
              [threadId]: { ...thread, messages: [...thread.messages, { author, text }] },
            },
          },
        };
      }),
    removeQuoteComment: (threadId) =>
      set((s) => {
        const rest = { ...s.review.quoteThreads };
        delete rest[threadId];
        return { review: { ...s.review, quoteThreads: rest } };
      }),
    setFocusedThread: (threadId) =>
      set((s) => ({ review: { ...s.review, focusedThreadId: threadId } })),
    retire: (id) =>
      set((s) => ({
        review: { ...s.review, retired: [...s.review.retired.filter((r) => r !== id), id] },
      })),
    setVerdictOverride: (verdict) =>
      set((s) => ({ review: { ...s.review, verdictOverride: verdict } })),
    setDraftEdit: (blockId, body) =>
      set((s) => ({
        review: { ...s.review, draftEdits: { ...s.review.draftEdits, [blockId]: body } },
      })),
    resetReview: () => set(() => ({ review: initialReview })),
  },
});

// ── Selectors (beside the slice) ─────────────────────────────────────────────
/** How many asks are staged. DERIVED — the count is never a stored field. */
export const selectStagedAskCount = (s: RennetState): number =>
  Object.keys(s.review.stagedAsks).length;
/** The staged ask on `anchor`, or undefined. */
export const selectStagedAsk =
  (anchor: string) =>
  (s: RennetState): StagedAsk | undefined =>
    s.review.stagedAsks[anchor];
/** The per-line code comment on `path:line`, or undefined. */
export const selectCodeComment =
  (path: string, line: number) =>
  (s: RennetState): string | undefined =>
    s.review.codeComments[path]?.[line];
