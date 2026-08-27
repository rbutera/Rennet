// The durable-session shapes (#466 resolution, 2026-08-26; #457 vocabulary).
//
// Shapes only: the state machine, locks, and rework queue are B9's; dispatch
// binding is B4/B10's. The transport wire layer lives beside this in
// `wire.ts` (#376) — two session contracts, one folder seam.

import { z } from "zod";
import { AskLifecycleSchema, QuoteAnchorSchema } from "../board";
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
 * A citation into the captured patchset. Structural stand-in for the canonical
 * `CodeRef` — cluster 6 (`delta/`) declares it and re-points this alias.
 */
const codeRefSchema = z.object({
  patchsetId: id,
  path: id,
  side: z.enum(["base", "head"]),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  symbol: z.string().optional(),
});

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
 */
export const SessionThreadSchema = z.object({
  threadId: id,
  anchor: ThreadAnchorSchema.optional(),
  ask: AskSchema.optional(),
});
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
