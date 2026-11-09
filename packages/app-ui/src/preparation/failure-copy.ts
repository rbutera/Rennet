import type { SessionPreparation } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A FAILURE SAYS FIRST (review-preparation-reliability D5/D6: "unknown failure → a
// plain-language summary, Retry, and the raw reason under details").
//
// A classified failure's `reason` is the daemon's own plain sentence, written for the
// reviewer, so it is the headline. An UNCLASSIFIED one is not: its `reason` is whatever the
// failing step said, and in practice that is daemon text — a seven-line wall, or "lens-draft-
// flagged resolved to no runnable review seat (no claude harness; no codex harness)". Reading
// that aloud as the headline is the raw error Rai complained about. So an unclassified failure
// gets a fixed plain headline, and its reason and detail move behind Details.
//
// One narrow exception, recognised by pattern because the daemon has no kind for it yet: no
// coding agent is installed. That is the one unclassified failure the reviewer can fix
// without reading anything, so the headline says what to do.
// ─────────────────────────────────────────────────────────────────────────────

type FailedPreparation = Extract<SessionPreparation, { status: "failed" }>;

/** The headline for a failure Rennet cannot name. */
export const UNCLASSIFIED_HEADLINE = "Rennet couldn't prepare this review.";

/** The headline when the failure says no coding agent is installed. */
export const NO_AGENT_HEADLINE =
  "No coding agent is installed, so Rennet can't draft this review. Install Claude Code or Codex, then Retry.";

/** The board's own line for a lens that could not run because no coding agent is installed. */
export const NO_AGENT_LENS_HEADLINE =
  "No coding agent is installed, so Rennet can't draft this lens. Install Claude Code or Codex.";

/**
 * Whether the failure text says no coding agent is installed. Deliberately narrow: it names
 * a harness by name ("no claude harness", "Codex is not installed"), never a bare
 * "not installed" — a missing Git LFS says that too, and has its own kind and recovery.
 */
export function saysNoCodingAgent(text: string): boolean {
  return (
    /\bno (?:claude|codex) harness\b/i.test(text) ||
    /\b(?:claude code|claude|codex)\b[^\n.;]*\bnot installed\b/i.test(text)
  );
}

export interface FailureCopy {
  /** The sentence the block leads with. */
  readonly headline: string;
  /** What goes behind Details, or undefined when there is nothing more to show. */
  readonly detail: string | undefined;
}

/** The headline and the Details text for a failed preparation. */
export function preparationFailureCopy(preparation: FailedPreparation): FailureCopy {
  const kind = preparation.kind ?? "unknown";
  if (kind !== "unknown") {
    return { headline: preparation.reason, detail: preparation.detail };
  }
  const raw = [preparation.reason, preparation.detail]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("\n\n");
  return {
    headline: saysNoCodingAgent(raw) ? NO_AGENT_HEADLINE : UNCLASSIFIED_HEADLINE,
    detail: raw.length > 0 ? raw : undefined,
  };
}

/** The headline for a lens board whose drafting failed; its reason goes behind Details. */
export function lensFailureHeadline(reason: string): string {
  return saysNoCodingAgent(reason) ? NO_AGENT_LENS_HEADLINE : "This lens failed to generate.";
}
