import { createHash, type Hash } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { type Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
import type { ExclusiveNamespaceMover } from "./exclusive-namespace-move";
import type {
  AnchoredRoundSourceLandingFileSystem,
  BoundRoundSourceLandingGit,
  RoundSourceLandingObservedPathDescriptor,
  RoundSourceLandingRelativePath,
} from "./round-source-landing";

const ARTIFACT_ROOT = ".rennet/round-landings";
const INFO_EXCLUDE_RULE = `/${ARTIFACT_ROOT}/`;
const infoExcludeWriteTails = new Map<string, Promise<void>>();

export type TestOnlyRoundSourceLandingGitObserver = (arguments_: readonly string[]) => void;

type CapturedLeaf =
  | { readonly kind: "absent" }
  | { readonly kind: "directory" }
  | { readonly kind: "regular"; readonly path: string }
  | { readonly kind: "symlink"; readonly bytes: Buffer }
  | { readonly kind: "unsupported"; readonly detail: string };

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return undefined;
  }
  return error.code;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function captureRoot(root: string, label: string): string {
  const captured = realpathSync(root);
  if (!lstatSync(captured).isDirectory()) throw new Error(`${label} is not a directory`);
  return captured;
}

/**
 * Validates a repository-relative path for the test adapter.
 *
 * This cast is the brand boundary. Every adapter method validates the value again instead of
 * trusting a caller that could have fabricated the brand.
 */
export function assertTestOnlyLandingRelativePath(value: string): RoundSourceLandingRelativePath {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`test-only landing path is not normalized and repository-relative: ${value}`);
  }
  return value as RoundSourceLandingRelativePath;
}

function relativeParts(path: RoundSourceLandingRelativePath): readonly string[] {
  return assertTestOnlyLandingRelativePath(path).split("/");
}

function absolutePath(root: string, path: RoundSourceLandingRelativePath): string {
  return resolve(root, ...relativeParts(path));
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
  };
  delete environment.GIT_ATTR_SOURCE;
  delete environment.GIT_CONFIG;
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  return environment;
}

async function runTestOnlyGit(input: {
  readonly root: string;
  readonly arguments_: readonly string[];
  readonly onGitCall?: TestOnlyRoundSourceLandingGitObserver;
  readonly reject?: boolean;
}): Promise<string> {
  input.onGitCall?.([...input.arguments_]);
  const result = await execa("git", [...input.arguments_], {
    cwd: input.root,
    env: isolatedGitEnvironment(),
    reject: input.reject ?? true,
    shell: false,
    stripFinalNewline: false,
  });
  return result.stdout;
}

async function runStreamingTestOnlyGit(input: {
  readonly root: string;
  readonly arguments_: readonly string[];
  readonly source: Readable;
  readonly transform: Transform;
  readonly onGitCall?: TestOnlyRoundSourceLandingGitObserver;
}): Promise<string> {
  input.onGitCall?.([...input.arguments_]);
  const subprocess = execa("git", [...input.arguments_], {
    cwd: input.root,
    env: isolatedGitEnvironment(),
    reject: true,
    shell: false,
    stdin: "pipe",
    stripFinalNewline: false,
  });
  const stdin = subprocess.stdin;
  if (stdin === null) {
    input.source.destroy();
    input.transform.destroy();
    subprocess.kill();
    await subprocess.catch(() => undefined);
    throw new Error("test-only Git subprocess did not expose stdin");
  }

  try {
    const [execution, transfer] = await Promise.allSettled([
      subprocess,
      pipeline(input.source, input.transform, stdin),
    ]);
    if (execution.status === "rejected") throw execution.reason;
    if (transfer.status === "rejected") throw transfer.reason;
    return execution.value.stdout;
  } finally {
    input.source.destroy();
    input.transform.destroy();
    stdin.destroy();
  }
}

/** Binds Git to one captured fixture repository and ignores user/system Git excludes. */
export function bindTestOnlyRoundSourceLandingGit(
  root: string,
  onGitCall?: TestOnlyRoundSourceLandingGitObserver,
): BoundRoundSourceLandingGit {
  const capturedRoot = captureRoot(root, "test-only Git root");
  return (arguments_, options) =>
    runTestOnlyGit({
      root: capturedRoot,
      arguments_,
      onGitCall,
      reject: options?.reject,
    });
}

async function resolveInspectablePath(
  root: string,
  path: RoundSourceLandingRelativePath,
): Promise<{ readonly kind: "absent" } | { readonly kind: "resolved"; readonly path: string }> {
  const parts = relativeParts(path);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return { kind: "absent" };
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { kind: "absent" };
  }
  return { kind: "resolved", path: absolutePath(root, path) };
}

async function captureLeaf(
  root: string,
  path: RoundSourceLandingRelativePath,
): Promise<CapturedLeaf> {
  const resolved = await resolveInspectablePath(root, path);
  if (resolved.kind === "absent") return resolved;
  let stats: Stats;
  try {
    stats = await lstat(resolved.path);
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "absent" };
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) return { kind: "directory" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      bytes: await readlink(resolved.path, { encoding: "buffer" }),
    };
  }
  if (stats.isFile()) {
    return {
      kind: "regular",
      path: resolved.path,
    };
  }
  return { kind: "unsupported", detail: "unsupported host filesystem entry" };
}

async function assertSafeMutationAncestors(
  root: string,
  path: RoundSourceLandingRelativePath,
): Promise<string> {
  const parts = relativeParts(path);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new Error(`test-only landing parent does not exist: ${current}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`test-only landing refuses a non-directory or symlink parent: ${current}`);
    }
  }
  return absolutePath(root, path);
}

async function ensureSafeParentDirectories(
  root: string,
  path: RoundSourceLandingRelativePath,
): Promise<void> {
  const parts = relativeParts(path);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      stats = await lstat(current);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`test-only landing refuses a non-directory or symlink parent: ${current}`);
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobOid(bytes: Buffer, oidLength: 40 | 64): string {
  const algorithm = oidLength === 40 ? "sha1" : "sha256";
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function hashPassThrough(hash: Hash): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function hashRegularSnapshot(input: {
  readonly path: string;
  readonly repoPath: RoundSourceLandingRelativePath;
  readonly attrSource: string;
  readonly oidLength: 40 | 64;
  readonly gitRoot: string;
  readonly onGitCall?: TestOnlyRoundSourceLandingGitObserver;
}): Promise<{
  readonly executable: boolean;
  readonly oid: string;
  readonly rawSha256: string;
}> {
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: Readable | undefined;
  let transform: Transform | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error(`test-only landing expected a regular file: ${input.path}`);
    const rawHash = createHash("sha256");
    source = handle.createReadStream({ autoClose: true });
    transform = hashPassThrough(rawHash);
    const oid = (
      await runStreamingTestOnlyGit({
        root: input.gitRoot,
        arguments_: [
          "-c",
          `attr.tree=${input.attrSource}`,
          "hash-object",
          "--stdin",
          `--path=${input.repoPath}`,
        ],
        onGitCall: input.onGitCall,
        source,
        transform,
      })
    ).trim();
    if (oid.length !== input.oidLength || !/^[0-9a-f]+$/.test(oid)) {
      throw new Error(`Git returned an invalid ${input.oidLength}-character object id: ${oid}`);
    }
    return {
      executable: (before.mode & 0o111) !== 0,
      oid,
      rawSha256: rawHash.digest("hex"),
    };
  } finally {
    source?.destroy();
    transform?.destroy();
    await handle.close();
  }
}

async function materializeRegularSnapshot(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly executable: boolean;
}): Promise<void> {
  const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let sourceStream: Readable | undefined;
  let destinationStream:
    | ReturnType<NonNullable<typeof destination>["createWriteStream"]>
    | undefined;
  try {
    const sourceStats = await source.stat();
    if (!sourceStats.isFile()) {
      throw new Error(`test-only landing expected a regular file: ${input.sourcePath}`);
    }
    destination = await open(input.destinationPath, "wx", 0o600);
    sourceStream = source.createReadStream({ autoClose: true });
    destinationStream = destination.createWriteStream({ autoClose: true });
    await pipeline(sourceStream, destinationStream);
  } finally {
    sourceStream?.destroy();
    destinationStream?.destroy();
    const closes = [source.close()];
    if (destination !== undefined) closes.push(destination.close());
    await Promise.allSettled(closes);
  }
  await chmod(input.destinationPath, input.executable ? 0o755 : 0o644);
}

async function withInfoExcludeWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = infoExcludeWriteTails.get(path) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  infoExcludeWriteTails.set(path, tail);
  try {
    return await result;
  } finally {
    if (infoExcludeWriteTails.get(path) === tail) infoExcludeWriteTails.delete(path);
  }
}

async function readInfoExclude(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

function containsExactInfoExcludeRule(content: Buffer): boolean {
  return content.toString("utf8").split(/\r?\n/).includes(INFO_EXCLUDE_RULE);
}

/**
 * A Node host-path adapter for tests only. It cannot provide the directory-handle and atomic
 * no-follow guarantees required of production `AnchoredRoundSourceLandingFileSystem` adapters.
 */
export function createTestOnlyHostLandingFileSystem(input: {
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly mover: ExclusiveNamespaceMover;
  readonly onGitCall?: TestOnlyRoundSourceLandingGitObserver;
}): AnchoredRoundSourceLandingFileSystem {
  const sourceRoot = captureRoot(input.sourceRoot, "test-only source root");
  const workerRoot = captureRoot(input.workerRoot, "test-only worker root");
  let exclusionPromise:
    | Promise<{ readonly source: "git-info-exclude"; readonly pattern: string }>
    | undefined;

  const git = (arguments_: readonly string[], options?: { readonly reject?: boolean }) =>
    runTestOnlyGit({
      root: sourceRoot,
      arguments_,
      onGitCall: input.onGitCall,
      reject: options?.reject,
    });

  const ensureExclusion = async (): Promise<{
    readonly source: "git-info-exclude";
    readonly pattern: string;
  }> => {
    const rawInfoExcludePath = (
      await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
    ).trim();
    if (rawInfoExcludePath.length === 0) {
      throw new Error("Git returned an empty info/exclude path");
    }
    const infoExcludePath = isAbsolute(rawInfoExcludePath)
      ? rawInfoExcludePath
      : resolve(sourceRoot, rawInfoExcludePath);
    return withInfoExcludeWriteLock(infoExcludePath, async () => {
      const tracked = await git(["ls-files", "-z", "--", ARTIFACT_ROOT]);
      const visibleStatus = await git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ARTIFACT_ROOT,
      ]);
      if (tracked.length > 0 || visibleStatus.length > 0) {
        throw new Error(
          `test-only landing refuses to hide visible preexisting content at ${ARTIFACT_ROOT}`,
        );
      }

      await mkdir(dirname(infoExcludePath), { recursive: true });
      const current = await readInfoExclude(infoExcludePath);
      if (!containsExactInfoExcludeRule(current)) {
        const prefix = current.length > 0 && current.at(-1) !== 0x0a ? "\n" : "";
        await appendFile(infoExcludePath, `${prefix}${INFO_EXCLUDE_RULE}\n`);
      }
      const installed = await readInfoExclude(infoExcludePath);
      if (!containsExactInfoExcludeRule(installed)) {
        throw new Error(`test-only landing could not install ${INFO_EXCLUDE_RULE}`);
      }

      const probe = `${ARTIFACT_ROOT}/.rennet-exclusion-probe`;
      const verification = await git(["check-ignore", "-v", "--no-index", "--", probe], {
        reject: false,
      });
      const tab = verification.indexOf("\t");
      const metadata = tab === -1 ? verification.trimEnd() : verification.slice(0, tab);
      if (!metadata.endsWith(`:${INFO_EXCLUDE_RULE}`)) {
        throw new Error(
          `test-only landing could not verify ${INFO_EXCLUDE_RULE} in Git info/exclude`,
        );
      }
      return { source: "git-info-exclude", pattern: INFO_EXCLUDE_RULE };
    });
  };

  return {
    ensureInternalExclusion({ artifactRoot }) {
      if (artifactRoot !== assertTestOnlyLandingRelativePath(ARTIFACT_ROOT)) {
        throw new Error(`test-only landing received an unexpected artifact root: ${artifactRoot}`);
      }
      exclusionPromise ??= ensureExclusion();
      return exclusionPromise;
    },

    async inspect({ root, path, repoPath, attrSource, oidLength }) {
      const captured = await captureLeaf(root === "source" ? sourceRoot : workerRoot, path);
      switch (captured.kind) {
        case "absent":
        case "directory":
        case "unsupported":
          return captured;
        case "regular": {
          const hashed = await hashRegularSnapshot({
            path: captured.path,
            repoPath,
            attrSource,
            oidLength,
            gitRoot: workerRoot,
            onGitCall: input.onGitCall,
          });
          return {
            kind: "git",
            mode: hashed.executable ? "100755" : "100644",
            oid: hashed.oid,
            rawSha256: hashed.rawSha256,
          } satisfies RoundSourceLandingObservedPathDescriptor;
        }
        case "symlink": {
          return {
            kind: "git",
            mode: "120000",
            oid: gitBlobOid(captured.bytes, oidLength),
            rawSha256: sha256(captured.bytes),
          } satisfies RoundSourceLandingObservedPathDescriptor;
        }
        default: {
          const _exhaustive: never = captured;
          return _exhaustive;
        }
      }
    },

    async manifestLeafPaths({ root, path }) {
      const selectedRoot = root === "source" ? sourceRoot : workerRoot;
      const base = await resolveInspectablePath(selectedRoot, path);
      if (base.kind === "absent") return [];
      let baseStats: Stats;
      try {
        baseStats = await lstat(base.path);
      } catch (error) {
        if (isMissingPathError(error)) return [];
        throw error;
      }
      if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) return [path];

      const leaves: string[] = [];
      const visit = async (relativeDirectory: RoundSourceLandingRelativePath): Promise<void> => {
        const directory = await assertSafeMutationAncestors(selectedRoot, relativeDirectory);
        const names = (await readdir(directory)).sort();
        for (const name of names) {
          const child = assertTestOnlyLandingRelativePath(posix.join(relativeDirectory, name));
          const childPath = absolutePath(selectedRoot, child);
          const stats = await lstat(childPath);
          if (stats.isDirectory() && !stats.isSymbolicLink()) await visit(child);
          else leaves.push(child);
        }
      };
      await visit(path);
      return leaves.sort();
    },

    async ensureParent({ path }) {
      await ensureSafeParentDirectories(sourceRoot, path);
    },

    async materializeTarget({ sourcePath, destinationPath, mode }) {
      const captured = await captureLeaf(workerRoot, sourcePath);
      const destination = await assertSafeMutationAncestors(sourceRoot, destinationPath);
      if (mode === "120000") {
        if (captured.kind !== "symlink") {
          throw new Error(`test-only landing expected a symlink at ${sourcePath}`);
        }
        await symlink(captured.bytes, destination);
        return;
      }
      if (captured.kind !== "regular") {
        throw new Error(`test-only landing expected a regular file at ${sourcePath}`);
      }
      await materializeRegularSnapshot({
        sourcePath: captured.path,
        destinationPath: destination,
        executable: mode === "100755",
      });
    },

    async move({ sourcePath, destinationPath }) {
      const source = await assertSafeMutationAncestors(sourceRoot, sourcePath);
      const destination = await assertSafeMutationAncestors(sourceRoot, destinationPath);
      return input.mover.move({ sourcePath: source, destinationPath: destination });
    },

    async remove({ path, recursive = false }) {
      const resolved = await resolveInspectablePath(sourceRoot, path);
      if (resolved.kind === "absent") return;
      let stats: Stats;
      try {
        stats = await lstat(resolved.path);
      } catch (error) {
        if (isMissingPathError(error)) return;
        throw error;
      }
      if (recursive) {
        await rm(resolved.path, { recursive: true, force: true });
      } else if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await rmdir(resolved.path);
      } else {
        await unlink(resolved.path);
      }
    },

    async removeEmptyParents({ path }) {
      const parts = relativeParts(path);
      for (let length = parts.length - 1; length > 0; length -= 1) {
        const parent = assertTestOnlyLandingRelativePath(parts.slice(0, length).join("/"));
        const resolved = await resolveInspectablePath(sourceRoot, parent);
        if (resolved.kind === "absent") continue;
        let stats: Stats;
        try {
          stats = await lstat(resolved.path);
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) return;
        try {
          await rmdir(resolved.path);
        } catch (error) {
          const code = errorCode(error);
          if (code === "ENOENT") continue;
          if (code === "ENOTEMPTY" || code === "EEXIST") return;
          throw error;
        }
      }
    },

    async removeEmptyDirectory({ path }) {
      const resolved = await resolveInspectablePath(sourceRoot, path);
      if (resolved.kind === "absent") return "absent";
      let stats: Stats;
      try {
        stats = await lstat(resolved.path);
      } catch (error) {
        if (isMissingPathError(error)) return "absent";
        throw error;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) return "not-directory";
      try {
        await rmdir(resolved.path);
        return "removed";
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return "absent";
        if (code === "ENOTEMPTY" || code === "EEXIST") return "not-empty";
        throw error;
      }
    },
  };
}
