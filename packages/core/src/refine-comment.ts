import type { DispositionType, RefinementResult } from "@rennet/protocol";

export type { RefinementResult };

// ─────────────────────────────────────────────────────────────────────────────
// review.refine — the comment-refinement producer (issue #19, Model Council job
// `comment-refinement`, light tier).
//
// Rai's headline feature (voice, 2026-08-06): "write it messy → agent cleans it
// up → clean version lands on the PR." The user writes a lazy/vague note on a
// hunk; a real model turn returns a cleaned, well-phrased comment in the user's
// OWN first-person voice. The cleaned form becomes the item's `refined` body, and
// `effectiveBody` (packages/app-ui) prefers it through to the published payload — but
// ONLY after the user keeps it (refinement is an offer, never a silent rewrite).
//
// This module is the STRUCTURAL SIBLING of `review-ask.ts`, not the pipeline
// seats (rollup-narration et al): refinement is user-invoked, per-item, AFTER the
// review — it has no code manifest to byte-verify and no place in the review-build
// phase. So, exactly like `askReview`, this is a PURE router over an injected
// port: the model wiring is the caller's (the live `codex exec` seat is composed
// in apps/desktop, the same executor `review.ask`'s Codex leg uses), keeping this
// module node-free and testable with a fake.
//
// The one honesty invariant it owns (design doc §1.4 / §2.3): a "refined" verdict
// whose body is EMPTY or BYTE-IDENTICAL to the raw is NOT a refinement. Empty is a
// failure (the turn produced nothing usable); byte-identical is `no-change` (the
// raw was already clear — nothing agent-authored is adopted, so the raw is what
// posts). Anything else is a genuine `refined` offer the user then keeps or drops.
// A failed/unavailable turn NEVER silently returns the raw dressed as refined —
// the caller sees the honest state and the raw stays the effective body.
// ─────────────────────────────────────────────────────────────────────────────

/** The input the refiner reasons over — the user's note plus its context (Q5). */
export interface RefineCommentInput {
  /** The user's raw note, VERBATIM. Never mutated; the refiner reads it, never the reverse. */
  readonly raw: string;
  /** The disposition type — a request-change reads differently than a question. */
  readonly type: DispositionType;
  /**
   * Q5: the lens the user was on when they wrote the note. "request-change on the
   * decisions lens" disambiguates a terse note; absent when the host does not carry it.
   */
  readonly lens?: string;
  /** The anchor path the note is attached to, for the model's orientation. */
  readonly path?: string;
  /**
   * The pointer file naming the code the note refers to — its path, side and line range
   * (session-context-files, D4). The anchored hunk used to ride into the prompt as a
   * fenced diff; the refiner now opens the checkout itself, which is what makes the
   * output "investigated" rather than a blind copyedit. Absent ⇒ the refiner cleans from
   * the note alone, which is still the whole "messy in, clean out" promise.
   */
  readonly pointersPath?: string;
  /**
   * Where the reviewer's raw note was written, when it was too long to inline (over
   * {@link REFINE_INLINE_NOTE_MAX}). Absent ⇒ the note rides in the prompt, which is the
   * ordinary case and the ONE admitted inline exception in the no-inline-context rule.
   */
  readonly notePath?: string;
}

/**
 * The anchored-ask ceiling: a reviewer's raw note up to this many characters stays in
 * the prompt (spec `session-context-files`: "a short quoted excerpt selected by the
 * reviewer … at most 600 characters is the one admitted exception"). A longer note is
 * written to the session's context directory and named by {@link RefineCommentInput.notePath}.
 */
export const REFINE_INLINE_NOTE_MAX = 600;

/**
 * What the injected port returns — the outcome of ONE real model turn. `emitted`
 * carries the model's structured verdict; `unavailable`/`failed` are the two
 * honest degradations (no seat installed / the turn ran and did not produce a
 * usable structured result). The port NEVER fabricates a success.
 *
 * `model` is the model that ACTUALLY ran, when the port can observe it (e.g. from
 * a session-started frame). It exists because provenance must record what wrote
 * text under the user's name, NOT what the council planned to route to — a seat
 * that runs its harness default is honest only if it reports that default. When a
 * port cannot observe the runtime model, it omits this and the caller falls back
 * to the resolved model.
 */
export type RefinePortResult =
  | {
      readonly status: "emitted";
      readonly verdict: "refined" | "no-change";
      readonly refinedBody?: string;
      readonly model?: string;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The refiner port: takes the assembled prompt and runs one real turn. The caller
 * owns the harness wiring (the live Codex seat, or a fake in tests), so this
 * module never imports an adapter and stays pure.
 */
export type RefinePort = (prompt: string) => Promise<RefinePortResult>;

/**
 * The result the `review.refine` command returns to the renderer lives in
 * `@rennet/protocol` (`RefinementResult`, re-exported above) so the protocol schema
 * and this producer are typed to the SAME shape. `refined` carries a cleaned body
 * guaranteed non-empty and NOT byte-identical to the raw; `no-change` means the
 * raw was already clear; `unavailable`/`failed` are the honest degradations.
 */

/** A stable, human label for a disposition type inside the prompt. */
const TYPE_INTENT: Record<DispositionType, string> = {
  approve: "an approval note",
  "request-change": "a requested change",
  comment: "a comment",
  question: "a question",
};

/**
 * Assemble the refiner prompt. It is deliberately opinionated on the ONE thing
 * that matters (design doc OQ5, Rai's recommendation): the cleaned comment must
 * read as *the user on a good day*, first-person, their tone preserved — never a
 * bot, never an AI-attribution marker, never a rewrite that changes what they
 * meant. When the note is already clear it says so (`no-change`) rather than
 * paraphrasing for its own sake.
 */
export function buildRefinePrompt(input: RefineCommentInput): string {
  const lines: string[] = [
    "You are helping a code reviewer turn a rough review note into a clean, well-phrased comment they will post AS THEMSELVES on a pull request.",
    "",
    "Rules, in order of importance:",
    "1. Write in the reviewer's OWN first person. It must read like the reviewer wrote it on a good day — never like an assistant, and NEVER add any AI/bot attribution.",
    "2. Preserve their meaning and intent EXACTLY. Clarify and tighten the wording; do not add new asks, soften a firm point, or change what they are saying.",
    "3. Preserve their tone. If they were blunt, stay blunt; if casual, stay casual. Do not normalise them into corporate prose.",
    "4. Be concise and concrete. Fix grammar, fill in the obvious referent, and make the ask unambiguous — but do not pad.",
    "5. If the note is ALREADY clear and well-phrased, do not paraphrase it for its own sake — return the `no-change` verdict instead.",
    "",
    `The note is ${TYPE_INTENT[input.type]}.`,
  ];
  if (input.path !== undefined && input.path.trim() !== "") {
    lines.push(`It is attached to: ${input.path}`);
  }
  if (input.lens !== undefined && input.lens.trim() !== "") {
    lines.push(
      `The reviewer wrote it while on the "${input.lens}" lens (use this to disambiguate a terse note).`,
    );
  }
  if (input.pointersPath !== undefined && input.pointersPath.trim() !== "") {
    lines.push(
      "",
      `The code the note refers to is named in \`${input.pointersPath.trim()}\`, relative to your working directory: the file, the side and the line range. Read it and then read that code, for grounding — do not quote it back unless it helps the comment.`,
    );
  }
  lines.push(
    "",
    ...(input.notePath !== undefined && input.notePath.trim() !== ""
      ? [
          `The reviewer's raw note is in \`${input.notePath.trim()}\`, relative to your working directory. Read it verbatim — it is the thing you are cleaning up.`,
        ]
      : ["The reviewer's raw note:", "```", input.raw, "```"]),
    "",
    'Return JSON. If you improved the wording, use {"verdict":"refined","refinedBody":"<the cleaned comment>"}. If the note is already clear and needs no change, use {"verdict":"no-change"}.',
  );
  return lines.join("\n");
}

/**
 * Refine one raw note into a cleaned comment via the injected port. Pure and
 * deterministic given its port: it assembles the prompt, runs the one turn, and
 * maps the outcome, enforcing the honesty invariant (empty ⇒ failed;
 * byte-identical to the raw ⇒ no-change) so a "refined" result the caller adopts
 * is always a genuine improvement over what the user wrote.
 */
export async function refineComment(
  input: RefineCommentInput,
  port: RefinePort,
  model: string,
): Promise<RefinementResult> {
  const turn = await port(buildRefinePrompt(input));
  if (turn.status === "unavailable") return { status: "unavailable", reason: turn.reason };
  if (turn.status === "failed") return { status: "failed", reason: turn.reason };
  // Report the model that ACTUALLY ran when the port observed it; else the resolved
  // model. A seat running its harness default must not claim the council's planned
  // pick — that is a provenance lie about who wrote text under the user's name.
  const reportedModel = turn.model ?? model;
  if (turn.verdict === "no-change") return { status: "no-change", model: reportedModel };
  // verdict === "refined": the honesty floor the design doc's validator names.
  const refined = (turn.refinedBody ?? "").trim();
  if (refined.length === 0) {
    return { status: "failed", reason: "the refiner returned a refined verdict with no body" };
  }
  // Byte-identical (after trim) is not a refinement — it is `no-change`, so the
  // raw posts unchanged and nothing agent-authored is adopted without a real edit.
  if (refined === input.raw.trim()) return { status: "no-change", model: reportedModel };
  return { status: "refined", refined, model: reportedModel };
}
