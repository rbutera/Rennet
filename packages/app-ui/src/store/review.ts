import {
  type AskProjection,
  type CodeRef,
  type CommandInput,
  type FindingRef,
  findingRefKey,
} from "@rennet/protocol";
import type { StateCreator } from "zustand";
import type { RennetState } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The `review` slice (C01 §3): the reviewer's interaction state for an open review —
// staged asks, finding dispositions, per-line code comments, quote threads, the focused
// thread, the retired ledger, a verdict override, and draft-block edits.
//
// THE DURABLE ASK LOG IS THE SOURCE OF TRUTH; this slice is its render-side cache. Every
// mutator that touches durable state writes through the ONE server write path — the
// `ask.*` commands in `server/src/dispatch/ask.ts`, whose handlers append to the review's
// event log — and `hydrateAsks` REPLACES the durable half wholesale from `ask.read`'s
// projection. `useAskLog` (review/ask-log.ts) installs the writer and drives the
// hydration; a slice with no writer installed (a unit mount, a fixture-seeded store)
// simply keeps its local state, exactly as it did before.
//
// This is what makes the three wired exits work at all. `publish.compose`,
// `round.dispatch` and `review.reviseSpan` each read `askLog.readProjection(reviewId)`
// and nothing else — a client that staged only into this slice left all three reading an
// empty log, so a composed review lost the reviewer-authored asks, a dispatched round carried
// an empty work order, and every ask was "no longer staged". It is also what makes a reload keep
// the reviewer's work: the projection outlives the renderer.
//
// `focusedThreadId` and `draftEdits` stay CLIENT-TRANSIENT by contract (the durable-asks
// shapes in `protocol/src/session/ask-log.ts` name them as the two exceptions) — they are
// not in the projection, so they are not written through and not hydrated.
//
// DERIVE, DON'T STORE: counts, tallies, and highlights are selectors over this slice +
// the projection cache — never fields.
// ─────────────────────────────────────────────────────────────────────────────

/** The `ask.*` WRITE commands (every one but the `ask.read` projection read). */
export type AskWriteCommand =
  | "ask.stage"
  | "ask.unstage"
  | "ask.dismissFinding"
  | "ask.restoreFinding"
  | "ask.retire"
  | "ask.restore"
  | "ask.quoteOpen"
  | "ask.quoteReply"
  | "ask.quoteClose"
  | "ask.setVerdictOverride"
  | "ask.setLineComment"
  | "ask.clearLineComment";

/**
 * The durable write sink the slice fires on every mutation. `sessionId` is NOT a parameter:
 * the ask log's session id IS the open review's id, and the installer (`useAskLog`) binds it
 * once — so no surface can write an ask into another review's log.
 */
export type AskWriter = <K extends AskWriteCommand>(
  name: K,
  input: Omit<CommandInput<K>, "sessionId">,
) => void;

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
  /** The diff side for a code anchor; absent preserves legacy right-side behavior. */
  readonly side?: "LEFT" | "RIGHT";
  /** The immutable captured code position; `anchor` + `side` are the legacy fallback. */
  readonly codeRef?: CodeRef;
  /**
   * The quote thread this ask CLAIMS, when it was minted alongside one (prose
   * request-change). Kept distinct from `anchor` (the source provenance) so an exit
   * tally counts the claimed thread once — via this ask — instead of twice.
   */
  readonly threadId?: string;
  /** The immutable board finding that originated this ask, when applicable. */
  readonly finding?: FindingRef;
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

export type CodePositionSide = "LEFT" | "RIGHT";

/** The side-qualified position identity shared by staged-ask overlays and exit collation. */
export interface CodePosition {
  readonly path: string;
  readonly line: number;
  readonly side: CodePositionSide;
}

/** Resolve canonical provenance first, retaining `anchor` + `side` for older ask logs. */
export function stagedAskCodePosition(ask: StagedAsk): CodePosition | null {
  if (ask.codeRef !== undefined) {
    return {
      path: ask.codeRef.path,
      line: ask.codeRef.startLine,
      side: ask.codeRef.side === "base" ? "LEFT" : "RIGHT",
    };
  }
  const match = /^(.+):(\d+)$/.exec(ask.anchor);
  if (!match?.[1] || !match[2]) return null;
  return {
    path: match[1],
    line: Number(match[2]),
    side: ask.side ?? "RIGHT",
  };
}

/** Stable identity for a diff position. */
export function codePositionKey(position: CodePosition): string {
  return `${position.path}:${position.line}:${position.side}`;
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

function nextQuoteThreadId(threads: Readonly<Record<string, QuoteThread>>): string {
  let id: string;
  do {
    id = `qt-${crypto.randomUUID()}`;
  } while (threads[id] !== undefined);
  return id;
}

export interface ReviewState {
  /** Staged asks keyed by ask `id` (identity), NOT anchor — so same-anchor asks coexist. */
  readonly stagedAsks: Readonly<Record<string, StagedAsk>>;
  /** Reviewer dismissals over immutable finding bytes, keyed by generation + finding id. */
  readonly findingDispositions: AskProjection["findingDispositions"];
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
    /**
     * Install (or clear, with `null`) the durable write sink. `useAskLog` calls this for the
     * open review and clears it on unmount, so a mutator fired between reviews writes nowhere
     * rather than into the previous review's log.
     */
    setAskWriter(writer: AskWriter | null): void;
    /**
     * Replace the durable half of the slice from the server's projection — the session-open /
     * reconnect rehydrate. A REPLACE, never a merge: the log is the source of truth, so a
     * local value the projection does not carry is a value the server does not have.
     */
    hydrateAsks(projection: AskProjection): void;
    stageAsk(ask: StagedAsk): void;
    /** Remove a staged ask by its `id`, and drop any inline edit keyed to that id (so a later
     *  ask staged at the same anchor never inherits it). */
    unstageAsk(id: string): void;
    dismissFinding(finding: FindingRef): void;
    restoreFinding(finding: FindingRef): void;
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
  findingDispositions: {},
  codeComments: {},
  quoteThreads: {},
  focusedThreadId: null,
  retired: [],
  verdictOverride: null,
  draftEdits: {},
};

export const createReviewSlice: StateCreator<RennetState, [], [], ReviewSlice> = (set, get) => {
  // The write sink lives in the SLICE CLOSURE, not in `review` state: it is a seam, not
  // something a surface renders, and the store's delete-on-sight rule keeps render state to
  // what a selector could derive. One sink per `createRennetStore()`, so a test store can
  // never write through the app singleton's bridge.
  let sink: AskWriter | null = null;
  const durable: AskWriter = (name, input) => sink?.(name, input);

  return {
    review: initialReview,
    reviewActions: {
      setAskWriter: (writer) => {
        sink = writer;
      },
      hydrateAsks: (projection) =>
        set((s) => ({
          review: {
            ...s.review,
            stagedAsks: projection.stagedAsks,
            findingDispositions: projection.findingDispositions,
            // JSON object keys are strings, and `obj[10]` and `obj["10"]` address the same
            // value — so the projection's `path → "line" → body` IS this slice's
            // `path → line → body` at runtime (the ask-log contract says so in as many words).
            codeComments: projection.lineComments as ReviewState["codeComments"],
            quoteThreads: projection.quoteThreads,
            // The projection keys `retired` by ask id (dedup-by-id made structural); the slice
            // renders it as a list, newest last.
            retired: Object.values(projection.retired),
            verdictOverride: projection.verdictOverride,
          },
        })),
      // ── The durable mutators ───────────────────────────────────────────────
      // Each applies LOCALLY (the surfaces are synchronous click handlers) and writes the
      // matching `ask.*` event through the sink. The local apply and the server fold are the
      // same operation on the same shapes, so they agree; the next `hydrateAsks` settles any
      // disagreement in the log's favour.
      stageAsk: (ask) => {
        durable("ask.stage", { ask });
        set((s) => ({
          review: { ...s.review, stagedAsks: { ...s.review.stagedAsks, [ask.id]: ask } },
        }));
      },
      unstageAsk: (id) => {
        durable("ask.unstage", { id });
        set((s) => {
          const rest = { ...s.review.stagedAsks };
          delete rest[id];
          // Drop the inline edit keyed to this id too, so a later ask at the same anchor (a fresh id,
          // or this id reused by a stable-id site) never inherits a withdrawn ask's edit.
          const draftEdits = { ...s.review.draftEdits };
          delete draftEdits[id];
          return { review: { ...s.review, stagedAsks: rest, draftEdits } };
        });
      },
      dismissFinding: (finding) => {
        durable("ask.dismissFinding", { finding });
        set((s) => ({
          review: {
            ...s.review,
            findingDispositions: {
              ...s.review.findingDispositions,
              [findingRefKey(finding)]: { finding, disposition: "dismissed" },
            },
          },
        }));
      },
      restoreFinding: (finding) => {
        durable("ask.restoreFinding", { finding });
        set((s) => {
          const findingDispositions = { ...s.review.findingDispositions };
          delete findingDispositions[findingRefKey(finding)];
          return { review: { ...s.review, findingDispositions } };
        });
      },
      setCodeComment: (path, line, body) => {
        durable("ask.setLineComment", { path, line, body });
        set((s) => ({
          review: {
            ...s.review,
            codeComments: {
              ...s.review.codeComments,
              [path]: { ...s.review.codeComments[path], [line]: body },
            },
          },
        }));
      },
      clearCodeComment: (path, line) => {
        durable("ask.clearLineComment", { path, line });
        set((s) => {
          const forPath = s.review.codeComments[path];
          if (!forPath) return {};
          const restLines = { ...forPath };
          delete restLines[line];
          return {
            review: { ...s.review, codeComments: { ...s.review.codeComments, [path]: restLines } },
          };
        });
      },
      addQuoteComment: (anchor, text, kind, scope) => {
        const id = nextQuoteThreadId(get().review.quoteThreads);
        const thread = {
          anchor,
          ...(kind === undefined ? {} : { kind }),
          ...(scope?.target === undefined ? {} : { target: scope.target }),
          ...(scope?.generation === undefined ? {} : { generation: scope.generation }),
          messages: [{ author: "user" as const, text }],
        };
        durable("ask.quoteOpen", { threadId: id, thread });
        set((s) => ({
          review: { ...s.review, quoteThreads: { ...s.review.quoteThreads, [id]: thread } },
        }));
        return id;
      },
      addQuoteReply: (threadId, author, text) => {
        durable("ask.quoteReply", { threadId, author, text });
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
        });
      },
      removeQuoteComment: (threadId) => {
        durable("ask.quoteClose", { threadId });
        set((s) => {
          const rest = { ...s.review.quoteThreads };
          delete rest[threadId];
          return { review: { ...s.review, quoteThreads: rest } };
        });
      },
      // Client-transient by contract — the focused thread is not in the projection.
      setFocusedThread: (threadId) =>
        set((s) => ({ review: { ...s.review, focusedThreadId: threadId } })),
      retire: (ask, reason) => {
        // The server's `retire` withdraws the staged ask INTO the ledger in one event; the
        // client splits the same act across `retire` + `unstageAsk`, and the fold is total, so
        // the following `ask.unstage` on an already-withdrawn id is a no-op.
        durable("ask.retire", { id: ask.id, reason });
        set((s) => ({
          review: {
            ...s.review,
            retired: [...s.review.retired.filter((e) => e.ask.id !== ask.id), { ask, reason }],
          },
        }));
      },
      restoreRetired: (id) => {
        durable("ask.restore", { id });
        set((s) => ({
          review: { ...s.review, retired: s.review.retired.filter((e) => e.ask.id !== id) },
        }));
      },
      setVerdictOverride: (verdict) => {
        durable("ask.setVerdictOverride", { verdict });
        set((s) => ({ review: { ...s.review, verdictOverride: verdict } }));
      },
      // Client-transient by contract — the PR-body draft blocks are not in the projection.
      setDraftEdit: (blockId, body) =>
        set((s) => ({
          review: { ...s.review, draftEdits: { ...s.review.draftEdits, [blockId]: body } },
        })),
      resetReview: () => set(() => ({ review: initialReview })),
    },
  };
};

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
