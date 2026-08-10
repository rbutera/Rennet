import { createHash } from "node:crypto";
import type { PatchFile, PatchsetSpecSnapshot } from "@rennet/types";

/**
 * Immutable spec-set capture for the patchset intent (#136).
 *
 * A review's captured intent freezes not just the PR title/body but the spec
 * documents the change shipped against, so the spec view renders what the change
 * was reviewed against rather than a later-edited working-tree version. This
 * module owns the two surface-agnostic pieces: which changed files count as spec
 * documents, and how one document's captured text becomes an immutable snapshot.
 * The READ of the content is the caller's concern (committed content at the head
 * OID for a GitHub PR; the working-tree file for a local review), because those
 * differ per surface; everything downstream of the read is shared here so the two
 * paths cannot drift.
 */

/**
 * The cap on inlining a spec document's text. Over it, the snapshot keeps a
 * full-content digest but drops the inlined body (identity without the payload),
 * so a pathological spec cannot bloat the stored patchset.
 */
export const SPEC_SNAPSHOT_INLINE_LIMIT = 128 * 1024;

/**
 * Whether a changed-file path is a spec / openspec document the change shipped
 * against. Deliberately conservative and deterministic: the committed spec surface
 * (`openspec/…`), an explicit `specs/` directory, and the `*.spec.md` convention.
 * `.spec.ts` (a test file) is intentionally NOT matched.
 */
export function isSpecPath(path: string): boolean {
  return (
    path.startsWith("openspec/") ||
    path.includes("/specs/") ||
    path.startsWith("specs/") ||
    path.endsWith(".spec.md")
  );
}

/** The spec documents in a changeset — the changed files that are spec paths. */
export function specPathsOf(files: readonly PatchFile[]): string[] {
  return files.map((file) => file.path).filter(isSpecPath);
}

/**
 * Freeze one spec document's captured text into an immutable snapshot: a
 * full-content sha256 always, plus the inlined content when it is under the cap.
 * The digest is over the FULL content even when the body is dropped, so identity
 * is stable regardless of the inlining decision.
 */
export function snapshotSpec(path: string, content: string): PatchsetSpecSnapshot {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes <= SPEC_SNAPSHOT_INLINE_LIMIT ? { path, digest, content } : { path, digest };
}
