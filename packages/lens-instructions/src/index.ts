/**
 * Lens-agent drafting instructions for the murder-board redesign (#452, #464).
 *
 * Each lens is drafted by a review agent on a fixed prompt; every draft then
 * passes through the unslop editor before the orchestrator composes the Board.
 * The prompts live as markdown files in ./prompts so they are authored and
 * reviewed as prose; this module is the typed manifest over them. The package
 * is node-free — a caller with filesystem access resolves the file names
 * against its own copy of the package.
 */

/** The five lenses, in display order: Design first, then the reading walk. */
export const LENS_KINDS = ["design", "sequence", "decisions", "flagged", "noise"] as const;

export type LensKind = (typeof LENS_KINDS)[number];

/** Prompt file for each lens's drafting agent, relative to this package's src/. */
export const LENS_PROMPT_FILES: Record<LensKind, string> = {
  design: "prompts/design.md",
  sequence: "prompts/sequence.md",
  decisions: "prompts/decisions.md",
  flagged: "prompts/flagged.md",
  noise: "prompts/noise.md",
};

/**
 * Prompt file for the editor agent every draft board funnels through: the
 * unslop skill applied to prose fields only, typed data untouched.
 */
export const UNSLOP_PASS_FILE = "prompts/unslop-pass.md";
