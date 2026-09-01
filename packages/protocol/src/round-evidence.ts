/**
 * The round-report classifier's evidence contract (#727 + #726, design D5).
 *
 * ONE module declares every limit the classification boundary enforces, and the
 * classifier contract documentation (`docs/developing/concepts/lens-pipeline.md`)
 * carries the same numbers. A limit that lives in two places drifts; a limit that
 * lives in a comment is not a limit.
 *
 * The manifest replaces the verbatim `round.worker.diff` at the ONE boundary that
 * ever carried it. Ordinary lens drafters never received it and still do not — they
 * read the checkout they stand in.
 */

/**
 * The complete serialized manifest's UTF-8 budget. At or under it the manifest is
 * sent intact; over it is a typed local failure with ZERO provider calls. Nothing
 * truncates, splits, or summarizes to fit — a wrong limit must be visible and cheap
 * to change, not silently papered over with a shorter diff.
 */
export const ROUND_EVIDENCE_MANIFEST_MAX_BYTES = 262_144;

/** The manifest's entry cardinality limit, enforced beside the byte budget. */
export const ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES = 400;

/**
 * The classifier's raw response cap, enforced at the harness TRANSPORT boundary in
 * both the Claude and the Codex adapter — before structured-output decoding, because
 * core only ever sees decoded values.
 */
export const ROUND_REPORT_OUTPUT_MAX_BYTES = 131_072;

/**
 * The classifier's provider-side output-TOKEN cap — the limit the provider itself is
 * told about, so an over-long classification stops at the source instead of being
 * paid for and then rejected. Sized as the byte cap's peer (~4 UTF-8 bytes per token
 * for this JSON), which keeps {@link ROUND_REPORT_OUTPUT_MAX_BYTES} the backstop: the
 * byte cap is what actually FAILS the turn, at the transport boundary, on either
 * harness.
 *
 * ASYMMETRIC BY TRANSPORT, and honestly so. The Claude harness reads the cap from its
 * child environment (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). `codex` exposes no
 * model-output-token knob at all — neither an app-server turn parameter nor a config
 * override (verified against codex-cli 0.147.0; its `max_output_tokens` is the
 * code-mode `exec` TOOL's own budget, a different thing). A Codex classification is
 * therefore bounded by the byte cap alone. Enforce where enforcement exists; do not
 * pretend a limit is in force on a transport that has no way to hear it.
 */
export const ROUND_REPORT_OUTPUT_MAX_TOKENS = 32_768;

/**
 * The decoded cardinality limit on the `beyond asks` bucket, enforced before
 * persistence. Outcome cardinality needs no separate constant: it is exactly the
 * dispatched-ask count, one entry each, checked by the partition pass.
 */
export const ROUND_REPORT_MAX_BEYOND_ENTRIES = 100;

/**
 * A real changed line in the round diff. Only a text hunk has one. `path` is
 * SIDE-CORRECT: a base-side anchor on a renamed file names the source path, which
 * is not the unit's head path.
 */
export interface RoundEvidenceAnchor {
  readonly side: "base" | "head";
  readonly path: string;
  readonly line: number;
}

interface RoundEvidenceBase {
  /** `ev-` + 16 hex of the sha256 over the unit's identity (see `roundEvidenceId`). */
  readonly id: string;
  /** The head-side path, or the only path a deletion has. */
  readonly path: string;
}

/**
 * One text hunk, verbatim. `anchor` is the hunk's FIRST real changed line, read out
 * of the diff — the host cites it, the classifier never computes a line number.
 */
export interface RoundEvidenceTextHunk extends RoundEvidenceBase {
  readonly kind: "text-hunk";
  readonly previousPath?: string;
  /** The `@@` header plus the verbatim body lines, prefixes intact. */
  readonly text: string;
  readonly anchor: RoundEvidenceAnchor;
}

/** A binary change. No line anchor exists, so none is invented. */
export interface RoundEvidenceBinary extends RoundEvidenceBase {
  readonly kind: "binary";
  readonly previousPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
}

/** A file-mode change. No line anchor exists, so none is invented. */
export interface RoundEvidenceModeChange extends RoundEvidenceBase {
  readonly kind: "mode-change";
  readonly from: string;
  readonly to: string;
}

/** A rename. No line anchor exists, so none is invented — a renamed file that ALSO
 *  changed text carries its hunks as their own `text-hunk` units beside this one. */
export interface RoundEvidenceRename extends RoundEvidenceBase {
  readonly kind: "rename";
  readonly previousPath: string;
}

export type RoundEvidenceUnit =
  | RoundEvidenceTextHunk
  | RoundEvidenceBinary
  | RoundEvidenceModeChange
  | RoundEvidenceRename;

/** UTF-8 byte length. The ONE measure — never `string.length`, which counts UTF-16
 *  code units and undercounts every multibyte character in the manifest. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The ONE serializer. The byte budget is measured on exactly these bytes, and
 * exactly these bytes are what the prompt carries — so "at the limit" means the
 * same thing to the check and to the wire.
 */
export function serializeRoundEvidenceManifest(units: readonly RoundEvidenceUnit[]): string {
  return JSON.stringify(units);
}
