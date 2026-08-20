import type {
  NoiseCategory,
  NoiseGroup,
  NoiseItem,
  NoiseJudgedBy,
  NoiseReview,
} from "@rennet/types";

/**
 * The Noise lens, pure derivation (issue #34).
 *
 * The Noise lens groups the low-signal churn a changeset touches — formatting,
 * lockfile regeneration, import reordering, generated output, fixture renames,
 * comment typos — AWAY from the code that needs eyes. This module folds a review's
 * `NoiseReview` input into an ordered, host-free `NoiseIndex` the surface renders:
 * deterministic group ordering, the per-group judged-by chip (mechanical RULE vs
 * LLM NOISE JOB), the totality-floor accounting, and the deviating-line EJECTION
 * that lifts a line breaking its group's pattern OUT of the suppressed set and into
 * normal review. It is deliberately host-free (`@rennet/ui` imports only types) so
 * every rule here is unit-testable without Electron.
 *
 * The rules, from the issue:
 *   • Noise renders as GROUPED, collapsed churn, one plain-speech summary per group.
 *   • Each group carries a JUDGED-BY chip: a deterministic mechanical `rule`, or the
 *     LLM `noise-job` — mechanical certainty kept distinct from a model's call.
 *   • The TOTALITY FLOOR: nothing is silently hidden. `suppressedTotal` is exactly
 *     the churn grouped away, and a DEVIATING line is never suppressed — it ejects
 *     into normal review, so `suppressedTotal + ejected.length` == every item in.
 *   • Ordered by category then groupId (then anchor), so the index is a pure
 *     function of the group SET — input order never matters.
 *   • A review that RAN and grouped nothing is honestly EMPTY, distinct from a
 *     runner that FAILED (an all-clear that masks a runner that never ran is a lie).
 *   • A malformed group (or item) can never surface as noise — the guard is strict.
 */

export type { NoiseCategory, NoiseItem, NoiseJudgedBy } from "@rennet/types";

/** The fixed category order for deterministic group placement (matches the union). */
const CATEGORY_RANK: Record<NoiseCategory, number> = {
  formatting: 0,
  lockfile: 1,
  "import-order": 2,
  generated: 3,
  "fixture-rename": 4,
  "comment-typo": 5,
  other: 6,
};

/** One collapsed group row: its summary, judged-by chip, and the SUPPRESSED items. */
export interface NoiseGroupRow {
  groupId: string;
  category: NoiseCategory;
  summary: string;
  judgedBy: NoiseJudgedBy;
  /** The items grouped away (collapsed, inspectable). Deviating lines are NOT here. */
  items: NoiseItem[];
  /** How many churn items this group suppressed (== `items.length`). */
  suppressedCount: number;
}

/**
 * A line that broke its group's pattern and EJECTED into normal review. It is not
 * suppressed — the totality floor's deviating-line ejection surfaces it loudly so a
 * change hiding inside noise is never lost. Carries its origin group for context.
 */
export interface NoiseEjection {
  groupId: string;
  category: NoiseCategory;
  anchor: string;
  detail: string;
}

/**
 * The derived noise index. `failed` is a runner that did not complete — a distinct
 * state from `ok` with zero groups (a review that ran and grouped nothing). The
 * surface renders these two differently; conflating them would tell the user "all
 * clear" when the truth is "we could not check".
 */
export type NoiseIndex =
  | { state: "failed"; reason: string }
  | {
      state: "ok";
      groups: NoiseGroupRow[];
      /** Lines that deviated from their group's pattern, ejected into normal review. */
      ejected: NoiseEjection[];
      /** The totality-floor number: churn items grouped away (suppressed) across all groups. */
      suppressedTotal: number;
      groupCount: number;
      /** Per-judge counts for the header — mechanical rules vs LLM noise-job calls. */
      counts: { rule: number; noiseJob: number };
    };

function isNoiseCategory(value: unknown): value is NoiseCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORY_RANK, value);
}

function isJudgedBy(value: unknown): value is NoiseJudgedBy {
  if (typeof value !== "object" || value === null) return false;
  const judged = value as Record<string, unknown>;
  if (judged.kind === "rule") return typeof judged.rule === "string" && judged.rule.length > 0;
  if (judged.kind === "noise-job") {
    return typeof judged.model === "string" && judged.model.length > 0;
  }
  return false;
}

function isNoiseItem(value: unknown): value is NoiseItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.anchor === "string" &&
    item.anchor.length > 0 &&
    typeof item.detail === "string" &&
    (item.deviates === undefined || typeof item.deviates === "boolean")
  );
}

/**
 * The STRICT noise-group guard. A malformed group — a wrong category, a junk
 * judged-by, a non-array of items — can never render as noise. A group whose
 * `items` array contains a malformed entry is dropped whole rather than placed with
 * a silently-missing line (totality: a group we cannot fully account for is not a
 * group we may collapse away).
 */
export function isNoiseGroup(value: unknown): value is NoiseGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Record<string, unknown>;
  return (
    typeof group.groupId === "string" &&
    group.groupId.length > 0 &&
    isNoiseCategory(group.category) &&
    typeof group.summary === "string" &&
    isJudgedBy(group.judgedBy) &&
    Array.isArray(group.items) &&
    group.items.every(isNoiseItem)
  );
}

/** A total, locale-independent order (UTF-16 code units), matching core's ordering. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareGroups(left: NoiseGroup, right: NoiseGroup): number {
  return (
    CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category] ||
    compareCodeUnits(left.groupId, right.groupId)
  );
}

function compareItems(left: NoiseItem, right: NoiseItem): number {
  return compareCodeUnits(left.anchor, right.anchor) || compareCodeUnits(left.detail, right.detail);
}

/** Fold a review's noise input into the ordered index the surface renders. */
export function buildNoiseIndex(review: NoiseReview): NoiseIndex {
  if (review.status === "failed") {
    return { state: "failed", reason: review.reason };
  }
  // Defensive: a host or fixture that hands back a malformed input (no groups array)
  // must not crash the lens — treat it as an empty, honest read.
  const rawGroups = Array.isArray(review.groups) ? review.groups : [];
  // The guard is load-bearing: only well-formed groups become rows, so a malformed
  // group can never surface as collapsed-away noise.
  const groups = rawGroups.filter(isNoiseGroup).sort(compareGroups);

  const rows: NoiseGroupRow[] = [];
  const ejected: NoiseEjection[] = [];
  let suppressedTotal = 0;
  const counts = { rule: 0, noiseJob: 0 };

  for (const group of groups) {
    // Partition the group's items: a DEVIATING line breaks the group's pattern and
    // ejects into normal review; everything else is suppressed inside the group.
    const suppressed: NoiseItem[] = [];
    for (const item of group.items) {
      if (item.deviates) {
        ejected.push({
          groupId: group.groupId,
          category: group.category,
          anchor: item.anchor,
          detail: item.detail,
        });
      } else {
        suppressed.push(item);
      }
    }
    suppressed.sort(compareItems);
    rows.push({
      groupId: group.groupId,
      category: group.category,
      summary: group.summary,
      judgedBy: group.judgedBy,
      items: suppressed,
      suppressedCount: suppressed.length,
    });
    suppressedTotal += suppressed.length;
    if (group.judgedBy.kind === "rule") counts.rule += 1;
    else counts.noiseJob += 1;
  }

  ejected.sort(
    (left, right) =>
      CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category] ||
      compareCodeUnits(left.groupId, right.groupId) ||
      compareCodeUnits(left.anchor, right.anchor),
  );

  return { state: "ok", groups: rows, ejected, suppressedTotal, groupCount: rows.length, counts };
}
