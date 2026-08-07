import {
  batchPayload,
  batchViewModel,
  type DispositionBatch,
  type DispositionDraft,
} from "./authoring";
import type { DispositionWrite } from "./logic";

// ─────────────────────────────────────────────────────────────────────────────
// The DESTINATION (issue #64) — the persistent north the whole review stages
// toward. Pure functions, no React, no DOM.
//
// Rai's articulation (voice, 2026-08-07): everything leads UP TO one of two
// destinations — the PR submission (your own branch) or the PR review document
// (someone else's PR). Rennet is STAGING FOR AN ACTION, like staging for a commit
// but you're staging for a PR or a PR review.
//
// Ratified rulings (Rai, 2026-08-07) encoded here:
//  • dispose == staged  — a disposition IS staged the moment it is made; there is
//    NO separate staging act. `draftsFromWrites` lets a host stage directly from
//    the L2 writes it already emits.
//  • withdraw == unstage — `withdrawDraft` (authoring.ts) is the unstage act; the
//    #17 "batch view" is renamed the "staged" view.
//  • publish is all-or-nothing per signing act for v1 — a subset means withdraw
//    first, then sign. The sheet signs the WHOLE staged set.
//
// The staged set IS the #17 batch (`DispositionBatch`); this module re-expresses
// it in the "staged" vocabulary and adds the mode framing + the sign gate. The
// `layer:ui` boundary allows only `@rennet/types` + this package: nothing here
// imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a staged set will publish onto a PR or hand off on the reviewer's own branch. */
export type BatchDestination = "publish" | "handoff";

/**
 * Which paper the review is forming toward.
 *  • own-branch → the handoff / PR-submission bundle you're building.
 *  • other-pr   → the review you'll post onto someone else's PR.
 */
export type DestinationMode = "own-branch" | "other-pr";

/** The framing of the destination for a mode. The staged DATA is identical across modes. */
export interface DestinationVariant {
  mode: DestinationMode;
  /** The batch/staged destination this maps to ("handoff" / "publish"). */
  destination: BatchDestination;
  /** The persistent target's heading. */
  title: string;
  /** One line describing the forming paper. */
  summary: string;
  /** What the signing act does, in the user's terms. */
  signLabel: string;
}

const VARIANTS: Record<DestinationMode, DestinationVariant> = {
  "own-branch": {
    mode: "own-branch",
    destination: "handoff",
    title: "Handoff bundle",
    summary: "The PR submission you're building from this branch.",
    signLabel: "Hand off",
  },
  "other-pr": {
    mode: "other-pr",
    destination: "publish",
    title: "Review to post",
    summary: "The review that will land on this pull request.",
    signLabel: "Publish review",
  },
};

/** The framing for a mode. The staged data does not change with the mode. */
export function destinationVariant(mode: DestinationMode): DestinationVariant {
  return VARIANTS[mode];
}

// ── The staged set: the #17 batch in the "staged" vocabulary ─────────────────

/**
 * The staged items as exactly what will publish (someone else's PR) or hand off
 * (own branch) — the L2 payload rendered as a list, sorted by path. This is the
 * #17 `batchViewModel`, so "staged view bytes == staged payload bytes" holds by
 * construction and the publish sheet previews the true outbound bytes.
 */
export function stagedItems(batch: DispositionBatch): DispositionWrite[] {
  return batchViewModel(batch);
}

/** The canonical bytes that will publish or hand off — the #17 `batchPayload`. */
export function stagedPayload(batch: DispositionBatch): string {
  return batchPayload(batch);
}

/**
 * Turn the per-anchor L2 writes a host already emits into staged drafts, so a
 * disposition is staged in the same act it is made (dispose == staged). The body
 * is the user's raw sovereign input, carried verbatim.
 */
export function draftsFromWrites(writes: DispositionWrite[]): DispositionDraft[] {
  return writes.map((write) => ({ path: write.path, type: write.type, raw: write.body }));
}

// ── The sign gate: hold-to-confirm, never defaults to APPROVE ────────────────

/**
 * Whether a hold-to-confirm publish is permitted. Signing is allowed only once
 * the elapsed hold has met `holdToSignMs`. The accessibility floor is 0: a
 * `holdToSignMs` of 0 permits an immediate sign (elapsed 0 >= 0). A negative hold
 * budget is clamped to the floor. This gate is what stops a publish from ever
 * defaulting to APPROVE — nothing signs until the elapsed hold clears the bar.
 */
export function canSign(elapsedMs: number, holdToSignMs: number): boolean {
  const bar = Math.max(0, holdToSignMs);
  return elapsedMs >= bar;
}
