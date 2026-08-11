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
 *   • createGitShowFileRead — the SAME reader's `readFile` seam, but sourcing a file's
 *     content at the reviewed HEAD OID via `git show <headOid>:<path>` (through the
 *     injected git runner) rather than off disk. This is the reviewed content for a
 *     range / PR / retrospective review, where the head is NOT necessarily the
 *     checked-out working tree. Same fail-closed contract (an unknown path or git
 *     error → `undefined` → honest inconclusive), never a crash, never fabricated text.
 *   • createVerificationFileReaderForPatchset — the composition seam: picks the
 *     working-tree reader for a working-tree review and the git-show reader for a
 *     range / PR / retrospective review, keyed on the patchset's captured surface.
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
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type {
  HarnessPort,
  VerificationFileReader,
  VerificationFileWindow,
  VerificationTurnResult,
} from "@rennet/core";
import { findingVerificationJsonSchema } from "@rennet/protocol";
import type { Hunk, Patchset } from "@rennet/types";
import type { GitExec } from "./git-range-diff";

/** Extra file lines to read on EACH side of a finding's hunk (the "more than the hunk" window). */
export const DEFAULT_VERIFICATION_CONTEXT_LINES = 40;

/**
 * The file-read seam the window reader injects: given the absolute path of a file at
 * the review's repository root, return its text, or `undefined` when it cannot be read
 * (missing, binary, oversize, git error). May be sync (the working-tree read) or async
 * (the git-show read) — the reader `await`s either.
 */
export type VerificationFileRead = (
  absolutePath: string,
) => string | undefined | Promise<string | undefined>;

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
   * The file read, injected for hermetic tests (and for the git-show-at-head source).
   * Returns the file's text, or `undefined` when it cannot be read (missing, binary,
   * oversize) — the reader then yields `undefined` and core caveats the finding.
   * Defaults to a guarded UTF-8 working-tree read.
   */
  readonly readFile?: VerificationFileRead;
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

    const content = await readFile(join(options.repositoryRoot, hunk.filePath));
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

export interface GitShowFileReadOptions {
  /** The injected git runner (the range engine's `execaGit`, or a fake in tests). */
  readonly git: GitExec;
  /** The local clone root — git's cwd, and the base the absolute path is relativised against. */
  readonly repositoryRoot: string;
  /** The reviewed head commit OID whose blob content is read (`repository.headOid`). */
  readonly headOid: string;
}

/**
 * A {@link VerificationFileRead} that reads a file's content at the reviewed HEAD OID
 * via `git show <headOid>:<path>`, for a range / PR / retrospective review whose head
 * is NOT necessarily the checked-out working tree. The reader passes the file's
 * absolute path (rooted at `repositoryRoot`); this relativises it back to the repo
 * path git wants (forward slashes). Fail-closed: an unsafe/escaping path, an empty
 * head OID, an unknown path at that OID, or any git error resolves to `undefined`
 * (core turns it into an honest inconclusive) — never a throw, never fabricated text.
 */
export function createGitShowFileRead(
  options: GitShowFileReadOptions,
): (absolutePath: string) => Promise<string | undefined> {
  return async function gitShowFileRead(absolutePath: string): Promise<string | undefined> {
    if (options.headOid.length === 0) return undefined;
    const relativePath = relative(options.repositoryRoot, absolutePath);
    if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.startsWith("..")) {
      return undefined;
    }
    // git addresses tree paths with forward slashes regardless of platform separator.
    const gitPath = relativePath.split(sep).join("/");
    try {
      // The default `reject: true` throws on a git error (unknown path / bad OID), which
      // the catch turns into `undefined`. An empty file returns "" successfully — a valid
      // (empty) window, NOT an error — so the two are never conflated.
      return await options.git(options.repositoryRoot, ["show", `${options.headOid}:${gitPath}`]);
    } catch {
      return undefined;
    }
  };
}

export interface VerificationFileReaderForPatchsetOptions {
  /** The review's active patchset — its `repository.root`/`headOid` and captured surface. */
  readonly patchset: Patchset;
  /** The change's hunks (from the decomposition): the anchor → file + line map. */
  readonly hunks: readonly Hunk[];
  /** The injected git runner, used for the git-show-at-head (range / PR / retrospective) path. */
  readonly git: GitExec;
  /** Lines to include each side of the hunk. Default {@link DEFAULT_VERIFICATION_CONTEXT_LINES}. */
  readonly contextLines?: number;
  /** Override the working-tree read (a hermetic-test seam for the on-disk branch only). */
  readonly readFile?: VerificationFileRead;
}

/** True when the patchset was captured from the live working tree (its content IS on disk). */
function isWorkingTreeReview(patchset: Patchset): boolean {
  return patchset.intent?.surface === "working-tree";
}

/**
 * Select the correct {@link VerificationFileReader} for a review's patchset (issue
 * #179 → PR/retrospective). This is the composition seam a verification pass calls
 * instead of `createVerificationFileReader` directly, so the reader matches the
 * review kind:
 *
 *   • WORKING-TREE review (`intent.surface === "working-tree"`): the reviewed content,
 *     including uncommitted edits, IS the working tree at `repository.root` — so read
 *     it off disk (today's behaviour, unchanged).
 *   • RANGE / PR / RETROSPECTIVE review (any other surface, including an absent intent
 *     — the range engine stamps none): the reviewed head is `repository.headOid`, which
 *     may not be the checked-out HEAD, so read the blob at that OID via `git show`.
 *
 * Fail-closed is preserved on both branches (unknown hunk/path/OID or read error →
 * `undefined` → honest inconclusive). Purely additive: `createVerificationFileReader`
 * is unchanged, and a caller that keeps using it directly sees today's behaviour.
 */
export function createVerificationFileReaderForPatchset(
  options: VerificationFileReaderForPatchsetOptions,
): VerificationFileReader {
  const repositoryRoot = options.patchset.repository.root;
  const base = {
    hunks: options.hunks,
    repositoryRoot,
    ...(options.contextLines === undefined ? {} : { contextLines: options.contextLines }),
  };
  if (isWorkingTreeReview(options.patchset)) {
    return createVerificationFileReader({
      ...base,
      ...(options.readFile ? { readFile: options.readFile } : {}),
    });
  }
  return createVerificationFileReader({
    ...base,
    readFile: createGitShowFileRead({
      git: options.git,
      repositoryRoot,
      headOid: options.patchset.repository.headOid,
    }),
  });
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
