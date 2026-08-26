import type { DispositionType } from "@rennet/protocol";
import type { CollationDraft, CollationItem } from "./collation";

// ─────────────────────────────────────────────────────────────────────────────
// The STAGING SEMANTICS (issue #109 — the review heart) — pure functions, no
// React, no DOM.
//
// Every review note carries a real verdict (approve / request-change / comment /
// question), and where that verdict TRAVELS is the disposition's own property, not
// a UI colour choice. This module is the material law that decides it, and the
// sign-off roll-up over it.
//
// The material law — "ink vs blue" (issue #109):
//   • INK  — a publish-bound disposition. It TRAVELS to the PR.
//   • BLUE — a local-only disposition (the system's private backlight). It STAYS on
//            this machine and never leaves.
//
// The per-type routing:
//   • approve        — a personal "viewed" marker (GitHub's "viewed" checkbox).
//                      NEVER publishes. Always BLUE. Its lane is FIXED — no staging
//                      flag can push an approve into a published review.
//   • request-change — the load-bearing disposition. ALWAYS stages (INK). Its lane
//                      is FIXED — a request-change always travels (own branch: it
//                      tells the local orchestrator to fix; other PR: it drives the
//                      published review type).
//   • comment        — defaults to the ORCHESTRATOR (a conversation), so it is BLUE
//                      by default. Stageable: it is INK only when explicitly staged.
//   • question       — same as comment: defaults to the orchestrator (BLUE),
//                      stageable to INK.
//
// The two load-bearing invariants — approve never publishes, and request-change
// always does — hold STRUCTURALLY here (`itemLane` ignores the staging flag for the
// two fixed types), so they cannot be broken by a caller forgetting to clear a
// flag. Only comment/question read the flag, which is the whole "only sometimes are
// they staged" contract.
//
// This is the DISPOSITION half of the inline conversation cluster (#36 owns the
// private research chat + the live orchestrator routing; #139 owns the review.ask
// wire). Here we encode the routing INTENT + the published-subset exclusion; the
// live send is deferred to those issues.
//
// The `layer:ui` boundary allows only `@rennet/protocol` + this package: nothing here
// imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a disposition travels. `ink` publishes to the PR; `blue` stays local. */
export type StagingLane = "ink" | "blue";

/**
 * The DEFAULT lane for a disposition type, before any staging override. Only
 * request-change defaults to ink (it is the load-bearing published disposition);
 * approve/comment/question all default to blue (personal, or orchestrator-bound).
 */
export function defaultLane(type: DispositionType): StagingLane {
  return type === "request-change" ? "ink" : "blue";
}

/**
 * Whether a type's lane is the USER'S to move by staging. Only comment and question
 * are stageable — they default to the orchestrator (blue) and are staged (ink) only
 * sometimes. Approve (never publishes) and request-change (always publishes) are
 * FIXED, so a staging flag on either is inert.
 */
export function isStageable(type: DispositionType): boolean {
  return type === "comment" || type === "question";
}

/**
 * The effective lane of one collation item. For a fixed type (approve /
 * request-change) the lane is the default and the `staged` flag is IGNORED — this
 * is where "approve never publishes" and "request-change always publishes" become
 * structural rather than a caller convention. For a stageable type (comment /
 * question) the flag moves it: `staged === true` ⇒ ink, else blue.
 */
export function itemLane(item: Pick<CollationItem, "type" | "staged">): StagingLane {
  if (!isStageable(item.type)) return defaultLane(item.type);
  return item.staged === true ? "ink" : "blue";
}

/** Whether a collation item will travel to the PR (its lane is ink). */
export function isPublished(item: Pick<CollationItem, "type" | "staged">): boolean {
  return itemLane(item) === "ink";
}

/**
 * The PUBLISHED (ink) subset of a draft, IN DRAFT ORDER — exactly what travels to
 * the PR. Approve is never here (it is personal), and a comment/question is here
 * only if it was explicitly staged. This is the set a published review is derived
 * from; the complement (`localItems`) never leaves the machine.
 */
export function publishedItems(draft: CollationDraft): CollationDraft {
  return draft.filter((item) => itemLane(item) === "ink");
}

/**
 * The LOCAL (blue) subset of a draft, in draft order — everything that stays on
 * this machine: every approve, plus every orchestrator-bound (unstaged)
 * comment/question. The union of `publishedItems` and `localItems` is the whole
 * draft, and they are disjoint (each item has exactly one lane).
 */
export function localItems(draft: CollationDraft): CollationDraft {
  return draft.filter((item) => itemLane(item) === "blue");
}

/** The GitHub review type a published set rolls up to. Null ⇒ nothing publishes. */
export type PublishReviewType = "request-changes" | "comments";

/**
 * The publish roll-up (issue #109): a PR review's type derived from the PUBLISHED
 * (ink) subset only.
 *   • `request-changes` — if ANY published block is a request-change (the
 *     load-bearing disposition drives the whole review's type).
 *   • `comments`        — else if any comment/question was staged (a plain review).
 *   • `null`            — nothing publishes: an approve-only review, or one whose
 *     comments/questions all stayed with the orchestrator. Approve NEVER appears in
 *     the published review, so an approve-only draft rolls up to nothing.
 *
 * This is the twin of the engine's review-event derivation, but at the STAGING
 * layer: it reads the ink subset, so approve can never escalate it to an APPROVE
 * event (approve is not in the ink subset at all).
 */
export function publishReviewType(draft: CollationDraft): PublishReviewType | null {
  const published = publishedItems(draft);
  if (published.some((item) => item.type === "request-change")) return "request-changes";
  if (published.length > 0) return "comments";
  return null;
}

/**
 * Stage or unstage a stageable item (comment / question) by id — the "route this to
 * the PR" / "keep this with the orchestrator" toggle. A no-op on a FIXED type
 * (approve / request-change), whose lane is not the user's to move, and a no-op on
 * an unknown id. Pure transform of the draft.
 */
export function stageItem(draft: CollationDraft, id: string, staged: boolean): CollationDraft {
  return draft.map((item) =>
    item.id === id && isStageable(item.type) ? { ...item, staged } : item,
  );
}

/** The ink/blue split of a draft, for the chrome's "N publish · N private" counts. */
export interface LaneCounts {
  /** How many dispositions travel to the PR (ink). */
  readonly ink: number;
  /** How many stay on this machine (blue) — the wireframe's "N private" pill. */
  readonly blue: number;
}

/** Count a draft's ink vs blue dispositions (the destination frame's private pill). */
export function laneCounts(draft: CollationDraft): LaneCounts {
  let ink = 0;
  for (const item of draft) if (itemLane(item) === "ink") ink += 1;
  return { ink, blue: draft.length - ink };
}

/** A human, terse label for a roll-up outcome, for the sign-off summary line. */
export function publishReviewLabel(type: PublishReviewType | null): string {
  if (type === "request-changes") return "Request changes";
  if (type === "comments") return "Comments";
  return "Nothing to publish";
}
