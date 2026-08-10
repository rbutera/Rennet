/**
 * The adapter half of per-finding verification (issue #179): the REAL-file read and
 * the fresh verification session. `core`'s `runFindingVerification` is pure and
 * node-free; this is the store/model I/O it injects, keeping the dependency arrow
 * (deterministic gate + pure logic in core; I/O in adapters) intact.
 *
 *   • createVerificationFileReader — resolves a finding's anchor to the REAL file
 *     content AROUND it (more than the offered hunk), reading the working tree at
 *     the review's repository root. Fail-closed: an unknown hunk, an unsafe path, or
 *     an unreadable file returns `undefined`, which core turns into an honest
 *     "could not verify" caveat (never a drop, never a clear).
 *   • createVerificationTurn — a FRESH read-only session per verification, output-
 *     constrained to the verification schema, mapping the harness outcome into the
 *     turn result core parses. The CALLER chooses the seat (by default a model other
 *     than the one that raised the finding, so a model never certifies its own claim).
 *
 * Note on `context.file` (design §③): the ProjectSnapshot's `context.file` serves
 * STRUCTURAL data (symbols, blob identity) — not raw source lines — so "the real
 * file content around the anchor" is read here from the working tree at the pinned
 * root. This is the honest reading of the design intent: the verifier is fed more
 * than the offered hunk, from the actual code, and the read is fail-closed.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type {
  HarnessPort,
  VerificationFileReader,
  VerificationFileWindow,
  VerificationTurnResult,
} from "@rennet/core";
import { findingVerificationJsonSchema } from "@rennet/protocol";
import type { Hunk } from "@rennet/types";

/** Extra file lines to read on EACH side of a finding's hunk (the "more than the hunk" window). */
export const DEFAULT_VERIFICATION_CONTEXT_LINES = 40;

/** Parse a `rennet:hunk/<id>` finding anchor to its hunk id; null when it is not that shape. */
function hunkIdFromAnchor(anchor: string): string | null {
  const withoutScheme = anchor.startsWith("rennet:") ? anchor.slice("rennet:".length) : anchor;
  // Drop any within-occurrence span suffix (`@…`) — the file is keyed by the hunk id.
  const body = withoutScheme.split("@")[0] ?? "";
  const [kind, id, ...rest] = body.split("/");
  if (kind !== "hunk" || id === undefined || id.length === 0 || rest.length > 0) return null;
  return id;
}

/** True for a repo-relative path that stays inside the root (no absolute, no `..` escape). */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return !normalized.startsWith("..") && !normalized.split(/[\\/]/).includes("..");
}

export interface VerificationFileReaderOptions {
  /** The change's hunks (from the decomposition): the anchor → file + line map. */
  readonly hunks: readonly Hunk[];
  /** The review's repository root — the working tree the post-change file is read from. */
  readonly repositoryRoot: string;
  /** Lines to include each side of the hunk. Default {@link DEFAULT_VERIFICATION_CONTEXT_LINES}. */
  readonly contextLines?: number;
  /**
   * The file read, injected for hermetic tests. Returns the file's text, or
   * `undefined` when it cannot be read (missing, binary, oversize) — the reader then
   * yields `undefined` and core caveats the finding. Defaults to a guarded UTF-8 read.
   */
  readonly readFile?: (absolutePath: string) => string | undefined;
}

/** A guarded working-tree read: any failure (missing, unreadable) is `undefined`, never a throw. */
function defaultReadFile(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Build the {@link VerificationFileReader} core injects: anchor → real file window.
 * The window is centred on the hunk's post-change line range, widened by
 * `contextLines` each side and clamped to the file — strictly more than the offered
 * hunk. Fail-closed at every step (unknown hunk, unsafe path, unreadable file →
 * `undefined`).
 */
export function createVerificationFileReader(
  options: VerificationFileReaderOptions,
): VerificationFileReader {
  const contextLines = Math.max(
    0,
    Math.floor(options.contextLines ?? DEFAULT_VERIFICATION_CONTEXT_LINES),
  );
  const readFile = options.readFile ?? defaultReadFile;
  const hunksById = new Map<string, Hunk>();
  for (const hunk of options.hunks) hunksById.set(hunk.id, hunk);

  return async function readFileWindow(
    anchor: string,
  ): Promise<VerificationFileWindow | undefined> {
    const hunkId = hunkIdFromAnchor(anchor);
    if (hunkId === null) return undefined;
    const hunk = hunksById.get(hunkId);
    if (hunk === undefined) return undefined;
    if (!isSafeRelativePath(hunk.filePath)) return undefined;

    const content = readFile(join(options.repositoryRoot, hunk.filePath));
    if (content === undefined) return undefined;

    const lines = content.split("\n");
    const total = lines.length;
    // The hunk's post-change span (1-based). A pure deletion (newLines 0) anchors at
    // its `newStart` insertion point; clamp both ends into the file.
    const spanStart = Math.max(1, hunk.newStart);
    const spanEnd = Math.max(spanStart, hunk.newStart + Math.max(0, hunk.newLines) - 1);
    const startLine = Math.max(1, spanStart - contextLines);
    const endLine = Math.min(total, spanEnd + contextLines);
    const text = lines.slice(startLine - 1, endLine).join("\n");

    return { path: hunk.filePath, startLine, endLine, text };
  };
}

export interface VerificationTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The seat's model — by DEFAULT one OTHER than the seat that raised the finding. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the fresh-session verification turn core injects. Each call opens a NEW
 * read-only session (no contamination from the generating model's context),
 * output-constrained to the verification schema, sends the prompt, drains to the
 * terminal frame, and maps it: a completed turn with `structuredOutput` is an
 * emitted body (threading the real token usage when the frame carried it); anything
 * else is a turn failure — which core turns into an honest inconclusive, never a
 * drop. The session is always closed.
 */
export function createVerificationTurn(
  port: HarnessPort,
  options: VerificationTurnOptions,
): (prompt: string) => Promise<VerificationTurnResult> {
  const outputSchema = findingVerificationJsonSchema();
  return async function runVerificationTurn(prompt: string): Promise<VerificationTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      readOnly: true,
      outputSchema,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") {
          return { status: "failed", message: event.error.message };
        }
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                message: "the harness completed the verification turn without structured output",
              };
            }
            return {
              status: "emitted",
              body: outcome.structuredOutput,
              ...(outcome.usage === undefined ? {} : { tokens: outcome.usage }),
            };
          }
          if (outcome.status === "failed") {
            return { status: "failed", message: outcome.error.message };
          }
          return { status: "failed", message: "the verification turn was cancelled" };
        }
      }
      return {
        status: "failed",
        message: "the verification stream ended without a terminal frame",
      };
    } finally {
      await session.close();
    }
  };
}
