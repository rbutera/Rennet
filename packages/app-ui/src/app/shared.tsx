import type { AnchorSide, AnchorSpan, Patchset, Review } from "@rennet/protocol";
// Local lens union — protocol's CanvasAngle was deleted (#489, B2); counterpart.ts
// owns the app-ui-local shape until B3 gives LensKind its real home.
import type { CanvasAngle } from "../canvas/counterpart";

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
