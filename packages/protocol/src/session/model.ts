// The durable-session shapes (#466 resolution, 2026-08-26; #457 vocabulary).
//
// Shapes only: the state machine, locks, and rework queue are B9's; dispatch
// binding is B4/B10's. The transport wire layer lives beside this in
// `wire.ts` (#376) — two session contracts, one folder seam.

import { z } from "zod";
import { AskLifecycleSchema, QuoteAnchorSchema } from "../board";
// Thread anchors cite code through the canonical CodeRef (delta/citations, B3 task 6.2).
import { codeRefSchema } from "../delta/citations";
import { LENS_KINDS } from "../manifests";

const id = z.string().min(1);

/**
 * The harness cursor (#466 res. 3, the T3 cursor-resume shape): interactive
 * turns run fresh-process-per-turn + `resume`, so the durable session persists
 * where the harness conversation left off. The harness owns the transcript;
 * Rennet owns only this pointer into it.
 */
export const HarnessCursorSchema = z.object({
  harnessSessionId: id,
  lastAssistantMessageAnchor: id,
  turnCount: z.number().int().nonnegative(),
});
export type HarnessCursor = z.infer<typeof HarnessCursorSchema>;

/**
 * The claimed target (#466 res. 11): a branch and its PR are ONE claimed thing
 * — every New-chat row resolving to either disappears while the claim holds.
 * Archive-only release; a merged target keeps its claim.
 */
export const ClaimSchema = z.object({
  branch: id,
  prNumber: z.number().int().positive().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * A thread anchor (#466 res. 7): a code-line citation or a prose quote. One
 * mechanism — code-line comment, prose-quote comment, and Explain are all
 * messages entering the session carrying one of these.
 */
export const ThreadAnchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), ref: codeRefSchema }),
  z.object({ type: z.literal("quote"), quote: QuoteAnchorSchema }),
]);
export type ThreadAnchor = z.infer<typeof ThreadAnchorSchema>;

/**
 * The ask specialization (#452 hand-off design; #462 R29–R34): a typed message
 * carrying an anchor, text, an intent, and an exit lane, with provenance back
 * to its source. `exitLane` stays an open string — the exits are decided
 * (post review / dispatch round / open PR) but the lane id vocabulary locks
 * with B9's state machine, not here.
 */
export const AskSchema = z.object({
  intent: z.string().min(1),
  exitLane: z.string().min(1),
  provenance: id,
  lifecycle: AskLifecycleSchema,
});
export type Ask = z.infer<typeof AskSchema>;

/**
 * An anchored conversation thread (#466 res. 7). Thread CONTENT lives only in
 * the session transcript; boards and the diff store anchor→thread references —
 * this shape is that reference, plus the ask riding on it when one was minted.
 *
 * Two arms, not independent optionals: the ask specialization REQUIRES an
 * anchor (#462 R29–R34 — an ask is anchor + intent + exit lane + provenance +
 * lifecycle), so `{threadId, ask}` without an anchor does not parse. A plain
 * conversation thread carries no ask and may or may not be anchored.
 */
export const SessionThreadSchema = z.union([
  z.object({ threadId: id, anchor: ThreadAnchorSchema, ask: AskSchema }),
  z.object({
    threadId: id,
    anchor: ThreadAnchorSchema.optional(),
    // Present-and-defined `ask` must take the anchored arm above.
    ask: z.never().optional(),
  }),
]);
export type SessionThread = z.infer<typeof SessionThreadSchema>;

/**
 * A generation (#457): the boards for one review of one patchset,
 * append-then-freeze. Live boards are append-only logs; when the code moves,
 * the generation freezes immutable and a successor is minted — the successor
 * account compares N vs N+1.
 */
export const GenerationSchema = z.object({
  id,
  patchsetId: id,
  /** Per-lens draft boards (L2), keyed by lens; present once drafted. */
  lensBoards: z.partialRecord(z.enum(LENS_KINDS), id),
  /** The orchestrator-authored composition board (L3), once composed. */
  compositionBoardId: id.optional(),
  status: z.enum(["live", "frozen"]),
});
export type Generation = z.infer<typeof GenerationSchema>;

/**
 * The rounds-ledger row (#462's #486 R57 ripple): what one work-order round
 * dispatched and what came back.
 */
export const RoundRecordSchema = z.object({
  /** Thread ids of the asks this round dispatched. */
  asksDispatched: z.array(id),
  workerCommitRange: z.object({ from: id, to: id }),
  /** Generation minted from the worker's commits; absent if nothing landed. */
  mintedPatchsetGeneration: id.optional(),
  /** The generation whose boards this round reported against. */
  boardGeneration: id,
  /** Board id of the round-report board (the `round_outcome` items live on it). */
  reportBoard: id,
});
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

/**
 * The chat dock's header trail (C07) — the session's identity line. Honest-minimal:
 * the coding transcript lives in the harness, so this carries only the identity facts
 * Rennet holds. `target`/`targetState` mirror the sidebar's review-target vocabulary.
 */
export const SessionTrailSchema = z.object({
  title: z.string(),
  projectName: z.string().optional(),
  target: z.enum(["your-branch", "your-pr", "teammate-pr"]).optional(),
  targetState: z.enum(["needs-you", "merged", "reviewed"]).optional(),
});
export type SessionTrail = z.infer<typeof SessionTrailSchema>;

/**
 * A harness-reported context-window figure (ask-don't-estimate, #466 res. 3). Absent on
 * the wire ⇒ the meter reads "unknown"; never estimated. Both figures are the harness's own.
 */
export const SessionContextWindowSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type SessionContextWindow = z.infer<typeof SessionContextWindowSchema>;

// A turn/block lifecycle. Inlined (not imported from `../wire`) to keep this leaf shapes
// module off the root-index import cycle `wire.ts` sits on — three literals, cheap to hold.
const transcriptTurnStatus = z.enum(["streaming", "complete", "interrupted"]);

/**
 * A collapsing "Thinking → Thought" block projected from the harness's reasoning events
 * (B). Its live/settled look follows `status`; `text` is the reasoning, one entry per line.
 */
export const ThoughtBlockSchema = z.object({
  kind: z.literal("thought"),
  id,
  status: transcriptTurnStatus,
  seconds: z.number().nonnegative().optional(),
  text: z.array(z.string()),
});

/**
 * A running → done tool-call step, projected from a `tool.started` joined with its
 * `tool.output` (B). `toolKind` is the SERIALIZABLE icon selector — the client maps it to a
 * concrete icon (C07); the wire never carries a component. `denied` marks a `tool.denied`.
 * Every path-bearing string here is R19-scrubbed at projection time, before it is persisted.
 */
export const ActionStepSchema = z.object({
  kind: z.literal("action"),
  id,
  label: z.string(),
  detail: z.string().optional(),
  status: transcriptTurnStatus,
  doneLabel: z.string().optional(),
  doneDetail: z.string().optional(),
  toolKind: z.enum(["read", "write", "exec", "search", "mcp", "subagent", "other"]),
  denied: z.boolean().optional(),
});

/** A turn's activity preface: thought blocks and action steps, in occurrence order. */
export const ActivityStepSchema = z.discriminatedUnion("kind", [
  ThoughtBlockSchema,
  ActionStepSchema,
]);
export type ActivityStep = z.infer<typeof ActivityStepSchema>;

export const ProseBlockSchema = z.object({ kind: z.literal("text"), text: z.string() });
export const CodeBlockSchema = z.object({
  kind: z.literal("code"),
  path: z.string(),
  lang: z.string().optional(),
  code: z.string(),
  startLine: z.number().int().optional(),
  highlightLines: z.array(z.number().int()).optional(),
});
/** A turn body: prose interleaved with code blocks. */
export const ContentBlockSchema = z.discriminatedUnion("kind", [ProseBlockSchema, CodeBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * A session-transcript row. The harness CLI stays the CANONICAL owner of the conversation —
 * resume still rides the `HarnessCursor` (#466 res. 3), untouched. This is ADDITIVE to that:
 * a DISPLAY read-model projected from the harness events the adapter already normalizes
 * (tool calls, outputs, thinking, prose), persisted so the dock shows history and survives
 * reload. Three representable rows:
 *   - `turn`: one coding turn — orchestrator (or user) — with its thought/action preface and
 *     its prose/code body. Path-bearing content is R19-scrubbed before persistence.
 *   - `compact-boundary`: the harness summarized in place; its own figures, absent ⇒ unknown.
 *   - `context-rebuilt`: the harness lost the transcript and Rennet rebuilt from the boards.
 */
export const SessionTranscriptRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    id,
    speaker: z.enum(["user", "orchestrator"]),
    status: transcriptTurnStatus,
    paragraphs: z.array(z.string()),
    time: z.string().optional(),
    lead: z.string().optional(),
    preface: z.array(ActivityStepSchema).optional(),
    body: z.array(ContentBlockSchema).optional(),
  }),
  z.object({
    kind: z.literal("compact-boundary"),
    id,
    tokensBefore: z.number().int().nonnegative().optional(),
    tokensAfter: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("context-rebuilt"), id, reason: z.string() }),
]);
export type SessionTranscriptRow = z.infer<typeof SessionTranscriptRowSchema>;

/**
 * The chat dock's session read (C07): the header trail, the historical transcript rows,
 * and the harness context figure. Honest-absent today — no coding-transcript store exists
 * (the harness owns it), so `rows` is empty and `contextWindow` absent until a transcript
 * read port lands; the live ask threads arrive separately via `review.reattach`.
 */
export const SessionTranscriptSchema = z.object({
  trail: SessionTrailSchema,
  rows: z.array(SessionTranscriptRowSchema),
  contextWindow: SessionContextWindowSchema.optional(),
});
export type SessionTranscript = z.infer<typeof SessionTranscriptSchema>;

/**
 * The session (#466 res. 1–2): the first-class durable root. One chat travels
 * with the reviewer across surfaces; it owns the harness cursor, the threads,
 * and the claim. A review attaches 1:0..1 (`reviewId` — referenced, not
 * absorbed); a no-target session has no claim and upgrades in place when a
 * target binds. Archive is the only release (v1 soft delete).
 */
export const SessionModelSchema = z.object({
  id,
  projectId: id,
  claim: ClaimSchema.optional(),
  reviewId: id.optional(),
  harnessCursor: HarnessCursorSchema.optional(),
  threads: z.array(SessionThreadSchema),
  createdAt: z.number(),
  archivedAt: z.number().optional(),
});
export type SessionModel = z.infer<typeof SessionModelSchema>;
