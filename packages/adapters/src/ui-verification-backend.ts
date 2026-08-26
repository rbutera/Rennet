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
 *   • beginUiEvidenceRun — create a review/patchset/run namespace under app user
 *     data, so a slow stale turn cannot overwrite the evidence a newer result binds.
 *   • readUiEvidence — the confined read behind the `review.uiEvidence` command: read
 *     ONE screenshot from a review's evidence directory and return it base64
 *     data-URL encoded. Path resolution is CONFINED to that directory — an escaping
 *     path, or a file that no longer resolves, returns `null` (the strip then shows a
 *     plain missing-evidence note). This is correctness of the read, not a gate.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type {
  HarnessPort,
  RunUiVerificationResult,
  UiEvidenceInspection,
  VerificationTurnResult,
} from "@rennet/core";
import { MAX_UI_EVIDENCE_BYTES, uiVerificationJsonSchema } from "@rennet/protocol";
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

/** Maximum completed patchset namespaces retained per transient review. */
export const MAX_RETAINED_UI_EVIDENCE_PATCHSETS = 4;

export interface UiEvidenceRun {
  readonly reviewKey: string;
  readonly patchsetKey: string;
  readonly runId: string;
  readonly reviewDir: string;
  readonly patchsetDir: string;
  readonly directory: string;
  /** Path prefix stored on screenshot references, relative to the review dir. */
  readonly namespace: string;
}

interface LatestRun {
  readonly runId: string;
  active: boolean;
}

const latestRuns = new Map<string, LatestRun>();

function safeComponent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runKey(reviewKey: string, patchsetKey: string): string {
  return `${reviewKey}\0${patchsetKey}`;
}

function reviewEvidenceDir(root: string, reviewId: string): string {
  return join(root, `review-${safeComponent(reviewId)}`);
}

/**
 * Create an isolated evidence namespace for one patchset run. A slow superseded
 * turn can only write its own run directory, never the namespace a newer result
 * exposes to the renderer.
 */
export async function beginUiEvidenceRun(
  root: string,
  reviewId: string,
  patchsetId: string,
  runId: string = randomUUID(),
): Promise<UiEvidenceRun> {
  const reviewKey = safeComponent(reviewId);
  const patchsetKey = safeComponent(patchsetId);
  const reviewDir = reviewEvidenceDir(root, reviewId);
  const patchsetDir = join(reviewDir, `patch-${patchsetKey}`);
  const directory = join(patchsetDir, `run-${safeComponent(runId)}`);
  await mkdir(directory, { recursive: true });
  latestRuns.set(runKey(reviewKey, patchsetKey), { runId, active: true });
  return {
    reviewKey,
    patchsetKey,
    runId,
    reviewDir,
    patchsetDir,
    directory,
    namespace: `${basename(patchsetDir)}/${basename(directory)}`,
  };
}

/** Bind screenshot references to the exact run directory that produced them. */
export function bindUiEvidenceRun(
  result: RunUiVerificationResult,
  run: UiEvidenceRun,
): RunUiVerificationResult {
  if (result.status.status !== "ran") return result;
  return {
    ...result,
    status: {
      ...result.status,
      screenshots: result.status.screenshots.map((screenshot) => ({
        ...screenshot,
        path: `${run.namespace}/${screenshot.path}`,
      })),
    },
  };
}

/**
 * Finalize retention after an enrichment completes. Only the newest run registered
 * for a patchset may prune its siblings; a stale completion removes only itself and
 * cannot delete the newer evidence whose metadata won the race.
 */
export async function completeUiEvidenceRun(run: UiEvidenceRun, keep: boolean): Promise<void> {
  try {
    await completeUiEvidenceRunUnchecked(run, keep);
  } catch {
    // Retention is opportunistic. A cleanup failure must not strand a completed
    // informational result or turn screenshot housekeeping into a product gate.
  }
}

async function completeUiEvidenceRunUnchecked(run: UiEvidenceRun, keep: boolean): Promise<void> {
  const key = runKey(run.reviewKey, run.patchsetKey);
  const latest = latestRuns.get(key);
  if (latest?.runId !== run.runId) {
    await rm(run.directory, { recursive: true, force: true });
    return;
  }
  latest.active = false;
  const entries = await readdir(run.patchsetDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(run.patchsetDir, entry.name);
    if (path === run.directory && keep) continue;
    await rm(path, { recursive: true, force: true });
  }
  if (!keep) await rm(run.patchsetDir, { recursive: true, force: true });
  await pruneReviewEvidence(run.reviewDir, run.reviewKey);
}

async function pruneReviewEvidence(reviewDir: string, reviewKey: string): Promise<void> {
  const entries = await readdir(reviewDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ path: string; modified: number; patchsetKey: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("patch-")) continue;
    const patchsetKey = entry.name.slice("patch-".length);
    if (latestRuns.get(runKey(reviewKey, patchsetKey))?.active) continue;
    const path = join(reviewDir, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info) candidates.push({ path, modified: info.mtimeMs, patchsetKey });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  for (const candidate of candidates.slice(MAX_RETAINED_UI_EVIDENCE_PATCHSETS)) {
    await rm(candidate.path, { recursive: true, force: true });
    latestRuns.delete(runKey(reviewKey, candidate.patchsetKey));
  }
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
): Promise<{ status: "ok"; dataUrl: string } | { status: "oversized" } | null> {
  const resolved = await resolveUiEvidenceFile(reviewEvidenceDir(root, reviewId), relPath);
  if (!resolved) return null;
  if (resolved.size > MAX_UI_EVIDENCE_BYTES) return { status: "oversized" };
  try {
    const bytes = await readFile(resolved.path);
    return {
      status: "ok",
      dataUrl: `data:${mimeForPath(relPath)};base64,${bytes.toString("base64")}`,
    };
  } catch {
    return null;
  }
}

/** Filesystem proof used by core before it calls a turn mounted/reproduced. */
export async function inspectUiEvidence(
  evidenceDir: string,
  relPath: string,
): Promise<UiEvidenceInspection> {
  const resolved = await resolveUiEvidenceFile(evidenceDir, relPath);
  if (!resolved) return { status: "not-found" };
  return resolved.size > MAX_UI_EVIDENCE_BYTES ? { status: "oversized" } : { status: "present" };
}

async function resolveUiEvidenceFile(
  directory: string,
  relPath: string,
): Promise<{ path: string; size: number } | null> {
  try {
    const canonicalDir = await realpath(directory);
    const candidate = join(canonicalDir, relPath);
    const canonicalFile = await realpath(candidate);
    const back = relative(canonicalDir, canonicalFile);
    if (back.length === 0 || back.startsWith("..") || isAbsolute(back)) return null;
    const info = await stat(canonicalFile);
    if (!info.isFile()) return null;
    return { path: canonicalFile, size: info.size };
  } catch {
    return null;
  }
}
