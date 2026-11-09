/**
 * Classify a failed git invocation into something a person can act on
 * (review-preparation-reliability, design decision 5).
 *
 * Raw git stderr is the detail, never the message. The message is one plain sentence
 * about the object (the pull request, its large files, its commits) in sentence case and
 * without Rennet's own machinery nouns (DESIGN.md "No self-explaining chrome"); the action
 * is the one recovery that fits the cause.
 *
 * Matching is on stderr patterns and the spawn error code. Patterns drift with git
 * versions, which is why `unknown` is a full answer rather than a dead end: it still
 * carries plain copy, Retry, and the raw detail.
 *
 * Order matters and is deliberate: a missing tool is checked first, because its stderr
 * usually ends in a secondary symptom that would otherwise read as something else (the
 * observed `git-lfs: command not found` is followed by `fatal: the remote end hung up
 * unexpectedly`, which looks like a transport failure and is not one).
 */

/** The source-control tools Rennet depends on and can name in a failure. */
export type SourceControlToolId = "git" | "git-lfs";

/** What went wrong, as far as git's output says. */
export type GitFailureKind = "tool-missing" | "large-file" | "auth" | "ref-gone" | "unknown";

/** The one recovery the failure block offers for its kind. */
export type GitFailureAction = "install" | "choose-large-files" | "sign-in" | "retry";

export interface ClassifiedGitFailure {
  readonly kind: GitFailureKind;
  /** The tool that is missing, when `kind` is `tool-missing`. */
  readonly tool?: SourceControlToolId;
  /** One plain-language sentence for the person. Never git's own words. */
  readonly message: string;
  readonly action: GitFailureAction;
  /** Git's raw output, for a disclosure. Capped, with an honest marker when cut. */
  readonly detail: string;
}

export interface ClassifyGitFailureOptions {
  /** What was being checked out, for the message. Default `pull request`. */
  readonly subject?: "pull request" | "branch";
}

/** How much raw output `detail` keeps. Git's useful line is usually last, so the tail wins. */
export const GIT_FAILURE_DETAIL_CAP = 8_000;
const DETAIL_HEAD = 1_000;

const GIT_LFS_MISSING: readonly RegExp[] = [
  /git-lfs(?:\.exe)?: (?:command )?not found/i,
  /git-lfs(?:\.exe)?: No such file or directory/i,
  /'git-lfs(?:\.exe)?' is not recognized as an internal or external command/i,
  /git: 'lfs' is not a git command/i,
  /'git-lfs' was not found on your path/i,
];

const GIT_MISSING: readonly RegExp[] = [
  /(?:^|[\s:])git(?:\.exe)?: (?:command )?not found/im,
  /command not found: git(?:\.exe)?(?![\w-])/i,
  /'git(?:\.exe)?' is not recognized as an internal or external command/i,
  /spawn\s+\S*\bgit(?:\.exe)?\s+ENOENT/i,
  /xcrun: error: invalid active developer path/i,
];

const LARGE_FILE: readonly RegExp[] = [
  /smudge filter lfs failed/i,
  /external filter '?[^'\n]*lfs[^'\n]*'? failed/i,
  /\bgit-lfs\b/i,
  /\bLFS:/,
  /Error downloading object/i,
  /Smudge error/i,
  /batch response:/i,
];

const AUTH: readonly RegExp[] = [
  /Authentication failed/i,
  /could not read (?:Username|Password)/i,
  /terminal prompts disabled/i,
  /Permission denied \(publickey/i,
  /HTTP Basic: Access denied/i,
  /The requested URL returned error: 40[13]\b/i,
  /\b(?:HTTP|status(?: code)?:?)\s*40[13]\b/i,
  /Invalid username or (?:password|token)/i,
  /Repository not found/i,
];

const REF_GONE: readonly RegExp[] = [
  /unknown revision/i,
  /not our ref/i,
  /couldn't find remote ref/i,
  /invalid reference:/i,
  /not a valid object name/i,
  /reference is not a tree/i,
  /\bbad object\b/i,
  /did not match any file\(s\) known to git/i,
  /\bnot a commit\b/i,
];

/** The text a failure carries: execa's message (command + stderr) plus any stderr it
 *  did not already include, or the plain string/value thrown. */
function rawText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const withStreams = error as Error & { stderr?: unknown; stdout?: unknown };
    const parts = [error.message];
    for (const stream of [withStreams.stderr, withStreams.stdout]) {
      if (typeof stream === "string" && stream.length > 0 && !error.message.includes(stream)) {
        parts.push(stream);
      }
    }
    return parts.join("\n");
  }
  return String(error);
}

/** Keep the head (the command) and the tail (git's verdict), saying what was cut. */
function capDetail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= GIT_FAILURE_DETAIL_CAP) return trimmed;
  const tail = GIT_FAILURE_DETAIL_CAP - DETAIL_HEAD;
  const omitted = trimmed.length - DETAIL_HEAD - tail;
  return `${trimmed.slice(0, DETAIL_HEAD)}\n… ${omitted} characters omitted …\n${trimmed.slice(-tail)}`;
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function spawnedGitMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const spawn = error as Error & { code?: unknown; path?: unknown; syscall?: unknown };
  if (spawn.code !== "ENOENT") return false;
  const named = typeof spawn.path === "string" ? spawn.path : error.message;
  return /\bgit(?:\.exe)?\b/i.test(named) && !/git-lfs/i.test(named);
}

/**
 * Classify a failed git call. Accepts whatever was thrown: an execa error, a plain
 * `Error`, or a string of captured output.
 */
export function classifyGitFailure(
  error: unknown,
  options: ClassifyGitFailureOptions = {},
): ClassifiedGitFailure {
  const subject = options.subject ?? "pull request";
  const text = rawText(error);
  const detail = capDetail(text);

  if (matches(GIT_LFS_MISSING, text)) {
    return {
      kind: "tool-missing",
      tool: "git-lfs",
      message: `Git LFS isn't installed, so this ${subject}'s large files can't be checked out.`,
      action: "install",
      detail,
    };
  }
  if (spawnedGitMissing(error) || matches(GIT_MISSING, text)) {
    return {
      kind: "tool-missing",
      tool: "git",
      message: `Git isn't installed, so this ${subject} can't be checked out.`,
      action: "install",
      detail,
    };
  }
  if (matches(LARGE_FILE, text)) {
    return {
      kind: "large-file",
      message: `This ${subject}'s large files couldn't be downloaded. You can skip them and review without them.`,
      action: "choose-large-files",
      detail,
    };
  }
  if (matches(AUTH, text)) {
    return {
      kind: "auth",
      message: `The repository's host didn't accept your sign-in, so this ${subject} couldn't be fetched.`,
      action: "sign-in",
      detail,
    };
  }
  if (matches(REF_GONE, text)) {
    return {
      kind: "ref-gone",
      message: `This ${subject}'s commits can't be found. It may have been force-pushed or deleted.`,
      action: "retry",
      detail,
    };
  }
  return {
    kind: "unknown",
    message: `This ${subject} couldn't be checked out.`,
    action: "retry",
    detail,
  };
}
