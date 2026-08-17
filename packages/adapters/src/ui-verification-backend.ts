/**
 * The adapter half of verify-ui (issue #183): the fresh capable turn that MOUNTS and
 * screenshots a UI-touching change, plus the review's evidence directory (where the
 * turn writes PNGs and the renderer reads them back). `core`'s `runUiVerification` is
 * pure and node-free; this is the harness + filesystem I/O it injects, keeping the
 * dependency arrow (deterministic gate + pure logic in core; I/O in adapters) intact.
 *
 *   • createUiVerificationTurn — a thin wrapper over the shared exec-observing turn
 *     (`createExecObservingTurn`), differing only in the structured-output schema
 *     (`uiVerificationJsonSchema`). It opens a NEW CAPABLE session (full toolset — it
 *     may install, build, run the dev server, drive a browser, WRITE the screenshot
 *     PNGs) and observes the commands it ran as independent proof the mount happened
 *     (issue #259), so `mounted: true` is grounded in execution, not intent.
 *   • resolveUiEvidenceDir — resolve and CREATE `<root>/<reviewId>/`, the directory
 *     the turn writes PNGs into and the renderer reads from. App-owned (under the
 *     app's user-data dir), so it persists with the review and never touches the
 *     user's repo (the `.rennet/` boundary is for repo-local context, not this).
 *   • readUiEvidence — the confined read behind the `review.uiEvidence` command: read
 *     ONE screenshot from a review's evidence directory and return it base64
 *     data-URL encoded. Path resolution is CONFINED to that directory — an escaping
 *     path, or a file that no longer resolves, returns `null` (the strip then shows a
 *     plain missing-evidence note). This is correctness of the read, not a gate.
 */

import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { HarnessPort, VerificationTurnResult } from "@rennet/core";
import { uiVerificationJsonSchema } from "@rennet/protocol";
import { createExecObservingTurn } from "./exec-observing-turn";

export interface UiVerificationTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The seat's model, when the caller pins one. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the fresh-session verify-ui turn core injects. Mirrors `createVerificationTurn`
 * (#179) exactly — a capable session with exec observation — differing only in the
 * structured-output schema (`uiVerificationJsonSchema`). Anything but a completed
 * structured emission is a turn failure, which core turns into the honest
 * could-not-mount `unavailable` disclosure, never a fabricated clear.
 */
export function createUiVerificationTurn(
  port: HarnessPort,
  options: UiVerificationTurnOptions,
): (prompt: string) => Promise<VerificationTurnResult> {
  return createExecObservingTurn(port, {
    cwd: options.cwd,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    outputSchema: uiVerificationJsonSchema(),
    label: "verify-ui",
  });
}

/**
 * Resolve and CREATE the review's evidence directory (`<root>/<reviewId>/`). Returns
 * its absolute path — passed into the turn prompt so the turn writes PNGs there, and
 * screenshot references are stored relative to it. Idempotent (`mkdir -p`).
 */
export async function resolveUiEvidenceDir(root: string, reviewId: string): Promise<string> {
  const dir = join(root, reviewId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Extension → data-URL mime for the screenshot read. Unknown ⇒ octet-stream (still renders as a link, never a crash). */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** True for a review-relative path that stays inside the evidence dir (no absolute, no `..` escape). */
function isConfinedRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return !normalized.startsWith("..") && !normalized.split(/[\\/]/).includes("..");
}

/**
 * Read one screenshot from a review's evidence directory, base64 data-URL encoded, for
 * the `review.uiEvidence` command. `relPath` is the review-relative reference from a
 * `UiScreenshot`. Fail-closed: an escaping path, or a missing/unreadable file, returns
 * `null` — never a throw, never a read outside the review's own evidence directory.
 */
export async function readUiEvidence(
  root: string,
  reviewId: string,
  relPath: string,
): Promise<{ dataUrl: string } | null> {
  if (!isConfinedRelativePath(relPath)) return null;
  const dir = join(root, reviewId);
  const absolute = join(dir, relPath);
  // Belt-and-braces: after joining, the resolved path must still sit under the dir.
  const back = relative(dir, absolute);
  if (back.startsWith("..") || isAbsolute(back)) return null;
  try {
    const bytes = await readFile(absolute);
    return { dataUrl: `data:${mimeForPath(relPath)};base64,${bytes.toString("base64")}` };
  } catch {
    return null;
  }
}
