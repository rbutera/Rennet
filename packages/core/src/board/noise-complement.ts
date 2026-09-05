/**
 * The Noise board's membership, derived (`lens-board-tools` D16).
 *
 * Rai's ruling, 2026-09-04: *"By definition anything that isn't covered by one of the
 * other boards is noise."* So noise is a POSITION, not a property of a hunk — a changed
 * region that Design, Sequence, Decisions and Flagged all passed over — and membership is
 * set subtraction rather than a model's judgement about reading effort. Every changed
 * region of a change is in exactly one of two sets, and the partition is total by
 * construction rather than by anyone's diligence.
 *
 * Pure: no I/O, no model, no Node. The runtime hands it what each sibling lane SAID and it
 * answers with the complement, or with the reason the complement is not knowable yet.
 *
 * ── The trap this module exists to close (D16d) ──────────────────────────────────
 * A sibling that FAILED did not cite nothing. The complement of a board that never
 * arrived is not the complement of an empty one, and a Noise board built over a failed
 * Flagged lane would present that lane's un-cited hunks as noise — the "misfiled noise
 * hides exactly the line the reviewer needed" failure, with a host-derived stamp on it.
 *
 * So this matches on a POSITIVE CONTRADICTION, never on silence, which is CLAUDE.md's own
 * rule about the same class of defect. A lane that settled a board or declared an
 * admissible absence has positively stated what it cites — an absence is an empty citation
 * set and subtracts safely. A lane that failed has stated NOTHING, and its silence is not
 * an empty set: {@link deriveNoiseMembers} refuses to answer at all and names the lanes
 * whose citations are unknown. A partial complement presented as noise is worse than no
 * Noise board, because the reviewer cannot see which part of it is guesswork.
 */

import type { DraftElement, LensKind } from "@rennet/protocol";
import { type ChangedRegion, citedRegions } from "./lint";

/** The four lenses whose citations the Noise board is the complement of. */
export const NOISE_SIBLING_LENSES: readonly LensKind[] = [
  "design",
  "sequence",
  "decisions",
  "flagged",
];

/**
 * What one sibling lane said about what it cites.
 *
 * Three cases and not two, which is the whole point: `settled` and `absent` are both
 * POSITIVE statements and subtract, while `failed` is silence and does not.
 */
export type SiblingCitations =
  /** The lane settled a board. Its citations are that board's `code_ref` elements. */
  | {
      readonly lens: LensKind;
      readonly kind: "settled";
      readonly elements: readonly DraftElement[];
    }
  /** The lane declared an admissible absence: a positive statement that it cites nothing. */
  | { readonly lens: LensKind; readonly kind: "absent" }
  /** The lane failed. It stated nothing, and nothing is not an empty set. */
  | { readonly lens: LensKind; readonly kind: "failed" };

export type NoiseMembership =
  /**
   * Every sibling stated what it cites, so the complement is knowable. `members` may be
   * empty — that is the `no-noise` settlement, and it means the four lanes between them
   * cited every changed region (D16e).
   */
  | { readonly kind: "derived"; readonly members: readonly ChangedRegion[] }
  /**
   * At least one sibling failed. The Noise lane settles as a typed failure naming these
   * lenses, and becomes runnable again when one of them settles on a retry.
   */
  | { readonly kind: "unknowable"; readonly unknown: readonly LensKind[] };

/**
 * The Noise board's members: the changed regions no sibling board cited.
 *
 * `regions` is the captured patchset's own changed regions — the same list every citation
 * rule resolves against, so a member is a region a seat could have cited and did not,
 * rather than a second notion of "changed" invented here.
 */
export function deriveNoiseMembers(input: {
  readonly regions: readonly ChangedRegion[];
  readonly siblings: readonly SiblingCitations[];
}): NoiseMembership {
  const unknown = input.siblings
    .filter((sibling) => sibling.kind === "failed")
    .map((sibling) => sibling.lens);
  // Checked FIRST and returned whole. Falling through to the subtraction with the failed
  // lane contributing an empty set is precisely the silence-read-as-consent defect, and
  // the control for this arm deletes this branch and watches the failed-sibling fixture
  // redden.
  if (unknown.length > 0) return { kind: "unknowable", unknown };

  const cited = new Set<ChangedRegion>();
  for (const sibling of input.siblings) {
    // An `absent` lane contributes no elements, so it subtracts an empty set — which is
    // what a lane that positively said "there is nothing here" means.
    if (sibling.kind !== "settled") continue;
    for (const region of citedRegions(sibling.elements, input.regions)) cited.add(region);
  }
  return { kind: "derived", members: input.regions.filter((region) => !cited.has(region)) };
}

/**
 * Why the Noise lane cannot take the complement, in the reviewer's words.
 *
 * It is one failure, and it is honest: two lanes are unreadable because one lane failed.
 * The sentence names which, because the per-lens retry the reviewer needs is on that lane
 * and not on this one.
 */
export function unknowableComplementFailure(unknown: readonly LensKind[]): string {
  const named = [...unknown].sort().join(", ");
  const plural = unknown.length === 1 ? "lane" : "lanes";
  return `noise lens: the ${named} ${plural} did not settle, so what ${unknown.length === 1 ? "it cites" : "they cite"} is unknown and the remainder cannot be taken. A board built over ${unknown.length === 1 ? "it" : "them"} would file un-reviewed regions as skippable. Retry the ${named} ${plural} and this board follows.`;
}
