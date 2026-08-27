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

/** A staged ask — the reviewer's pending request-change/comment/question. */
export interface StagedAsk {
  /**
   * The ask's stable IDENTITY — how the staged/retired/edit overlays key it. Distinct from
   * `anchor` (provenance): two asks may share an anchor (two intents on one line, identical prose
   * in two elements) and stay separate here, and a deleted ask's id never rebinds a later ask's
   * edit. A staging site supplies an id stable for its own identity model (an element id for a
   * toggle-once finding, `path:line` for a line editor, the minted thread id for a quote ask).
   */
  readonly id: string;
  /** The ask's SOURCE anchor — a `path:line` code position, or the quoted prose span (provenance). */
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

/**
 * A retired draft block — the ask the reviewer withdrew from the staged set, kept WHOLE
 * (intent, source anchor, body, claimed thread) with the reason it left, so Restore
 * re-stages it exactly (C08 §4.2). The ledger holds the ask, not a bare id: an unstaged
 * ask is gone from `stagedAsks`, so its provenance must live here or restore cannot rebuild it.
 */
export interface RetiredEntry {
  readonly ask: StagedAsk;
  readonly reason: string;
}

/** One message in a quote thread — the reviewer's, or the orchestrator's reply. */
export interface QuoteMessage {
  readonly author: "user" | "orchestrator";
  readonly text: string;
}

/**
 * A quote-anchored thread on board prose (C4, extends C01's placeholder). `anchor`
 * is the highlighted span text; `messages` is the exchange (opener + replies); an
 * `explain` thread is a question to the orchestrator — it never raises the exit count.
 *
 * `target` + `generation` are the PROTOCOL-SHAPED anchor identity (C5 finding 2): the
 * element id the thread lands on (mirroring the `message` kind's `quote_target`) and
 * the board generation it belongs to. Without them the durable highlight would match
 * `anchor` text review-wide and paint the same span on every element/lens/generation
 * that repeats it (the fabrication finding 2 kills). A thread carries them when minted
 * from a board selection; a thread that lacks them never renders a durable highlight.
 */
export interface QuoteThread {
  readonly anchor: string;
  readonly kind?: "comment" | "explain";
  /** The element id this thread anchors to (the `quote_target` identity). */
  readonly target?: string;
  /** The board generation this thread was raised against. */
  readonly generation?: string;
  readonly messages: readonly QuoteMessage[];
}

/** The board-anchor identity a thread is scoped to when minted from a selection. */
export interface QuoteScope {
  readonly target?: string;
  readonly generation?: string;
}

// A per-process thread-id counter — monotonic, deterministic, and independent of any
// store instance (a fresh `createRennetStore` shares no OTHER state, so unique ids
// across instances is all that's needed; no crypto, no collision).
let quoteThreadSeq = 0;
const nextQuoteThreadId = (): string => `qt-${++quoteThreadSeq}`;

export interface ReviewState {
  /** Staged asks keyed by ask `id` (identity), NOT anchor — so same-anchor asks coexist. */
  readonly stagedAsks: Readonly<Record<string, StagedAsk>>;
  /** Per-line code comments, keyed path → line → body. */
  readonly codeComments: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /** Quote threads keyed by thread id — the anchored span, its kind, and the exchange. */
  readonly quoteThreads: Readonly<Record<string, QuoteThread>>;
  /** The focused thread id, or null. */
  readonly focusedThreadId: string | null;
  /** The retired ledger: whole asks the reviewer withdrew, newest last, each with its reason. */
  readonly retired: readonly RetiredEntry[];
  /** An explicit verdict override, or null (derive from dispositions). */
  readonly verdictOverride: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
  /** Draft-block edits keyed by block id (the PR body / handoff draft blocks). */
  readonly draftEdits: Readonly<Record<string, string>>;
}

export interface ReviewSlice {
  readonly review: ReviewState;
  readonly reviewActions: {
    stageAsk(ask: StagedAsk): void;
    /** Remove a staged ask by its `id`, and drop any inline edit keyed to that id (so a later
     *  ask staged at the same anchor never inherits it). */
    unstageAsk(id: string): void;
    setCodeComment(path: string, line: number, body: string): void;
    clearCodeComment(path: string, line: number): void;
    /** Mint a quote thread on `anchor` with `text` as the opener; returns the new thread
     *  id. `scope` carries the board-anchor identity (target element + generation) so the
     *  durable highlight lands only on that element in that generation (finding 2). */
    addQuoteComment(
      anchor: string,
      text: string,
      kind?: "comment" | "explain",
      scope?: QuoteScope,
    ): string;
    /** Append a reply to an existing thread (no-op if the thread is gone). */
    addQuoteReply(threadId: string, author: "user" | "orchestrator", text: string): void;
    /** Drop a quote thread. */
    removeQuoteComment(threadId: string): void;
    setFocusedThread(threadId: string | null): void;
    /** Retire a staged ask WHOLE (dropped/deleted) with its reason — dedup by `ask.id`. */
    retire(ask: StagedAsk, reason: string): void;
    /** Restore a retired ask by its `id` — removes it from the ledger (the caller re-stages). */
    restoreRetired(id: string): void;
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
        review: { ...s.review, stagedAsks: { ...s.review.stagedAsks, [ask.id]: ask } },
      })),
    unstageAsk: (id) =>
      set((s) => {
        const rest = { ...s.review.stagedAsks };
        delete rest[id];
        // Drop the inline edit keyed to this id too, so a later ask at the same anchor (a fresh id,
        // or this id reused by a stable-id site) never inherits a withdrawn ask's edit.
        const draftEdits = { ...s.review.draftEdits };
        delete draftEdits[id];
        return { review: { ...s.review, stagedAsks: rest, draftEdits } };
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
    addQuoteComment: (anchor, text, kind, scope) => {
      const id = nextQuoteThreadId();
      set((s) => ({
        review: {
          ...s.review,
          quoteThreads: {
            ...s.review.quoteThreads,
            [id]: {
              anchor,
              kind,
              ...(scope?.target === undefined ? {} : { target: scope.target }),
              ...(scope?.generation === undefined ? {} : { generation: scope.generation }),
              messages: [{ author: "user", text }],
            },
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
    retire: (ask, reason) =>
      set((s) => ({
        review: {
          ...s.review,
          retired: [...s.review.retired.filter((e) => e.ask.id !== ask.id), { ask, reason }],
        },
      })),
    restoreRetired: (id) =>
      set((s) => ({
        review: { ...s.review, retired: s.review.retired.filter((e) => e.ask.id !== id) },
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
/** The staged ask with `id`, or undefined. */
export const selectStagedAsk =
  (id: string) =>
  (s: RennetState): StagedAsk | undefined =>
    s.review.stagedAsks[id];
/** The per-line code comment on `path:line`, or undefined. */
export const selectCodeComment =
  (path: string, line: number) =>
  (s: RennetState): string | undefined =>
    s.review.codeComments[path]?.[line];
/** Every code comment on `path`, keyed by line — the map a code surface renders from. */
export const selectCodeComments =
  (path: string) =>
  (s: RennetState): Readonly<Record<number, string>> | undefined =>
    s.review.codeComments[path];
