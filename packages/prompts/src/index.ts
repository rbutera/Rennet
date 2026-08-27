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

// The RSP prompt contracts, prompt-layer assembly, and verification/ci prompt
// renderers absorbed from the deleted `@rennet/instructions` package (B02).
export * from "./prompt-contracts";

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
 * Prompt file for the round-report drafter — the per-round seat that accounts
 * for what a work-order round did with the reviewer's asks (the successor
 * account, R34). It drafts FIRST when a round returns: the report is both the
 * reviewer's greeting and the lens drafters' input, so it gates the
 * regeneration. Not a lens (LENS_KINDS is the five boards); it funnels through
 * the same post-process pass.
 */
export const ROUND_REPORT_FILE = "prompts/report.md";

/**
 * Prompt file for the post-processing editor agent every draft board funnels
 * through: break-it-down structure rules, the unslop skill verbatim, and the
 * humanizer additions — prose fields only, typed data untouched.
 */
export const POST_PROCESS_FILE = "prompts/post-process.md";

/**
 * Writing rules the orchestrator applies write-through when authoring or
 * reworking the living review draft: the post-process steps in the
 * reviewer's first-person GitHub register.
 */
export const REVIEW_DRAFT_VOICE_FILE = "prompts/review-draft-voice.md";
