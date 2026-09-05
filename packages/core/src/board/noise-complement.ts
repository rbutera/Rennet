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
 *
 * ── THE UNIT IS THE HUNK, NOT THE SIDE (#864) ────────────────────────────────────
 * A region is one SIDE of one hunk, because that is what a citation names: a modified
 * hunk offers a base-side region and a head-side region, and they are genuinely
 * different text. But the question the complement asks is not "was this side cited", it
 * is *did any lens read this change* — and for that the hunk is the unit.
 *
 * Subtracting per side made `no-noise` UNREACHABLE for any change containing a
 * modification: Sequence citing head 3-6 of `@@ -1,6 +1,6 @@` left base 1-6 in the
 * complement, so the host filed as noise the exact lines a sibling had just read, and
 * dispatched a seat turn to write a board about them. That is the misfiled-noise harm
 * D16's own header names, arriving through the derivation rather than through a seat's
 * judgement.
 *
 * So: a citation on EITHER side cancels the hunk, and an uncited hunk is filed ONCE —
 * the head side where it has one, its base side when it is a pure deletion. Filing both
 * sides would put the same change on the board twice under two line ranges, which is
 * also what made the member list on a 95-file branch twice the size it had any reason
 * to be.
 *
 * Regions are grouped by {@link ChangedRegion.hunk}. A region with none is its own
 * change and behaves exactly as it did before the key existed — a hand-built context is
 * not silently regrouped by a guess about which regions belong together, because that
 * guess is not derivable from a path and a line range.
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

  // A cited region cancels its whole CHANGE, and an uncited change is filed ONCE.
  const citedChanges = new Set<string>();
  for (const region of cited) if (region.hunk !== undefined) citedChanges.add(region.hunk);
  const sidesOf = new Map<string, ChangedRegion[]>();
  for (const region of input.regions) {
    if (region.hunk === undefined) continue;
    const sides = sidesOf.get(region.hunk);
    if (sides === undefined) sidesOf.set(region.hunk, [region]);
    else sides.push(region);
  }

  const members: ChangedRegion[] = [];
  const filed = new Set<string>();
  for (const region of input.regions) {
    // A region with no change to belong to is its own change: it subtracts and files on
    // its own identity, which is what every caller got before the key existed.
    if (region.hunk === undefined) {
      if (!cited.has(region)) members.push(region);
      continue;
    }
    if (citedChanges.has(region.hunk) || filed.has(region.hunk)) continue;
    filed.add(region.hunk);
    // The HEAD side is the member when the change has one: it is the text the branch
    // now carries, and it is what a reviewer opening a noise member wants to read. A
    // pure deletion has no head side and files its base side instead.
    const sides = sidesOf.get(region.hunk) ?? [region];
    members.push(sides.find((side) => side.side === "head") ?? region);
  }
  return { kind: "derived", members };
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
