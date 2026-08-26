import type { AnchorSide, AskMode } from "@rennet/protocol";
import { DEFAULT_ASK_MODE } from "./ask";

// ─────────────────────────────────────────────────────────────────────────────
// The INLINE CONVERSATION model (issue #36 — the review heart's private research
// chat) — pure functions, no React, no DOM.
//
// This is the "discuss / ask-the-harness" verb of the inline conversation cluster.
// #109 owns the four disposition verbs (approve / request-change / comment /
// question) and the ink/blue staging law; #139 owns the review.ask WIRE (one model
// or both). THIS module owns the private research CONVERSATION anchored on any
// anchor, and the thread/message model behind it.
//
// The three load-bearing laws (issue #36):
//
//   • PRIVATE BY DEFAULT (blue / backlight). A research conversation STAYS on this
//     machine and never leaves. There is no "ink" thread: a thread's lane is always
//     blue. The ONLY path from private to published is a PROMOTION — a deliberate
//     user act that lifts one message into a finding or a draft comment. Thread
//     content is structurally excluded from every publish payload (there is no
//     function here that puts a message body into a payload; only `promoteMessage`
//     produces something that crosses the boundary).
//
//   • ROUTE TO THE ORCHESTRATOR BY DEFAULT. A question raised in a thread goes to
//     the one harness you converse with (`DEFAULT_ASK_MODE`, #139), not auto-fired
//     to a second model. The per-message "ask both" opt-in is #139's; a fresh
//     thread starts at the orchestrator-only default.
//
//   • THE DIFF NEVER REFLOWS. Threads live in the RIGHT MARGIN, keyed to their
//     anchor. `threadMarginKey` / `groupThreadsByAnchor` are that layout's pure
//     core: the margin aligns to a thread's anchor key, and the diff column never
//     consults it — so opening or growing a thread changes only the margin, and the
//     diff column stays a fixed point.
//
// SCOPE (issue #36, this slice): the thread/message MODEL + the anchored UI. Live
// answers are real (`review.ask` per turn); the anchoring facet (line/range/chunk/
// fragment discuss + right-margin threads) is wired.
//
// ⛔ DEFERRED, TRACKED AS ISSUE #251 (split from #36, criteria 3+4): the two-channel
// token STREAMING machinery, `PersistedThread` session persistence, re-attach, and
// orphan reaping. It is a separate branch, not an oversight — none of it exists in
// the tree yet (the `orphan`/`PersistedThread` matches elsewhere are mark-orphans and
// snapshot overlays, unrelated). The whole of #251 is only observable in the FAILURE
// case (a crash mid-stream, a killed app), so its evidence must come from actually
// interrupting things. The model is shaped so live streaming appends real
// `ThreadMessage`s later with no change here — the streaming seam is `answerInThread`.
//
// The `layer:ui` boundary allows only `@rennet/protocol` + this package: nothing here
// imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

export type { AskMode } from "@rennet/protocol";

/**
 * What a conversation is anchored to. Line + chunk are this slice's floor; a
 * dragged range and a conversation fragment ride the same shape (the issue's
 * "verbs times anchors", the subset of #109's `DispositionAnchorKind` that a
 * conversation attaches to).
 */
export type ConversationAnchorKind = "line" | "range" | "chunk" | "fragment";

/**
 * The anchor a thread hangs on. `label` is the human string ("src/rate/bucket.ts");
 * `key` is the stable ALIGNMENT key the right margin lines a thread up against. The
 * diff column never reads `key`, so a thread opening or growing cannot move the code.
 *
 * `side` and `context` are SEMANTIC identity, not decoration (issue #36 F1/F2): the
 * key alone is opaque to the model, so what actually reaches `review.ask` is these
 * fields via `buildConversationQuestion`. Without them a question on a deleted line
 * and a question on the added line at the same number are byte-identical, and a
 * fragment thread cannot say which sentence it hangs off.
 */
export interface ConversationAnchor {
  readonly kind: ConversationAnchorKind;
  readonly label: string;
  readonly key: string;
  /** Which diff side a line/range anchors to (F1) — carried INTO the question, not just the key. */
  readonly side?: AnchorSide;
  /** The text this anchor refers to — the fragment's parent message (F2), so it travels with it. */
  readonly context?: string;
  /**
   * The FILE this anchor hangs on (#251, slice 3). Carried explicitly rather than parsed
   * back out of `key` — a path may contain the key's `|` delimiter, so the key is
   * deliberately not back-parseable. Used ONLY to resolve orphaning on re-attach: a thread
   * whose `path` is gone from the current diff is orphaned. ABSENT for a conversation
   * fragment (it anchors to a message, not code) — such a thread never orphans on a code change.
   */
  readonly path?: string;
}

// ── Injective anchor keys: the KIND is carried, never implied by shape (F4) ──────
//
// Why each key is collision-proof, precisely (not "paths never contain `|`" — they
// can; `we|ird.ts` is a legal filename):
//   • Cross-kind: every key is KIND-PREFIXED, so a chunk key can never equal a line
//     key regardless of contents.
//   • line / range: within their kind the trailing fields are FIXED-SHAPE — `side` is
//     one of a closed set and the line numbers are digits — so the key right-parses
//     unambiguously even when the path itself contains `|`.
//   • fragment: BOTH components are unconstrained strings, so a raw `|` join WOULD
//     collide (`("a|b","c")` == `("a","b|c")`). It is therefore JSON-encoded, which is
//     unambiguous for any two strings — the key is INCAPABLE of colliding, not merely
//     unlikely to (the callers happen to pass UUIDs today, but the key does not rely on
//     that undocumented property).

/** The alignment key for a diff-LINE anchor — injective over (kind, path, side, line). */
export function lineAnchorKey(path: string, side: AnchorSide, line: number): string {
  return `line|${path}|${side}|${line}`;
}

/** The alignment key for a RANGE anchor — injective over (kind, path, side, start, end). */
export function rangeAnchorKey(path: string, side: AnchorSide, start: number, end: number): string {
  return `range|${path}|${side}|${start}|${end}`;
}

/** The alignment key for a CHUNK anchor — injective over (kind, path). */
export function chunkAnchorKey(path: string): string {
  return `chunk|${path}`;
}

/**
 * The alignment key for a FRAGMENT anchor — injective over (kind, parent thread,
 * message). Both components are unconstrained strings, so the tuple is JSON-encoded
 * rather than `|`-joined: `("a|b","c")` and `("a","b|c")` produce DIFFERENT keys.
 */
export function fragmentAnchorKey(parentThreadId: string, messageId: string): string {
  return `fragment|${JSON.stringify([parentThreadId, messageId])}`;
}

/**
 * A single discuss REQUEST — an anchor plus a unique occurrence `id` (issue #36). The
 * id is what dedups an opening (idempotent under a re-passed list), NOT the anchor key:
 * `anchor.key` is reserved for ALIGNMENT and GROUPING in the right margin. So two
 * discuss actions on the SAME line are two requests with the same key and DIFFERENT
 * ids, and each opens its own thread — a second discussion on a line is a real second
 * thread, never silently collapsed into the first.
 */
export interface DiscussRequest {
  readonly id: string;
  readonly anchor: ConversationAnchor;
}

/** Who authored a message: the reviewer ("you") or the harness (a model). */
export type MessageAuthor = "you" | "harness";

/**
 * One message in a thread. `model` labels a harness card ("Claude Code"); it is
 * absent for a "you" message. `body` is rendered verbatim. Live streaming (deferred)
 * appends completed messages of exactly this shape — the coalesced token deltas are
 * never persisted, only the one durable message on completion.
 */
export interface ThreadMessage {
  readonly id: string;
  readonly author: MessageAuthor;
  /** The harness/model label shown on a harness card; absent for "you". */
  readonly model?: string;
  readonly body: string;
  /**
   * The turn's lifecycle (issue #251). ABSENT means `complete` — every #36 message,
   * and every durable answer, omits it. `streaming` is the live-coalescing message;
   * `interrupted` is a turn whose process died mid-stream. See {@link TurnStatus}.
   */
  readonly status?: TurnStatus;
}

/**
 * A thread's lane. There is exactly ONE value — `blue` — because a research
 * conversation is always private. This is not a `comment`/`question` staging flag
 * (those are #109's, and they DO have an ink lane): a thread NEVER travels. The type
 * having a single member is the structural guarantee.
 */
export type ThreadLane = "blue";

/** The single lane a thread can occupy: private/backlight, local-only. */
export const THREAD_LANE: ThreadLane = "blue";

/**
 * A private research conversation anchored on a line / range / chunk / fragment.
 * `lane` is always blue; `route` is the default routing for a new question (the
 * orchestrator). `messages` is append-only in practice (open → ask → answer).
 */
export interface ConversationThread {
  readonly id: string;
  readonly anchor: ConversationAnchor;
  /** Always `blue`: a thread is private and never travels to the PR. */
  readonly lane: ThreadLane;
  /** The default routing for a NEW question in this thread — the orchestrator (#139). */
  readonly route: AskMode;
  readonly messages: readonly ThreadMessage[];
  /**
   * ORPHANED (issue #251): on re-attach, this thread's anchor no longer resolved against
   * the current diff. ABSENT means placed. Set only via {@link markOrphaned}, which never
   * changes the anchor — the thread is surfaced as orphaned, never re-anchored.
   */
  readonly orphaned?: boolean;
}

// ── Opening + growing a thread ────────────────────────────────────────────────

/**
 * Open a fresh PRIVATE thread on an anchor. Always blue, always orchestrator-routed
 * by default (#139), with no messages yet. This is the "discuss / ask-the-harness"
 * verb applied to an anchor: a thread can be opened on a line, a range, a chunk, or
 * a conversation fragment, and they are all this one shape.
 */
export function openThread(
  id: string,
  anchor: ConversationAnchor,
  route: AskMode = DEFAULT_ASK_MODE,
): ConversationThread {
  return { id, anchor, lane: THREAD_LANE, route, messages: [] };
}

/** Append a message to a thread (pure; returns a new thread). */
export function addMessage(thread: ConversationThread, message: ThreadMessage): ConversationThread {
  return { ...thread, messages: [...thread.messages, message] };
}

/**
 * Ask a question in a thread — append a "you" message. The harness answer arrives
 * separately (live: streamed and appended on completion; here: a fixture message).
 * Splitting ask from answer is what lets the deferred streaming append the reply
 * with no shape change.
 */
export function askInThread(
  thread: ConversationThread,
  messageId: string,
  body: string,
): ConversationThread {
  return addMessage(thread, { id: messageId, author: "you", body });
}

/**
 * Append a harness answer to a thread (the fixture / eventual live-stream reply).
 * `model` is the harness label shown on the card.
 */
export function answerInThread(
  thread: ConversationThread,
  messageId: string,
  model: string,
  body: string,
): ConversationThread {
  return addMessage(thread, { id: messageId, author: "harness", model, body });
}

/** The default routing for a thread's next question (the orchestrator, by default). */
export function threadRoute(thread: ConversationThread): AskMode {
  return thread.route;
}

// ── Composing the LIVE question the orchestrator answers ──────────────────────
//
// The live boundary is `review.ask` (#139): ONE question about the review → ONE
// orchestrator turn. That turn is STATELESS — it carries no session memory across
// asks — so a multi-turn conversation's context cannot live in the harness; it must
// travel INSIDE the question. `buildConversationQuestion` is that pure carrier: it
// folds the thread's ANCHOR (which file / lines the reviewer is discussing) and the
// conversation SO FAR into the string handed to `review.ask`, then appends the new
// message. Each turn is therefore genuinely live (a real orchestrator turn) AND
// genuinely contextual (the orchestrator sees the whole thread), with no invented
// streaming transport and no server-side session.

/** How a message's author is labelled in the folded conversation transcript. */
function messageSpeaker(message: ThreadMessage): string {
  return message.author === "you" ? "You" : (message.model ?? "Assistant");
}

/**
 * The scope sentence the model reads — the SEMANTIC anchor, not the opaque key (F1/F2).
 * Carries the diff SIDE (so a question on a deleted line is not answered about the
 * added line at the same number) and the fragment's referenced TEXT (so a sub-thread
 * says which sentence it hangs off). These are the two hops where the value is finally
 * consumed; encoding them only in the key never reached the model.
 */
function anchorScope(anchor: ConversationAnchor): string {
  let scope = `The reviewer is discussing ${anchor.kind} ${anchor.label} in this code review.`;
  if (anchor.side !== undefined) {
    const sideName =
      anchor.side === "deletions"
        ? "the REMOVED (old / left) side of the diff"
        : anchor.side === "additions"
          ? "the ADDED (new / right) side of the diff"
          : "the unchanged (context) side of the diff";
    scope += ` The anchor is on ${sideName}.`;
  }
  if (anchor.context !== undefined && anchor.context.trim() !== "") {
    scope += ` It refers to this specific text: "${anchor.context.trim()}".`;
  }
  return scope;
}

/**
 * Build the `review.ask` question for the next turn of a thread. Pure and
 * deterministic: the anchor scopes the question to the discussed lines, the prior
 * messages carry the conversation's context (so a follow-up is answered IN context),
 * and `body` is the new question. With no prior messages it is a plain first ask; with
 * prior messages it prepends the transcript so the stateless orchestrator turn still
 * answers as a continuation. `body` is trimmed by the caller (the composer already
 * trims); this function does not re-trim or validate — it only composes.
 */
export function buildConversationQuestion(
  anchor: ConversationAnchor,
  priorMessages: readonly ThreadMessage[],
  body: string,
): string {
  const scope = anchorScope(anchor);
  if (priorMessages.length === 0) {
    return `${scope}\n\nThe reviewer asks: ${body}`;
  }
  const transcript = priorMessages
    .map((message) => `${messageSpeaker(message)}: ${message.body}`)
    .join("\n\n");
  return `${scope}\n\nConversation so far:\n${transcript}\n\nThe reviewer now asks: ${body}`;
}

// ── The privacy boundary: promotion is the ONLY path out ──────────────────────

/** Every thread is private. A thread never has an "ink" lane; only promotions travel. */
export function isPrivate(thread: ConversationThread): boolean {
  return thread.lane === THREAD_LANE;
}

/** What a promoted message becomes: a finding, or a draft comment on the PR. */
export type PromotionKind = "finding" | "draft-comment";

/**
 * The event a promotion produces — the ONLY thing that crosses the private→published
 * boundary. It carries the promoted message's body and the thread's anchor (so the
 * finding / draft comment lands where the conversation happened). The thread ITSELF
 * is never mutated by a promotion: it stays private, and this event is a copy that
 * leaves.
 */
export interface PromotionEvent {
  readonly threadId: string;
  readonly messageId: string;
  readonly kind: PromotionKind;
  readonly anchor: ConversationAnchor;
  readonly body: string;
}

/**
 * Promote one message in a thread to a finding or draft comment — a DELIBERATE user
 * act. Returns the event that crosses the publish boundary, or `null` if the message
 * is not in the thread. The thread is NOT changed: promotion copies a message out; it
 * does not turn the private thread public. This is the sole private→published path.
 */
export function promoteMessage(
  thread: ConversationThread,
  messageId: string,
  kind: PromotionKind,
): PromotionEvent | null {
  const message = thread.messages.find((entry) => entry.id === messageId);
  if (!message) return null;
  return {
    threadId: thread.id,
    messageId,
    kind,
    anchor: thread.anchor,
    body: message.body,
  };
}

/**
 * The thread-content slice of ANY publish payload — always EMPTY. Thread messages are
 * structurally excluded from what travels to the PR: there is no code path that reads
 * `thread.messages` into a payload. A published review is built from promotion events
 * (`promoteMessage`) alone, never from thread content. This function makes that
 * exclusion explicit and testable: whatever the threads hold, none of it publishes.
 */
export function threadContentForPublish(threads: readonly ConversationThread[]): readonly never[] {
  // Structural exclusion: every thread maps to NOTHING. No `thread.messages` is ever
  // read into a payload — a private conversation cannot travel; only promotions do.
  return threads.flatMap(() => [] as never[]);
}

// ── Right-margin placement: the diff column never reflows ─────────────────────

/** The alignment key the right margin lines a thread up against (its anchor key). */
export function threadMarginKey(thread: ConversationThread): string {
  return thread.anchor.key;
}

/**
 * Group threads by their anchor key, preserving first-seen order — the right margin's
 * layout core. The margin renders one column of thread panels keyed by anchor; the
 * diff column is a sibling that never reads this grouping, so opening or growing a
 * thread changes only the margin. "The diff column is a fixed point that never moves."
 */
export function groupThreadsByAnchor(
  threads: readonly ConversationThread[],
): Map<string, ConversationThread[]> {
  const groups = new Map<string, ConversationThread[]>();
  for (const thread of threads) {
    const key = threadMarginKey(thread);
    const bucket = groups.get(key);
    if (bucket) bucket.push(thread);
    else groups.set(key, [thread]);
  }
  return groups;
}

// ── Turn lifecycle + durability (issue #251) ──────────────────────────────────
//
// #36 shipped a thread whose harness messages are all COMPLETE. #251 adds the two
// interrupted-observable states around them, and keeps the privacy law untouched:
// none of this reads a message body into a payload; only `promoteMessage` still does.

/**
 * The lifecycle of a harness turn. A durable, completed answer has NO status (every
 * #36 message is therefore `complete` by omission — back-compat). `streaming` is the
 * live-coalescing message (renderer-only, never persisted). `interrupted` is a turn
 * whose process died mid-stream: it is surfaced honestly and is NEVER upgraded to a
 * fabricated `complete` (that upgrade is the exact failure the crash-recovery transform
 * forbids).
 */
export type TurnStatus = "streaming" | "complete" | "interrupted";

/** A completed durable message (status omitted) is `complete`. */
export function isComplete(message: ThreadMessage): boolean {
  return message.status === undefined || message.status === "complete";
}

/** A live-coalescing message (renderer-only; its body grows as deltas arrive). */
export function isStreaming(message: ThreadMessage): boolean {
  return message.status === "streaming";
}

/** A turn that never completed — the process died mid-stream. Surfaced, never faked. */
export function isInterrupted(message: ThreadMessage): boolean {
  return message.status === "interrupted";
}

/**
 * The marker for a turn that was interrupted before completion. Carries whatever partial
 * text had streamed (or none), STATUS-flagged so the UI shows it as interrupted rather
 * than as an answer. It is not a durable answer and must never be promoted as one.
 */
export function interruptedTurn(messageId: string, model: string, partial = ""): ThreadMessage {
  return { id: messageId, author: "harness", model, body: partial, status: "interrupted" };
}

/**
 * Mark a thread ORPHANED — its anchor no longer resolves against the current diff (#251).
 * The thread's content is preserved and its anchor is UNCHANGED: orphaning surfaces the
 * loss, it does not re-point the thread at whatever code now occupies the anchor key.
 * Re-anchoring is the disposition-carry failure class (a human's words on code they never
 * wrote them about), so there is deliberately no `reAnchor` here — only this honest flag.
 */
export function markOrphaned(thread: ConversationThread): ConversationThread {
  return { ...thread, orphaned: true };
}

/** Whether a thread is orphaned (anchor no longer resolves). Absent flag = placed. */
export function isOrphaned(thread: ConversationThread): boolean {
  return thread.orphaned === true;
}

/**
 * Resolve each thread's placement against the current diff's file paths (#251, slice 3),
 * stamping ORPHANED any whose anchored file is gone. This is the ONLY resolution step: it
 * flags, it never RE-ANCHORS (there is no re-anchor function — the refusal is structural),
 * so a human's words are never silently moved onto code they were not written about. A
 * thread whose anchor has no `path` (a conversation fragment) anchors to the conversation,
 * not to code, so a code change cannot orphan it and it is left placed. Pure and total.
 */
export function orphanUnresolvedThreads(
  threads: readonly ConversationThread[],
  currentPaths: ReadonlySet<string>,
): ConversationThread[] {
  return threads.map((thread) => {
    const path = thread.anchor.path;
    if (path === undefined || currentPaths.has(path)) return thread;
    return markOrphaned(thread);
  });
}

// ── Two-channel token streaming under an injected clock (issue #251) ───────────
//
// Token deltas arrive faster than the DOM should repaint, so they are COALESCED. The
// BODY is a deterministic concatenation with NO clock dependence; the injected clock
// (`now` + `throttleMs`) governs only how often a repaint is signalled. That split is
// the whole testable contract: replay the same deltas under a hand-advanced fake clock
// and the body is byte-identical every run, while the repaint count tracks the clock.

/** The channel a streamed answer arrives on — the orchestrator, or Codex's second opinion. */
export type StreamChannel = "orchestrator" | "codex";

/** One channel's coalescing state: the accumulated body and when it last repainted. */
export interface CoalescerState {
  readonly body: string;
  readonly lastRepaintAt: number;
}

/** A fresh, empty coalescer state (no body, never repainted). */
export function emptyCoalescerState(): CoalescerState {
  return { body: "", lastRepaintAt: Number.NEGATIVE_INFINITY };
}

/**
 * The book of coalescer states, one per (turnId, channel). Immutable: every push returns
 * a new book, so a stray delta from a superseded turn cannot mutate a live one in place.
 */
export type CoalescerBook = ReadonlyMap<string, CoalescerState>;

/** An empty coalescer book. */
export function emptyCoalescerBook(): CoalescerBook {
  return new Map<string, CoalescerState>();
}

/**
 * The book key, injective over (turnId, channel). The tuple is JSON-encoded (the same
 * idiom `fragmentAnchorKey` uses for two unconstrained strings), so `[channel, turnId]`
 * and any other pair produce DIFFERENT keys for any string contents — two channels of the
 * SAME turn can never share a state. RED-proof: drop `channel` from this key and the
 * two-channel-independence test reddens (the two bodies collide into one).
 */
export function coalescerKey(turnId: string, channel: StreamChannel): string {
  return JSON.stringify([channel, turnId]);
}

/** The current coalesced body for a (turnId, channel), or "" if none has streamed. */
export function channelBody(book: CoalescerBook, turnId: string, channel: StreamChannel): string {
  return (book.get(coalescerKey(turnId, channel)) ?? emptyCoalescerState()).body;
}

/** The result of folding a delta: the new book, the channel's current body, and whether a
 *  repaint is DUE now (at least `throttleMs` since this channel last repainted). */
export interface CoalesceResult {
  readonly book: CoalescerBook;
  readonly body: string;
  readonly repaint: boolean;
}

/**
 * Fold one token `delta` for a (turnId, channel) at time `now`. The body ALWAYS accumulates
 * (`prev.body + delta`) with no dependence on the clock; `repaint` is due only when at least
 * `throttleMs` has elapsed since this channel's last repaint. The returned book is a copy —
 * the caller holds it, and a delta for a different (turnId, channel) leaves this one alone.
 */
export function pushDelta(
  book: CoalescerBook,
  turnId: string,
  channel: StreamChannel,
  delta: string,
  now: number,
  throttleMs: number,
): CoalesceResult {
  const key = coalescerKey(turnId, channel);
  const prev = book.get(key) ?? emptyCoalescerState();
  const body = prev.body + delta;
  const due = now - prev.lastRepaintAt >= throttleMs;
  const next: CoalescerState = { body, lastRepaintAt: due ? now : prev.lastRepaintAt };
  const nextBook = new Map(book);
  nextBook.set(key, next);
  return { book: nextBook, body, repaint: due };
}

/**
 * Force a final repaint of a channel's accumulated body — on `done` or `interrupted`, the
 * UI must paint the last bytes regardless of the throttle. Repaint is always true here.
 */
export function flushChannel(
  book: CoalescerBook,
  turnId: string,
  channel: StreamChannel,
  now: number,
): CoalesceResult {
  const key = coalescerKey(turnId, channel);
  const prev = book.get(key) ?? emptyCoalescerState();
  const next: CoalescerState = { body: prev.body, lastRepaintAt: now };
  const nextBook = new Map(book);
  nextBook.set(key, next);
  return { book: nextBook, body: prev.body, repaint: true };
}

// ── Fixture behind the real typed boundary (mirroring #138 / #139) ────────────

/**
 * A demo thread matching prototype frame `06-review-heart` (the "fail-open path"
 * conversation on lines 44-47). Returns REAL typed model objects, not ad-hoc UI
 * props — the fixture sits behind the same `ConversationThread` boundary the live
 * stream will fill, so the UI renders identically whether the messages came from a
 * fixture or (deferred) a real harness turn.
 */
export function demoConversationThread(): ConversationThread {
  const anchor: ConversationAnchor = {
    kind: "range",
    label: "src/rate/bucket.ts:44-47",
    key: rangeAnchorKey("src/rate/bucket.ts", "additions", 44, 47),
    side: "additions",
  };
  let thread = openThread("thread-fail-open", anchor);
  thread = askInThread(
    thread,
    "m1",
    "Why fail open? If the store is down, doesn't this switch off limiting exactly when load is weirdest?",
  );
  thread = answerInThread(
    thread,
    "m2",
    "Claude Code",
    'It follows the plan: "limiter outage must never become API outage." Failing closed turns every store blip into a 5xx storm for all 4,112 orgs. The window is observable via rate.store_error.',
  );
  return thread;
}
