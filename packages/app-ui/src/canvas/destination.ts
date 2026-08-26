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
// `layer:ui` boundary allows only `@rennet/protocol` + this package: nothing here
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

/**
 * The publish decision: the exact outbound bytes to emit for a completed hold, or
 * `null` when the hold has not cleared the bar (nothing leaves). This is the ONE
 * gate the sheet's sign paths (pointer hold + keyboard) route through, so the two
 * load-bearing publish invariants are guarded by a red-able test rather than only
 * holding by construction:
 *   • never auto-approves — a hold below `holdToSignMs` returns `null`, so a
 *     too-short (or zero-elapsed, non-floor) hold cannot sign.
 *   • what you see is what leaves — the returned string is the SAME `payload` the
 *     sheet previews, byte-for-byte, never a transform; if it emits at all it emits
 *     exactly the previewed bytes.
 * The accessibility floor is 0 (a `holdToSignMs` of 0 signs on an explicit act).
 */
export function resolveSign(
  elapsedMs: number,
  holdToSignMs: number,
  payload: string,
): string | null {
  return canSign(elapsedMs, holdToSignMs) ? payload : null;
}

// ── The degradation-ledger sign-gate (issue #80 / bead idwba) ────────────────

/**
 * The class of degradation an entry records, so the sheet can bucket entries
 * rather than show one flat list (issue #22 ledger content):
 *  • skipped-angle → a review angle the run never ran (budget/harness).
 *  • orphaned      → a disposition a patchset advance dropped (a failed carry).
 *  • excluded      → a path deliberately left out of the outbound artifact.
 *  • flattened     → richer structure collapsed to a flatter form on publish
 *                    ("published, but flattened") — the third ink state.
 * Absent → the entry is shown ungrouped, so #80's existing thin entries (id +
 * summary only) render unchanged.
 */
export type DegradationKind = "skipped-angle" | "orphaned" | "excluded" | "flattened";

/**
 * One run degradation the reviewer must acknowledge before signing. A UI-local
 * view-model over primitives: `id` identifies the entry, `summary` is the
 * human-legible line (e.g. "Security angle skipped — budget exhausted"). `kind`
 * and `detail` are the #22 ledger CONTENT the sheet displays — the bucket and an
 * optional second line (e.g. the orphaned path); both optional so a bare #80 entry
 * still renders. The gate keys ONLY on `id` + `summary` (see the sheet's
 * signature), so adding these fields changes the DISPLAY, never the gate. The
 * CONTENT source (real run/council degradation) belongs to #22/council. This stays
 * inside the `layer:ui` boundary — nothing imports `@rennet/core`.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly summary: string;
  readonly kind?: DegradationKind;
  readonly detail?: string;
}

/**
 * The honest read-vs-attested counts (issue #22): how many elements the reviewer
 * SAW versus how many they actually DISPOSITIONED, over the review's total. Stated
 * so a signer knows how much of the change they are attesting to unread. Optional
 * — absent → not shown, so #80's thin ledger renders unchanged.
 */
export interface AttestationCounts {
  readonly total: number;
  readonly read: number;
  readonly attested: number;
}

/** The degradations a run carried, mapped by #22/council into the sheet's gate prop. */
export interface PublishLedger {
  readonly entries: readonly LedgerEntry[];
  readonly counts?: AttestationCounts;
}

/** The buckets an entry set groups into, in a stable display order. */
export const LEDGER_BUCKET_ORDER: DegradationKind[] = [
  "skipped-angle",
  "orphaned",
  "excluded",
  "flattened",
];

/** Human labels for each degradation bucket. */
export const LEDGER_BUCKET_LABEL: Record<DegradationKind, string> = {
  "skipped-angle": "Angles skipped",
  orphaned: "Orphaned dispositions",
  excluded: "Excluded from this artifact",
  flattened: "Published, but flattened",
};

/**
 * Group ledger entries into their display buckets, preserving entry order within a
 * bucket. Entries with no `kind` collect under `undefined`, so a bare #80 entry set
 * (no kinds) yields exactly one ungrouped bucket and renders as it always has.
 * Returns buckets in `LEDGER_BUCKET_ORDER`, with the ungrouped bucket last.
 */
export function bucketLedgerEntries(
  entries: readonly LedgerEntry[],
): { kind: DegradationKind | undefined; entries: LedgerEntry[] }[] {
  const byKind = new Map<DegradationKind | undefined, LedgerEntry[]>();
  for (const entry of entries) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry);
    byKind.set(entry.kind, list);
  }
  const ordered: { kind: DegradationKind | undefined; entries: LedgerEntry[] }[] = [];
  for (const kind of LEDGER_BUCKET_ORDER) {
    const list = byKind.get(kind);
    if (list) ordered.push({ kind, entries: list });
  }
  const ungrouped = byKind.get(undefined);
  if (ungrouped) ordered.push({ kind: undefined, entries: ungrouped });
  return ordered;
}

/**
 * The gate: an unacknowledged, non-empty ledger blocks EVERY sign path (pointer
 * hold and keyboard), regardless of hold duration. It is open — signing proceeds
 * normally — when the ledger is absent, carries zero entries, or has been
 * acknowledged. So the shipped shell (which passes no ledger) is unchanged, and
 * this change is additive.
 *
 * "Acknowledged", not merely "visible": a gate that clears the instant the ledger
 * renders is not a gate. The safety property is that the reviewer cannot publish a
 * degraded review WITHOUT an explicit act acknowledging the degradation.
 */
export function ledgerBlocksSign(
  ledger: PublishLedger | undefined,
  acknowledged: boolean,
): boolean {
  return ledger !== undefined && ledger.entries.length > 0 && !acknowledged;
}
