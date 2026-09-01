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
 * Frozen prompt file for the optional post-processing Council role. It contains
 * prose-only editing rules for explicit callers; the production lens scheduler
 * and classified round-report path do not invoke it.
 */
export const POST_PROCESS_FILE = "prompts/post-process.md";

/**
 * Writing rules the orchestrator applies when authoring or reworking the living
 * review draft in the reviewer's first-person GitHub register.
 */
export const REVIEW_DRAFT_VOICE_FILE = "prompts/review-draft-voice.md";
