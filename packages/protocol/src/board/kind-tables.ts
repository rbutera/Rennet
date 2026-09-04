import { z } from "zod";
import { LENS_KINDS, type LensKind } from "../manifests";
import type { DraftKind } from "./schema";

/**
 * Which board kinds each drafting target authors — the one table that decides it.
 *
 * This lived in `core/src/board/lint.ts` until `lens-board-tools`, where it became
 * load-bearing in two places at once: `kind-allowlist` still reads it, and the per-seat
 * board tool surface is now DERIVED from it (`tool-schemas.ts`). `protocol` imports no
 * Rennet package, so the table had to come here for the tool surface to iterate it —
 * and having one copy is the point: a kind added to a lens row reaches both the lint
 * allowlist and that lens's verbs, with nothing else edited.
 *
 * Grounded in the lens prompts (`packages/prompts`): the Design prompt renders BOTH
 * requirement regions AND the implementer's stated `decision` calls (a projection the
 * Decisions board shares), so Design admits `decision` + `requirement`; the Decisions
 * prompt is decision-only. The report seat's `round_outcome` is legal ONLY on the report
 * target and never on a lens board (S1).
 */

/** A board drafting target: one of the five review lenses, or the round-report seat. */
export type BoardTarget = LensKind | "report";

/** Every drafting target, lenses in `LENS_KINDS` order then the report seat. */
export const BOARD_TARGETS: readonly BoardTarget[] = [...LENS_KINDS, "report"];

/**
 * The structural kinds every target may author. A typed kind on the wrong board is a
 * lane violation; these five are legal everywhere.
 */
export const SHARED_KINDS: readonly DraftKind[] = [
  "prose",
  "section",
  "callout",
  "annotation",
  "code_ref",
];

/** The typed domain kinds each lens owns. */
export const LENS_TYPED_KINDS: Readonly<Record<LensKind, readonly DraftKind[]>> = {
  design: ["decision", "requirement"],
  sequence: ["order_step"],
  decisions: ["decision"],
  flagged: ["finding"],
  noise: ["noise_verdict"],
};

/** The typed kinds the round-report seat owns. */
export const REPORT_TYPED_KINDS: readonly DraftKind[] = ["round_outcome"];

/** The typed kinds of every target, in one record so a caller can iterate or override it. */
export const TYPED_KINDS_BY_TARGET: Readonly<Record<BoardTarget, readonly DraftKind[]>> = {
  ...LENS_TYPED_KINDS,
  report: REPORT_TYPED_KINDS,
};

/** The typed kinds `target` authors, read from `table` (overridable so a test can vary it). */
export function typedKindsFor(
  target: BoardTarget,
  table: Readonly<Record<BoardTarget, readonly DraftKind[]>> = TYPED_KINDS_BY_TARGET,
): readonly DraftKind[] {
  return table[target];
}

/**
 * Every kind `target` may author: {@link SHARED_KINDS} ∪ its typed kinds, shared first
 * and in table order, deduplicated. This is the set both the kind allowlist and the
 * tool surface read.
 */
export function authorableKindsFor(
  target: BoardTarget,
  table: Readonly<Record<BoardTarget, readonly DraftKind[]>> = TYPED_KINDS_BY_TARGET,
): readonly DraftKind[] {
  const seen = new Set<DraftKind>();
  const out: DraftKind[] = [];
  for (const kind of [...SHARED_KINDS, ...typedKindsFor(target, table)]) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

// ── Absence admissibility (the other half of what a target's tool set carries) ─

export const LensAbsenceReasonSchema = z.enum([
  "no-material",
  "no-spec",
  "no-decisions",
  "no-findings",
  "no-noise",
]);
export type LensAbsenceReason = z.infer<typeof LensAbsenceReasonSchema>;

/**
 * Which absence each lens may honestly settle with (#549). This is the admissibility
 * half of the ONE canonical settlement domain — board / absence / failure, as
 * `lensBoards` / `absentLenses` / `failedLenses` already model it. Nothing may
 * introduce a second settlement model beside it.
 *
 * Sequence admits none: a review whose order board never arrived has nothing to read,
 * so an absent Sequence is a failure and never a clean result. Noise's `no-noise` is a
 * first-class SUCCESS — a change carrying no mechanical noise settled correctly, it did
 * not fail — and Design's `no-spec` is the same kind of success: the seat looked for the
 * specification this branch was written against and the repository holds none, so there is
 * nothing to render and no empty board is drafted.
 *
 * Design's `no-material` predates the spec respec (session-bound-workspace D6), when a host
 * bundle offered candidates and Design's absence was a grounded dismissal of them. It stays
 * admissible so generations persisted before the respec keep reading; nothing settles it now
 * ({@link LEGACY_LENS_ABSENCES}).
 *
 * It lives here, beside the kind tables, because a seat's tool set is derived from both:
 * the kinds decide its authoring verbs and this decides whether it gets a settle-absent
 * verb at all.
 */
export const LENS_ADMISSIBLE_ABSENCES: Readonly<Record<LensKind, readonly LensAbsenceReason[]>> = {
  design: ["no-material", "no-spec"],
  sequence: [],
  decisions: ["no-decisions"],
  flagged: ["no-findings"],
  noise: ["no-noise"],
};

/** True when `reason` is an absence `lens` may settle with as a success. */
export function lensAdmitsAbsence(lens: LensKind, reason: LensAbsenceReason): boolean {
  return LENS_ADMISSIBLE_ABSENCES[lens].includes(reason);
}

/**
 * Absences that stay READABLE on generations persisted before a respec but that nothing
 * settles now. They are admissible and they are not offered: a seat's settle-absent verb
 * names the absence its lens admits TODAY.
 */
export const LEGACY_LENS_ABSENCES: readonly LensAbsenceReason[] = ["no-material"];

/**
 * The one absence a target's settle-absent verb declares, or `undefined` when the target
 * admits none and therefore gets no such verb. DERIVED from
 * {@link LENS_ADMISSIBLE_ABSENCES} minus {@link LEGACY_LENS_ABSENCES}: Design settles
 * `no-spec`, Sequence settles nothing, and the report seat is not a lens and admits none.
 *
 * The verb carries a note and no reason field, so a seat cannot name an absence its lens
 * does not admit — there is nowhere to name it.
 */
export function settleAbsentReasonFor(target: BoardTarget): LensAbsenceReason | undefined {
  if (target === "report") return undefined;
  const live = LENS_ADMISSIBLE_ABSENCES[target].filter(
    (reason) => !LEGACY_LENS_ABSENCES.includes(reason),
  );
  return live.length === 1 ? live[0] : undefined;
}
