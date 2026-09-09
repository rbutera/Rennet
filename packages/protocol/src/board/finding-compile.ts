// The Flagged compiler's two authored enums, and how the host expands them (move two,
// `flagged-review-compile` Decision 10).
//
// After the review→compile rework the Flagged board has ONE author: a compiler seat that
// reads two finished review files and assembles the board. Its whole job is to attribute
// each finding to the model that raised it and to judge whether both did — facts the two
// review seats can no longer carry, because they write no board. The finding wire fields
// those facts live in are nested shapes (`author` is `{kind,id}`, `concurrence` an array of
// tallies), which the flat-input rule (`flatInputViolations`, the #810 fix) forbids a seat
// authoring. So the compiler authors two FLAT enums and the host expands them here.
//
// The enums are input-only: they ride the `add_finding` input beside `parent_id`, never
// `AUTHORED_BOARD_SCHEMA`, and the writer consumes them into `author` / `concurrence` /
// `accord` without persisting them — `author` already encodes the model and `accord` the
// agreement, so keeping the enums beside them would store one fact twice.

import type { Author, FindingAccord } from "./schema";

/** Which model raised a finding — the compiler's `origin` enum. */
export const FINDING_ORIGINS = ["claude", "codex"] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

/**
 * How the two reviews landed on a finding — the compiler's `agreement` enum.
 *
 * Deliberately NOT the schema's `accord` words (`concur | split | conflict`), where `split`
 * means "one model raised it, the other said no concern" — a solo. Reusing `split` would
 * make the `agreement → accord` map below read like a bug. These words map without a
 * collision: `diverge` is the both-raised-different-verdict case, `solo` the one-model case.
 */
export const COMPILE_AGREEMENTS = ["concur", "diverge", "solo"] as const;
export type CompileAgreement = (typeof COMPILE_AGREEMENTS)[number];

/** The author a finding carries, by the model that raised it. Matches `SEAT_BOARD_VOICE`. */
export function flaggedOriginAuthor(origin: FindingOrigin): Author {
  return {
    kind: "lens-agent",
    id: origin === "claude" ? "lens:flagged:claudeAgent" : "lens:flagged:codex",
  };
}

/** The concurrence-tally model label for a model. Matches the pipeline's seat labels. */
export function flaggedOriginLabel(origin: FindingOrigin): string {
  return origin === "claude" ? "Claude" : "Codex";
}

/** The other model — the one whose tally joins `origin`'s when both raised a finding. */
function otherOrigin(origin: FindingOrigin): FindingOrigin {
  return origin === "claude" ? "codex" : "claude";
}

/** One per-model concurrence tally, as it sits on a finding's `concurrence` array. */
export interface ConcurrenceTally {
  readonly model: string;
  readonly agree: number;
  readonly total: number;
}

/** The host-owned finding fields the compiler's two enums expand into. */
export interface FindingCompileExpansion {
  readonly author: Author;
  readonly concurrence: readonly ConcurrenceTally[];
  readonly accord: FindingAccord;
}

/**
 * Expand the compiler's `origin` + `agreement` into the finding's host-owned `author`,
 * `concurrence`, and `accord`. `concur` and `diverge` are both-raised (two tallies,
 * differing only in accord); `solo` is the one-model case (one tally).
 */
export function expandFindingCompile(
  origin: FindingOrigin,
  agreement: CompileAgreement,
): FindingCompileExpansion {
  const author = flaggedOriginAuthor(origin);
  const tally = (o: FindingOrigin): ConcurrenceTally => ({
    model: flaggedOriginLabel(o),
    agree: 1,
    total: 1,
  });
  if (agreement === "solo") {
    return { author, concurrence: [tally(origin)], accord: "split" };
  }
  return {
    author,
    concurrence: [tally(origin), tally(otherOrigin(origin))],
    accord: agreement === "concur" ? "concur" : "conflict",
  };
}
