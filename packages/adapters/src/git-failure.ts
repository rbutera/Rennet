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
 * ⚠️ MATCH GIT'S OUTPUT, NEVER THE COMMAND LINE. execa's message opens with the command it
 * ran, and that command carries paths, refs and URLs the user chose: a worktree at
 * `…/upgrade-git-lfs`, a branch `fix/git-lfs`, a repository `acme/git-lfs-tools`. So the
 * patterns read stderr (and stdout) when the failure has any, and fall back to execa's
 * message only when git said nothing, as a spawn failure does. `detail` keeps everything.
 * For the same reason no pattern matches a bare `git-lfs` token: only git-lfs's own
 * diagnostics count.
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
  /command not found: git-lfs(?:\.exe)?(?![\w.-])/i,
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
  // A fresh Mac's /usr/bin/git shim, whether or not it could open the install dialog.
  /No developer tools were found/i,
];

const LARGE_FILE: readonly RegExp[] = [
  /smudge filter lfs failed/i,
  /external filter '?[^'\n]*lfs[^'\n]*'? failed/i,
  /(?:^|\s)LFS: /m,
  /Error downloading object/i,
  /Smudge error/i,
  /batch response:/i,
  /Encountered \d+ files? that should have been pointers/i,
];

/** execa's own words when the directory a command was to run in does not exist. The spawn
 *  then also fails with ENOENT, which says nothing about whether git is installed. */
const INVALID_CWD = /The "cwd" option is invalid/;

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

interface ExecaShaped {
  readonly stderr?: unknown;
  readonly stdout?: unknown;
  readonly shortMessage?: unknown;
  readonly code?: unknown;
  readonly cause?: unknown;
}

/** The text the patterns read: git's own output when it said anything, else execa's short
 *  message (which is all a spawn failure has), else the thrown string or message. */
function matchText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!(error instanceof Error)) return String(error);
  const shaped = error as Error & ExecaShaped;
  const streams = [shaped.stderr, shaped.stdout].filter(
    (stream): stream is string => typeof stream === "string" && stream.trim().length > 0,
  );
  if (streams.length > 0) return streams.join("\n");
  return typeof shaped.shortMessage === "string" && shaped.shortMessage.length > 0
    ? shaped.shortMessage
    : error.message;
}

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

/** The file a failed spawn tried to start: Node's own `path` on the error or its cause,
 *  else the `spawn <file> ENOENT` line execa repeats. */
function spawnedFile(error: Error & ExecaShaped & { path?: unknown }): string | undefined {
  if (typeof error.path === "string") return error.path;
  const cause = error.cause as { path?: unknown } | undefined;
  if (cause !== undefined && typeof cause.path === "string") return cause.path;
  return error.message.match(/\bspawn (\S+) ENOENT\b/)?.[1];
}

/**
 * Whether spawning git itself failed because there is no git: ENOENT from the spawn of a
 * file named `git`. Not when the working directory was missing: execa reports that as
 * ENOENT too, and the git it never got to start may be perfectly installed.
 */
function spawnedGitMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const spawn = error as Error & ExecaShaped & { path?: unknown };
  if (spawn.code !== "ENOENT" || invalidCwd(error)) return false;
  const file = spawnedFile(spawn);
  if (file === undefined) return false;
  return /^git(?:\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? "");
}

function invalidCwd(error: unknown): boolean {
  if (typeof error === "string") return INVALID_CWD.test(error);
  if (!(error instanceof Error)) return false;
  const shortMessage = (error as Error & ExecaShaped).shortMessage;
  return (
    INVALID_CWD.test(error.message) ||
    (typeof shortMessage === "string" && INVALID_CWD.test(shortMessage))
  );
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
  const detail = capDetail(rawText(error));
  const unknown: ClassifiedGitFailure = {
    kind: "unknown",
    message: `This ${subject} couldn't be checked out.`,
    action: "retry",
    detail,
  };
  // A checkout directory that is not there: nothing about git, its tools or the remote.
  if (invalidCwd(error)) return unknown;
  const text = matchText(error);

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
  return unknown;
}
