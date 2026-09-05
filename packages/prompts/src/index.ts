/**
 * Lens-agent drafting instructions for the murder-board redesign (#452, #464).
 *
 * Each lens is drafted by a review agent on a fixed prompt. Production validates
 * and freezes that return without a separate model editor turn. A landed round's
 * report uses a narrow classifier prompt and host-owned board structure instead.
 * The prompts live as markdown files in ./prompts so they are authored and
 * reviewed as prose; this module is the typed manifest over them. The package is
 * node-free — a caller with filesystem access resolves the file names against
 * its own copy of the package.
 */

// The RSP prompt contracts, prompt-layer assembly, and verification/ci prompt
// renderers absorbed from the deleted `@rennet/instructions` package (B02).
export * from "./prompt-contracts";

// The lens id vocabulary lives in @rennet/protocol's manifests seam (B3, #489);
// this package keeps the prompt FILES and re-exports the ids its manifest keys off.
import type { LensKind } from "@rennet/protocol";

export { LENS_KINDS, type LensKind } from "@rennet/protocol";

/** Prompt file for each lens's drafting agent, relative to this package's src/. */
export const LENS_PROMPT_FILES: Record<LensKind, string> = {
  design: "prompts/design.md",
  sequence: "prompts/sequence.md",
  decisions: "prompts/decisions.md",
  flagged: "prompts/flagged.md",
  noise: "prompts/noise.md",
};

/**
 * Prompt file for the round-report classifier — the per-round seat that verifies
 * what the exact coding-turn diff did with the reviewer's durable asks. It runs
 * FIRST when a landed round returns; the host turns its narrow classification
 * into the deterministic report board that greets the reviewer and feeds the
 * lens drafters. It is not a lens and does not use generic board post-processing.
 */
export const ROUND_REPORT_FILE = "prompts/report.md";

/**
 * The "Investigate before you draft" partial every lens file carries. One file, so
 * the five lens prompts cannot drift apart on it (#737).
 */
export const INVESTIGATE_PARTIAL_FILE = "prompts/investigate-before-you-draft.md";

/**
 * The "How you write this board" partial (`lens-board-tools` 3.6): the tool vocabulary
 * that replaced each lens prompt's "your output is a draft board of typed blocks in the
 * schema supplied with your task".
 *
 * Shared for the reason the investigate partial is: it is byte-identical across five
 * files and CLAUDE.md forbids duplicating an instruction block rather than sharing a
 * partial. What each lens keeps for itself is the one line naming its OWN verb, which is
 * the only part that differs.
 */
export const WRITE_WITH_TOOLS_PARTIAL_FILE = "prompts/write-with-tools.md";

/** The marker line a lens prompt carries where the investigate partial is spliced in. */
export const PROMPT_PARTIAL_MARKER = "{{investigate-before-you-draft}}";

/** The marker line a lens prompt carries where the tool-vocabulary partial goes. */
export const WRITE_WITH_TOOLS_MARKER = "{{write-with-tools}}";

/** Marker → the partial file whose text replaces it. The manifest test reads this. */
export const PROMPT_PARTIALS: Readonly<Record<string, string>> = {
  [PROMPT_PARTIAL_MARKER]: INVESTIGATE_PARTIAL_FILE,
  [WRITE_WITH_TOOLS_MARKER]: WRITE_WITH_TOOLS_PARTIAL_FILE,
};

/**
 * Splice the shared partials into a lens prompt at their marker lines, keyed by marker.
 * A text without a marker passes through unchanged: test doubles hand the pipeline stub
 * prompts, and the shipped files are guarded by the manifest test (every lens file carries
 * every marker exactly once) and the prompt-size tripwire, not by this seam.
 */
export function expandPromptPartials(
  text: string,
  partials: Readonly<Record<string, string>>,
): string {
  let out = text;
  for (const [marker, partial] of Object.entries(partials)) {
    out = out.replace(marker, partial.trimEnd());
  }
  return out;
}

/**
 * Writing rules the orchestrator applies when authoring or reworking the living
 * review draft in the reviewer's first-person GitHub register.
 */
export const REVIEW_DRAFT_VOICE_FILE = "prompts/review-draft-voice.md";
