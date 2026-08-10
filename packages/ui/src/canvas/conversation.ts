import type { AskMode } from "@rennet/types";
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
// SCOPE (issue #36, this slice): the thread/message MODEL + the anchored UI, driven
// by FIXTURE messages behind the real typed boundary (mirroring #138/#139). The
// LIVE streaming machinery — real token streaming from the orchestrator/harness,
// session persistence, re-attach, orphan reaping — is the DEFERRED follow-up. The
// model is shaped so that live streaming appends real `ThreadMessage`s later with
// no change here.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package: nothing here
// imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

export type { AskMode } from "@rennet/types";

/**
 * What a conversation is anchored to. Line + chunk are this slice's floor; a
 * dragged range and a conversation fragment ride the same shape (the issue's
 * "verbs times anchors", the subset of #109's `DispositionAnchorKind` that a
 * conversation attaches to).
 */
export type ConversationAnchorKind = "line" | "range" | "chunk" | "fragment";

/**
 * The anchor a thread hangs on. `label` is the human string ("src/rate/bucket.ts");
 * `key` is the stable ALIGNMENT key the right margin lines a thread up against (a
 * line/range/chunk id). The diff column never reads `key`, so a thread opening or
 * growing cannot move the code.
 */
export interface ConversationAnchor {
  readonly kind: ConversationAnchorKind;
  readonly label: string;
  readonly key: string;
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
    label: "src/rate/bucket.ts",
    key: "src/rate/bucket.ts#L44-47",
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
