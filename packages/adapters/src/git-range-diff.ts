import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  HOST_LOCUS,
  type Locus,
  LocusPathUntranslatableError,
  locusCommand,
  toDistroPath,
  toWindowsView,
} from "@rennet/core";
import {
  APP_OWNED_BOARD_SEGMENTS,
  DIFF_TRUNCATION_MARKER,
  type FileChangeStatus,
  type PatchFile,
  type Patchset,
  type PatchsetSource,
} from "@rennet/protocol";
import { execa } from "execa";

/**
 * Shared git-diff parsing helpers plus the commit-range capture engine.
 *
 * The pure helpers (`parseChangedPaths`, `parseCounts`, `visible`, the untracked-
 * patch synthesis, the byte limits) are extracted here so BOTH sources parse a
 * diff identically: `GitCaptureAdapter` (working-tree capture, unchanged
 * behaviour) and `captureRangePatchset` (a GitHub PR's `base...head` range). Git
 * is authoritative for content; the range engine turns a pinned `(baseOid,
 * headOid)` pair into the same immutable `Patchset` the local path produces.
 */

export interface ChangedPath {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
}

export interface Counts {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export const DEFAULT_VISIBLE_BYTE_LIMIT = 2 * 1024 * 1024;
export const FILE_VISIBLE_BYTE_LIMIT = 256 * 1024;

/**
 * The app-owned board store as a git pathspec, DERIVED from the shared authority
 * (#729, D6) rather than spelled out a second time. `:(top)` anchors it at the
 * repository root, matching `isAppOwnedPath`'s root-relative contract, so the same
 * directory is named however deep the git call's cwd sits.
 */
export const APP_OWNED_PATHSPEC = `:(top)${APP_OWNED_BOARD_SEGMENTS.join("/")}`;

/**
 * The subtractive form. Git treats a pathspec list containing only exclusions as
 * "everything else", so this can follow a bare `--` with no accompanying include.
 *
 * It guards the BASE side of a working-tree diff. Sanitizing the reviewed tree alone
 * is enough for identity, but if a board file is already committed at the base, the
 * sanitized tree renders it as a DELETION — app-owned content back in the file list
 * and the raw diff by the other door.
 */
export const EXCLUDE_APP_OWNED_PATHSPEC = `:(top,exclude)${APP_OWNED_BOARD_SEGMENTS.join("/")}`;

/** A narrow git runner, injected so the range engine is testable against a real repo. */
export type GitExec = (
  root: string,
  arguments_: string[],
  options?: { readonly input?: Buffer | Readable; readonly reject?: boolean },
) => Promise<string>;

/**
 * The real git runner for a project's locus (add-windows-support). Host: `git` in
 * `root`, unchanged. WSL: `wsl.exe -d <distro> --cd <distro-root> -e git …` — the
 * `-e` form passes argv byte-verbatim, and the diff bytes are what git INSIDE the
 * distro reports (spike: stdout is clean UTF-8/LF through the boundary). No shell,
 * keeps the final newline so diffs stay byte-exact.
 */
export function execaGitFor(locus: Locus): GitExec {
  return async (root, arguments_, options) => {
    const { file, args, cwd } = locusCommand(locus, "git", arguments_, root);
    const result = await execa(file, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(options?.input === undefined ? {} : { input: options.input }),
      reject: options?.reject ?? true,
      shell: false,
      stripFinalNewline: false,
    });
    return result.stdout;
  };
}

/** Build the fixed-locus runner used by one repo-facing composition seam. */
export function gitForRepoFactory(
  locusForRepo: (repoRoot: string) => Locus,
  runnerForLocus: (locus: Locus) => GitExec = execaGitFor,
): (repoRoot: string) => GitExec {
  return (repoRoot) => runnerForLocus(locusForRepo(repoRoot));
}

/** The host git runner — today's behaviour on macOS/Linux/native-Windows. */
export const execaGit: GitExec = execaGitFor(HOST_LOCUS);

export function parseChangedPaths(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const paths: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length && fields[index]) {
    const statusToken = fields[index++];
    if (!statusToken) break;
    const code = statusToken[0];
    if (code === "R" || code === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath !== undefined && path !== undefined) {
        paths.push({ path, previousPath, status: "renamed" });
      }
      continue;
    }
    const path = fields[index++];
    if (path === undefined) break;
    const status: FileChangeStatus = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    paths.push({ path, status });
  }
  return paths;
}

export function parseCounts(output: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const fields = output.split("\0");
  let index = 0;
  while (index < fields.length && fields[index]) {
    const record = fields[index++];
    if (!record) break;
    const [additionsText, deletionsText, pathInRecord] = record.split("\t");
    let path = pathInRecord;
    if (!path) {
      const previousPath = fields[index++];
      const renamedPath = fields[index++];
      path = renamedPath ?? previousPath;
    }
    if (!path) continue;
    const binary = additionsText === "-" || deletionsText === "-";
    counts.set(path, {
      additions: binary ? null : Number(additionsText),
      deletions: binary ? null : Number(deletionsText),
      binary,
    });
  }
  return counts;
}

export function visible(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  return `${bytes.subarray(0, maximumBytes).toString("utf8")}\n\n${DIFF_TRUNCATION_MARKER}`;
}

/**
 * Undo git's C-style path quoting (`quote_c_style`). Git quotes a path in a diff header
 * whenever it contains a control character, a space-adjacent quote/backslash, or ANY byte
 * ≥ 0x80 — so every non-ASCII filename arrives quoted, with each UTF-8 BYTE written as a
 * three-digit octal escape (`café.ts` ⇒ `"caf\303\251.ts"`).
 *
 * That is NOT JSON, which is what this used to try: `JSON.parse` rejects `\303` outright, so
 * the whole quoted form survived, the `a/`/`b/` strip then missed (the leading `"` blocked
 * it), and the file surfaced under a literal mangled name. Decoding to BYTES first and then
 * running one UTF-8 decode is what makes a multi-byte character come back whole — decoding
 * each escape to a character would produce mojibake.
 */
function unquoteGitPath(value: string): string {
  const bytes: number[] = [];
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== "\\") {
      // Source is already a JS string; re-encode this character's own UTF-8 bytes.
      for (const byte of new TextEncoder().encode(value[i] as string)) bytes.push(byte);
      continue;
    }
    const next = value[++i];
    const octal = /^[0-7]$/.test(next ?? "") ? value.slice(i, i + 3) : undefined;
    if (octal !== undefined && /^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 2;
      continue;
    }
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
      v: 11,
      '"': 34,
      "\\": 92,
    };
    const code = simple[next ?? ""];
    // An escape git never emits: keep the character rather than dropping it.
    if (code === undefined) for (const b of new TextEncoder().encode(next ?? "")) bytes.push(b);
    else bytes.push(code);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Strip a leading `a/` or `b/` diff prefix and unwrap a C-quoted git path. */
function unprefix(path: string): string {
  let value = path.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = unquoteGitPath(value);
  }
  return value.replace(/^[ab]\//, "");
}

/**
 * Parse a unified-diff string (the REST-fallback path) into per-file `PatchFile`s.
 * This is the degraded source, so it derives path/status/counts from the diff text
 * rather than from git's structured `--name-status`/`--numstat` output. The full
 * per-file block is kept as `patch` (truncated to the file visible limit by default).
 * Receipt verifiers may pass `Number.POSITIVE_INFINITY` when every input byte must remain
 * available for exact evidence checks.
 */
export function parseUnifiedDiffFiles(
  diff: string,
  maximumPatchBytes = FILE_VISIBLE_BYTE_LIMIT,
): PatchFile[] {
  if (diff.trim().length === 0) return [];
  const blocks = diff.split(/(?=^diff --git )/m).filter((block) => block.startsWith("diff --git"));
  // Accumulate per PATH, coalescing RAW blocks. git splits a TYPE CHANGE
  // (gitlink↔regular file) into a delete + an add of the SAME path, i.e. two
  // `diff --git` blocks; the local capture keeps both halves in ONE PatchFile and
  // `decompose` keys its per-file state on a UNIQUE path, so two same-path files
  // would collide and drop the first half's hunks (a real change hidden). We merge
  // the raw block text and apply `visible` ONCE at the end, so any truncation
  // marker stays TERMINAL (a per-block `visible` would bury the first block's
  // marker mid-patch and the truncation gap would silently disappear).
  interface Accumulated {
    status: FileChangeStatus;
    previousPath?: string;
    additions: number;
    deletions: number;
    binary: boolean;
    rawParts: string[];
  }
  const byPath = new Map<string, Accumulated>();
  for (const block of blocks) {
    const lines = block.split("\n");
    let status: FileChangeStatus = "modified";
    let previousPath: string | undefined;
    let path: string | undefined;
    let additions = 0;
    let deletions = 0;
    // Unified diffs are POSITIONAL: file metadata (`--- `/`+++ ` path headers, mode
    // changes, renames) is legal only in a block's preamble, before the first `@@`
    // hunk header; after it, every line is hunk content carrying a one-character role
    // prefix (`+`, `-`, ` `, `\`). Without this flag an ordinary added body line whose
    // CONTENT begins `++ b/…` renders as `+++ b/…` and matched the destination-path
    // branch, RE-KEYING the whole block to the wrong file (last-write-wins) with no
    // ingestion gap recorded: a silent false-clear (#310). The same body lines were
    // also dropped from the counts by the `+++`/`---` exclusions. `inHunk` latches
    // once set — a body line cannot start with `@@`, so the flag cannot be spoofed
    // from content, and the fail-safe direction is to COUNT a doubtful line as change,
    // never PROMOTE it to metadata.
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (line.startsWith("new file mode")) status = "added";
        else if (line.startsWith("deleted file mode")) status = "deleted";
        else if (line.startsWith("rename from ")) {
          status = "renamed";
          previousPath = unprefix(line.slice("rename from ".length));
        } else if (line.startsWith("rename to ")) {
          path = unprefix(line.slice("rename to ".length));
        } else if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) {
          previousPath ??= unprefix(line.slice(4));
        } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
          path = unprefix(line.slice(4));
        }
      } else if (line.startsWith("+")) {
        // In-hunk: classify by first character only. No `+++`/`---` exclusions —
        // headers are structurally confined to the preamble now, so a `+++ …`-rendered
        // in-hunk line IS an addition (this is the #310 miscount, fixed).
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
    // Fall back to the `diff --git a/… b/…` header when there are no ---/+++ lines
    // (a pure rename or mode change has no hunk body).
    if (!path) {
      const header = /^diff --git (.+) (.+)$/.exec(lines[0] ?? "");
      if (header) {
        previousPath ??= unprefix(header[1] ?? "");
        path = unprefix(header[2] ?? "");
      }
    }
    if (!path) continue;
    // Anchor the binary sentinels to a line start: git emits `Binary files … differ`
    // and `GIT binary patch` at column 0. An unanchored `includes` would flag an
    // ordinary file whose added body line merely reads `+Binary files … differ`,
    // hiding that real change downstream (the dangerous direction).
    const binary = /^Binary files .+ differ$/m.test(block) || /^GIT binary patch$/m.test(block);
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, { status, previousPath, additions, deletions, binary, rawParts: [block] });
    } else {
      existing.status = "modified";
      existing.additions += additions;
      existing.deletions += deletions;
      existing.binary ||= binary;
      existing.previousPath ??= previousPath;
      existing.rawParts.push(block);
    }
  }
  const files: PatchFile[] = [];
  for (const [path, acc] of byPath) {
    files.push({
      path,
      ...(acc.status === "renamed" && acc.previousPath ? { previousPath: acc.previousPath } : {}),
      status: acc.status,
      additions: acc.binary ? null : acc.additions,
      deletions: acc.binary ? null : acc.deletions,
      binary: acc.binary,
      patch: visible(acc.rawParts.join("\n"), maximumPatchBytes),
    });
  }
  // Code-unit ordering, not `localeCompare`: this order feeds the REST patchset's
  // content hash, so a locale/ICU-dependent comparator would let identical diff
  // bytes yield different identities across machines.
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

/**
 * The deterministic diff flags used everywhere: `--no-ext-diff`/`--no-textconv`
 * disable machine-specific config, so the output is stable across machines. On a
 * repo with no `diff.*` config they are no-ops, which is what makes the range
 * engine's `rawDiff` byte-identical to a bare `git diff base...head`.
 */
const DETERMINISTIC_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

export interface RangeCaptureInput {
  root: string;
  /** Execution locus for path normalization. WSL Git reports distro-native roots,
   * while persisted patchsets must retain the host-visible UNC identity. */
  locus?: Locus;
  baseOid: string;
  headOid: string;
  /** The base branch name, carried into provenance (e.g. `"main"`). */
  baseRef: string;
  /**
   * The head's branch ref, when the head IS a local branch (#587's New-Chat branch
   * review). Carried into provenance so the round path's read-only session lookup
   * (`resolveRoundSessionId`, which keys on `repository.headRef`) resolves a branch
   * review onto the session that claimed that branch. A PR range leaves it absent —
   * the head is a pinned OID from a remote, not a ref in this clone.
   */
  headRef?: string;
  /** How the content was sourced. Defaults to `"github-local"`. */
  source?: PatchsetSource;
  visibleByteLimit?: number;
  /** Effective base-map identity resolved at capture time. */
  projectSnapshotId?: string;
}

function rangeCaptureRoots(
  root: string,
  locus: Locus,
): {
  readonly gitRoot: string;
  readonly repositoryRoot: string;
} {
  if (locus.kind === "host") return { gitRoot: root, repositoryRoot: root };
  const gitRoot = toDistroPath(root, locus.distro);
  if (gitRoot === null) throw new LocusPathUntranslatableError(root, locus.distro);
  return { gitRoot, repositoryRoot: toWindowsView(gitRoot, locus.distro) };
}

/**
 * Capture an immutable `Patchset` from an explicit commit range (`base...head`).
 *
 * `rawDiff` is byte-identical to `git diff base...head`. Files carry per-file
 * patches, numstat counts, and status. The patchset id is content-addressed over
 * `(repository, files, bytes)`, so two captures of the same pinned OIDs are the
 * same immutable patchset — the property head-pinning relies on: re-rendering a
 * review after a remote force-push reproduces the byte-identical reviewed state.
 */
export async function captureRangePatchset(
  git: GitExec,
  input: RangeCaptureInput,
): Promise<Patchset> {
  const { baseOid, headOid, baseRef } = input;
  const locus = input.locus ?? HOST_LOCUS;
  const { gitRoot, repositoryRoot } = rangeCaptureRoots(input.root, locus);
  const source: PatchsetSource = input.source ?? "github-local";
  const visibleByteLimit = input.visibleByteLimit ?? DEFAULT_VISIBLE_BYTE_LIMIT;
  const range = `${baseOid}...${headOid}`;

  const commonDirValue = (await git(gitRoot, ["rev-parse", "--git-common-dir"])).trim();
  const gitCommonDir =
    locus.kind === "wsl"
      ? (toDistroPath(commonDirValue, locus.distro) ?? posix.resolve(gitRoot, commonDirValue))
      : isAbsolute(commonDirValue)
        ? commonDirValue
        : resolve(gitRoot, commonDirValue);
  const commonDir = locus.kind === "wsl" ? toWindowsView(gitCommonDir, locus.distro) : gitCommonDir;

  const rawDiff = await git(gitRoot, ["diff", ...DETERMINISTIC_DIFF_FLAGS, range, "--"]);
  const changedPaths = parseChangedPaths(
    await git(gitRoot, ["diff", "--name-status", "-z", range, "--"]),
  );
  const counts = parseCounts(await git(gitRoot, ["diff", "--numstat", "-z", range, "--"]));

  const files: PatchFile[] = [];
  for (const changedPath of changedPaths) {
    const patch = await git(gitRoot, [
      "diff",
      ...DETERMINISTIC_DIFF_FLAGS,
      range,
      "--",
      ...(changedPath.previousPath ? [changedPath.previousPath] : []),
      changedPath.path,
    ]);
    const fileCounts = counts.get(changedPath.path) ??
      counts.get(changedPath.previousPath ?? "") ?? {
        additions: null,
        deletions: null,
        binary: true,
      };
    files.push({
      ...changedPath,
      ...fileCounts,
      patch: visible(patch, FILE_VISIBLE_BYTE_LIMIT),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const bytes = Buffer.from(rawDiff);
  const repository = {
    id: createHash("sha256").update(commonDir).digest("hex"),
    root: repositoryRoot,
    commonDir,
    baseRef,
    baseOid,
    headOid,
    ...(input.headRef === undefined ? {} : { headRef: input.headRef }),
  };
  const id = createHash("sha256")
    .update(
      JSON.stringify({ repository, files: files.map(({ path, status }) => ({ path, status })) }),
    )
    .update(bytes)
    .digest("hex");

  return {
    id,
    createdAt: new Date().toISOString(),
    repository,
    files,
    rawDiff: visible(rawDiff, visibleByteLimit),
    byteLength: bytes.length,
    truncated: bytes.length > visibleByteLimit,
    source,
    ...(input.projectSnapshotId === undefined
      ? {}
      : { projectSnapshotId: input.projectSnapshotId }),
  };
}
