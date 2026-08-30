// The durable-asks contract (B11 cluster 1, #458 R29–R36, Q15). The reviewer's
// staged asks, per-line comments, quote threads, retired ledger and verdict
// override live HOST-SIDE behind ONE write path — command → event log →
// projection — so they survive reload, with receipt-is-undo on every mutation.
// The client half is `app-ui/src/review/ask-log.ts` (`useAskLog`): the review
// route hydrates the `review` store slice from `ask.read` and every mutator in
// that slice writes through the matching `ask.*` command. The slice is the
// render-side CACHE of this projection, not a second source of truth.
//
// This file is shapes only: the projected state, the append-only event union,
// and the receipt each write returns. The pure fold + `receiptFor` live in
// `@rennet/core` (`exits/ask-projection`); the file-backed log lives in
// `@rennet/adapters` (`ask-log-store`); the command handlers (the sole writers)
// land in `@rennet/server` (B11 cluster 2). `focusedThreadId` and the PR-body
// `draftEdits` block map stay CLIENT-transient (task 1.1) — they are not here.
//
// The projection mirrors the client's authoritative shapes (`StagedAsk`,
// `RetiredEntry`, `QuoteThread`, `verdictOverride`) so C9 can swap the store
// slice for a read of this projection. One deliberate divergence: `retired` is
// a Record keyed by ask id, not an array — the client's own retire dedups "by
// `ask.id`", so the keyed structure IS that intent, and it makes receipt-is-undo
// exactly reversible (object equality ignores key order, an array's does not).

import { z } from "zod";
import { FindingRefSchema } from "../board/schema";
import { codeRefSchema } from "../delta/citations";
import { dispositionTypeSchema, forgeReviewEventSchema } from "../wire";

const id = z.string().min(1);
/** A 1-based file line — the key a per-line comment hangs on. */
const lineSchema = z.number().int().min(1);

/**
 * A staged ask — the reviewer's pending request-change/comment/question. Mirrors
 * `app-ui`'s `StagedAsk`: `id` is the stable identity the overlays key on;
 * `anchor` is the SOURCE provenance (a `path:line` or a quoted prose span), kept
 * distinct from `id` so two asks on one line stay separate; `threadId` is the
 * quote thread this ask claims when minted alongside one.
 */
export const StagedAskSchema = z.object({
  id,
  anchor: z.string().min(1),
  type: dispositionTypeSchema,
  body: z.string(),
  threadId: id.optional(),
  /**
   * The diff SIDE a code-anchored ask posts to (B11 finding 7). Additive/optional: absent
   * defaults to `RIGHT` (the post-image), the common case. A DELETION-side ask sets `LEFT`
   * so it posts on the pre-image line rather than the wrong side. Pre-B11 the disposition
   * compose (`reviewCommentsFromDispositions`) carried `side` (`deletions` → LEFT); the
   * durable staged-ask model must not flatten that away — so it round-trips here. The client
   * (C9) populates it when staging a deletion-side finding; a multi-line RANGE (`startLine <
   * line`) is a ledgered follow-up (`ReviewCommentInput` models a single line today).
   */
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  /** The canonical captured position. `anchor` + `side` remain the legacy fallback. */
  codeRef: codeRefSchema.optional(),
  /** The immutable board finding that originated this ask, when applicable. */
  finding: FindingRefSchema.optional(),
});
export type StagedAsk = z.infer<typeof StagedAskSchema>;

/**
 * A retired draft block — the ask the reviewer withdrew, kept WHOLE with the
 * reason it left, so Restore re-stages it exactly (C08 §4.2). The ledger holds
 * the ask, not a bare id: an unstaged ask is gone from `stagedAsks`, so its
 * provenance must live here or restore cannot rebuild it.
 */
export const RetiredEntrySchema = z.object({
  ask: StagedAskSchema,
  reason: z.string(),
});
export type RetiredEntry = z.infer<typeof RetiredEntrySchema>;

/** One message in a quote thread — the reviewer's, or the orchestrator's reply. */
export const QuoteMessageSchema = z.object({
  author: z.enum(["user", "orchestrator"]),
  text: z.string(),
});
export type QuoteMessage = z.infer<typeof QuoteMessageSchema>;

const QuoteThreadBaseSchema = z.object({
  anchor: z.string(),
  kind: z.enum(["comment", "explain"]).optional(),
  messages: z.array(QuoteMessageSchema),
});

/**
 * A quote thread is either generic chat history or a board-scoped anchor. Scoped
 * threads carry target and generation together. A generation replacement marks
 * the thread detached when its quote has no unique successor, retaining the old
 * identity as provenance while preventing a stale highlight.
 *
 * `lifecycle` stays optional on the attached arm so existing logs parse as
 * attached. New events always write it explicitly.
 */
export const QuoteThreadSchema = z.union([
  QuoteThreadBaseSchema.extend({
    lifecycle: z.undefined().optional(),
    target: z.undefined().optional(),
    generation: z.undefined().optional(),
  }),
  // The former schema admitted either scope half independently. Keep those
  // records readable, but only the complete arm below is considered attached.
  QuoteThreadBaseSchema.extend({
    lifecycle: z.undefined().optional(),
    target: id,
    generation: z.undefined().optional(),
  }),
  QuoteThreadBaseSchema.extend({
    lifecycle: z.undefined().optional(),
    target: z.undefined().optional(),
    generation: id,
  }),
  QuoteThreadBaseSchema.extend({
    lifecycle: z.literal("attached").optional(),
    target: id,
    generation: id,
  }),
  QuoteThreadBaseSchema.extend({
    lifecycle: z.literal("detached"),
    target: id,
    generation: id,
  }),
]);
export type QuoteThread = z.infer<typeof QuoteThreadSchema>;

/** An explicit verdict override — the real GitHub review event, or null (derive). */
export const VerdictOverrideSchema = forgeReviewEventSchema;
export type VerdictOverride = z.infer<typeof VerdictOverrideSchema>;

/** A reviewer-owned overlay on immutable finding bytes. */
export const FindingDispositionSchema = z.object({
  finding: FindingRefSchema,
  disposition: z.literal("dismissed"),
});
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>;

/**
 * The projected ask state — the living set plus the retired ledger, folded from
 * the event log. Every collection is a Record keyed by identity (ask id, thread
 * id, or `path`→line): uniform, dedup-by-id, and order-insensitive under
 * equality (so receipt-is-undo reverses EXACTLY). `lineComments` is `path` →
 * stringified-line → body (JSON object keys are strings; a line reads back as its
 * decimal string, the same value `obj[10]`/`obj["10"]` address in the client).
 */
export const AskProjectionSchema = z.object({
  stagedAsks: z.record(id, StagedAskSchema),
  findingDispositions: z.record(z.string(), FindingDispositionSchema),
  lineComments: z.record(z.string().min(1), z.record(z.string(), z.string())),
  quoteThreads: z.record(id, QuoteThreadSchema),
  retired: z.record(id, RetiredEntrySchema),
  verdictOverride: VerdictOverrideSchema.nullable(),
});
export type AskProjection = z.infer<typeof AskProjectionSchema>;

// ── The append-only event union ──────────────────────────────────────────────
// One event per mutation; the log is the sole source of truth and the projection
// is `foldAsks(log)`, never a second stored copy. Each event's BODY (the kind +
// its fields) is what a receipt carries and a command handler builds; the STORE
// stamps `sessionId` + a monotonic `seq` on append. The union is closed under
// inversion — every kind's receipt is another kind in this union — so an undo is
// just one more appended event:
//
//   stage        ↔ unstage            (add / plain remove)
//   finding-dismiss ↔ finding-restore (board-attempt-scoped overlay / remove overlay)
//   retire       ↔ restore            (withdraw-to-ledger / re-stage from ledger)
//   edit         ↔ edit(prior body)   (self-inverse via prior value)
//   quote-open   ↔ quote-close        (mint / drop a thread)
//   quote-reply  ↔ quote-reply(prior) (a reply SETS the thread's message list)
//   verdict set  ↔ set(prior)/clear   (self-inverse via prior value)
//   line set     ↔ set(prior)/clear   (self-inverse via prior value)
//
// `unstage` sits beside `retire` on purpose: a toggle-off finding is a plain
// removal (no ledger entry, the client's `unstageAsk`), while `retire` is the
// deliberate withdraw-with-reason that Restore can bring back.

const askEventBodyVariants = [
  z.object({ kind: z.literal("stage"), ask: StagedAskSchema }),
  z.object({ kind: z.literal("unstage"), id }),
  z.object({ kind: z.literal("finding-dismiss"), finding: FindingRefSchema }),
  z.object({ kind: z.literal("finding-restore"), finding: FindingRefSchema }),
  z.object({ kind: z.literal("edit"), id, body: z.string() }),
  z.object({ kind: z.literal("retire"), id, reason: z.string() }),
  z.object({ kind: z.literal("restore"), id }),
  z.object({ kind: z.literal("quote-open"), threadId: id, thread: QuoteThreadSchema }),
  // A reply SETS the thread's whole message list (the handler appends; the event
  // records the result), so its receipt is `quote-reply(prior messages)` —
  // uniform with the other "set to prior value" inverses, no separate drop kind.
  z.object({ kind: z.literal("quote-reply"), threadId: id, messages: z.array(QuoteMessageSchema) }),
  z.object({ kind: z.literal("quote-close"), threadId: id }),
  z.object({ kind: z.literal("verdict-override-set"), verdict: VerdictOverrideSchema }),
  z.object({ kind: z.literal("verdict-override-clear") }),
  z.object({
    kind: z.literal("line-comment-set"),
    path: z.string().min(1),
    line: lineSchema,
    body: z.string(),
  }),
  z.object({ kind: z.literal("line-comment-clear"), path: z.string().min(1), line: lineSchema }),
] as const;

/** An event BODY — the kind + fields, before the store stamps session id + seq. */
export const AskEventBodySchema = z.discriminatedUnion("kind", askEventBodyVariants);
export type AskEventBody = z.infer<typeof AskEventBodySchema>;

/** The stored/logged event — a body plus its session id and monotonic seq. */
export const AskEventSchema = z.intersection(
  AskEventBodySchema,
  z.object({ sessionId: id, seq: z.number().int().nonnegative() }),
);
export type AskEvent = z.infer<typeof AskEventSchema>;

/** The event kind vocabulary — for exhaustiveness and iteration in tests. */
export const ASK_EVENT_KINDS = askEventBodyVariants.map((v) => v.shape.kind.value);
export type AskEventKind = AskEventBody["kind"];
