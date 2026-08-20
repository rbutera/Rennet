import type { AnchorSide, AnchorSpan, CanvasAngle, Patchset, Review } from "@rennet/types";

/**
 * One row of the Files view's Angles rail (critique P2: the rail was DEAD — six
 * fictional angle names, every row hard-coded "Not run"). A row is always derived
 * from real review state, never a placeholder: `ran` (with an honest count read
 * from the loaded data), `running` (that row's fetch is genuinely in flight),
 * `pending` (the canvas load has not landed — it fires on the Canvases landing,
 * so this claims nothing about a run), `failed`, or `unavailable` (the review's
 * repository is gone, so the live pipeline cannot run).
 */
export interface AngleRailRow {
  readonly angle: CanvasAngle;
  readonly label: string;
  readonly state: "pending" | "running" | "failed" | "unavailable" | "ran";
  /** Present only for `ran`: an honest quantity read from the loaded data. */
  readonly detail?: string;
}

export interface DiffFocus {
  readonly path: string;
  readonly span: AnchorSpan;
  readonly side?: AnchorSide;
  readonly nonce: number;
}

export function activePatchset(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

// Shared secondary-button idiom (brief: `border border-line text-ink hover:bg-raised`).
// One source for the three `.secondary` sites so the re-skin stays consistent.
export const SECONDARY_BUTTON =
  "secondary inline-flex cursor-pointer items-center gap-2 rounded-control border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-raised hover:text-ink";
