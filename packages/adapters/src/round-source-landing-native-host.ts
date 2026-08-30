import { createHash } from "node:crypto";
import { closeSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { ExclusiveNamespaceMoveOutcome } from "./exclusive-namespace-move";
import type {
  AnchoredRoundSourceLandingFileSystem,
  BoundRoundSourceLandingGit,
  RoundSourceLandingObservedPathDescriptor,
} from "./round-source-landing";

const ARTIFACT_ROOT = ".rennet/round-landings";
const INFO_EXCLUDE_RULE = `/${ARTIFACT_ROOT}/`;
const INFO_EXCLUDE_PROBE = `${ARTIFACT_ROOT}/.rennet-exclusion-probe`;

type NativeInspectResult =
  | { readonly kind: "absent" }
  | { readonly kind: "directory" }
  | { readonly kind: "regular"; readonly descriptor: number; readonly executable: boolean }
  | { readonly kind: "symlink"; readonly bytes: Buffer }
  | { readonly kind: "unsupported"; readonly detail: string };

export interface RootedLandingNativeHost {
  inspect(root: "source" | "worker", path: string): unknown;
  manifestLeafPaths(root: "source" | "worker", path: string): unknown;
  ensureParent(path: string): unknown;
  materializeTarget(sourcePath: string, destinationPath: string, mode: string): unknown;
  move(sourcePath: string, destinationPath: string): unknown;
  remove(path: string, recursive: boolean): unknown;
  removeEmptyParents(path: string): unknown;
  removeEmptyDirectory(path: string): unknown;
  ensureInfoExcludeRule(rule: string): unknown;
  close(): unknown;
}

export interface RootedLandingNativeBinding {
  readonly RootedLandingHost: new (
    sourceRoot: string,
    workerRoot: string,
    infoExcludePath: string,
  ) => RootedLandingNativeHost;
}

export type LoadRootedLandingNativeBinding = (addonPath: string) => unknown;

export type BoundRoundSourceLandingGitWithInput = (
  arguments_: Parameters<BoundRoundSourceLandingGit>[0],
  options?: NonNullable<Parameters<BoundRoundSourceLandingGit>[1]> & {
    readonly input?: Buffer | Readable;
  },
) => ReturnType<BoundRoundSourceLandingGit>;

type NativeMethod = (...arguments_: readonly unknown[]) => unknown;

type BoundNativeHost = {
  readonly inspect: NativeMethod;
  readonly manifestLeafPaths: NativeMethod;
  readonly ensureParent: NativeMethod;
  readonly materializeTarget: NativeMethod;
  readonly move: NativeMethod;
  readonly remove: NativeMethod;
  readonly removeEmptyParents: NativeMethod;
  readonly removeEmptyDirectory: NativeMethod;
  readonly ensureInfoExcludeRule: NativeMethod;
  readonly close: NativeMethod;
};

type NativeBindingSource =
  | {
      readonly binding: RootedLandingNativeBinding;
      readonly addonPath?: never;
      readonly loadBinding?: never;
    }
  | {
      readonly binding?: never;
      readonly addonPath?: string;
      readonly loadBinding?: LoadRootedLandingNativeBinding;
    };

export type CreateNativeRoundSourceLandingFileSystemInput = NativeBindingSource & {
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly infoExcludePath: string;
  readonly sourceGit: BoundRoundSourceLandingGit;
  readonly workerGit: BoundRoundSourceLandingGitWithInput;
};

export interface NativeRoundSourceLandingFileSystemHandle {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nativeMethod(host: Record<string, unknown>, name: keyof BoundNativeHost): NativeMethod {
  const candidate = host[name];
  if (typeof candidate !== "function") {
    throw new Error(`rooted landing addon host is missing ${name}()`);
  }
  return (candidate as NativeMethod).bind(host);
}

function bindNativeHost(
  binding: unknown,
  constructorArguments: readonly string[],
): BoundNativeHost {
  if (!isRecord(binding) || typeof binding.RootedLandingHost !== "function") {
    throw new Error("rooted landing addon does not export RootedLandingHost");
  }
  const instance: unknown = Reflect.construct(binding.RootedLandingHost, constructorArguments);
  if (!isRecord(instance)) throw new Error("RootedLandingHost did not construct an object");
  try {
    return {
      inspect: nativeMethod(instance, "inspect"),
      manifestLeafPaths: nativeMethod(instance, "manifestLeafPaths"),
      ensureParent: nativeMethod(instance, "ensureParent"),
      materializeTarget: nativeMethod(instance, "materializeTarget"),
      move: nativeMethod(instance, "move"),
      remove: nativeMethod(instance, "remove"),
      removeEmptyParents: nativeMethod(instance, "removeEmptyParents"),
      removeEmptyDirectory: nativeMethod(instance, "removeEmptyDirectory"),
      ensureInfoExcludeRule: nativeMethod(instance, "ensureInfoExcludeRule"),
      close: nativeMethod(instance, "close"),
    };
  } catch (error) {
    const close = instance.close;
    if (typeof close === "function") close.call(instance);
    throw error;
  }
}

function defaultLoadBinding(addonPath: string): unknown {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(addonPath);
  return loaded;
}

export function defaultRootedLandingAddonPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../dist/native",
    `${process.platform}-${process.arch}`,
    "rennet-rooted-landing.node",
  );
}

function relativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not normalized and repository-relative: ${value}`);
  }
  return value;
}

function expectVoid(operation: string, result: unknown): void {
  if (result !== undefined) {
    throw new Error(`rooted landing addon ${operation}() returned a value`);
  }
}

function nativeInspectResult(value: unknown): NativeInspectResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("rooted landing addon inspect() returned a malformed result");
  }
  switch (value.kind) {
    case "absent":
      return { kind: "absent" };
    case "directory":
      return { kind: "directory" };
    case "regular":
      if (
        typeof value.descriptor !== "number" ||
        !Number.isSafeInteger(value.descriptor) ||
        value.descriptor < 0 ||
        typeof value.executable !== "boolean"
      ) {
        if (
          typeof value.descriptor === "number" &&
          Number.isSafeInteger(value.descriptor) &&
          value.descriptor >= 0
        ) {
          try {
            closeSync(value.descriptor);
          } catch {
            // Preserve the malformed-ABI error when the returned descriptor is already invalid.
          }
        }
        throw new Error("rooted landing addon inspect() returned a malformed regular snapshot");
      }
      return {
        kind: "regular",
        descriptor: value.descriptor,
        executable: value.executable,
      };
    case "symlink":
      if (!Buffer.isBuffer(value.bytes)) {
        throw new Error("rooted landing addon inspect() returned a malformed symlink snapshot");
      }
      return { kind: "symlink", bytes: Buffer.from(value.bytes) };
    case "unsupported":
      if (typeof value.detail !== "string" || value.detail.length === 0) {
        throw new Error("rooted landing addon inspect() returned malformed unsupported detail");
      }
      return { kind: "unsupported", detail: value.detail };
    default:
      throw new Error(`rooted landing addon inspect() returned unknown kind ${value.kind}`);
  }
}

function nativeLeafPaths(value: unknown, base: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("rooted landing addon manifestLeafPaths() did not return an array");
  }
  const entries: readonly unknown[] = value;
  const paths = entries.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("rooted landing addon manifestLeafPaths() returned a non-string path");
    }
    const path = relativePath(entry, "native manifest leaf path");
    if (path !== base && !path.startsWith(`${base}/`)) {
      throw new Error(`native manifest leaf path escapes ${base}: ${path}`);
    }
    return path;
  });
  paths.sort();
  if (paths.some((path, index) => index > 0 && path === paths[index - 1])) {
    throw new Error("rooted landing addon manifestLeafPaths() returned a duplicate path");
  }
  return paths;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashRegularSnapshot(input: {
  readonly descriptor: number;
  readonly workerGit: BoundRoundSourceLandingGitWithInput;
  readonly arguments_: readonly string[];
  readonly oidLength: 40 | 64;
}): Promise<{ readonly oid: string; readonly rawSha256: string }> {
  const rawHash = createHash("sha256");
  const source = createReadStream("", { autoClose: true, fd: input.descriptor });
  const hashingInput = new Transform({
    transform(chunk, _encoding, callback) {
      rawHash.update(chunk);
      callback(null, chunk);
    },
  });
  const streaming = pipeline(source, hashingInput);
  try {
    const [output] = await Promise.all([
      input.workerGit(input.arguments_, { input: hashingInput }),
      streaming,
    ]);
    return {
      oid: parseGitOid(output, input.oidLength),
      rawSha256: rawHash.digest("hex"),
    };
  } catch (error) {
    source.destroy();
    hashingInput.destroy();
    await Promise.allSettled([streaming]);
    throw error;
  }
}

function symlinkOid(bytes: Buffer, oidLength: 40 | 64): string {
  return createHash(oidLength === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function parseGitOid(output: string, oidLength: 40 | 64): string {
  const oid = output.trim();
  const pattern = oidLength === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(oid)) {
    throw new Error(`Git returned an invalid ${oidLength}-character object id: ${output}`);
  }
  return oid;
}

function nativeMoveOutcome(value: unknown): ExclusiveNamespaceMoveOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("rooted landing addon move() returned a malformed result");
  }
  switch (value.kind) {
    case "moved":
      return { kind: "moved" };
    case "destination-exists":
    case "path-missing":
    case "cross-device":
    case "unsupported":
    case "failed":
      if (typeof value.nativeCode !== "number" || !Number.isSafeInteger(value.nativeCode)) {
        throw new Error(
          `rooted landing addon move() returned invalid nativeCode for ${value.kind}`,
        );
      }
      return { kind: value.kind, nativeCode: value.nativeCode };
    case "helper-unavailable":
      if (typeof value.code !== "string" || typeof value.detail !== "string") {
        throw new Error("rooted landing addon move() returned malformed helper-unavailable data");
      }
      return { kind: "helper-unavailable", code: value.code, detail: value.detail };
    case "outcome-unknown":
      if (typeof value.detail !== "string") {
        throw new Error("rooted landing addon move() returned malformed outcome-unknown detail");
      }
      return { kind: "outcome-unknown", detail: value.detail };
    default:
      throw new Error(`rooted landing addon move() returned unknown kind ${value.kind}`);
  }
}

function removeEmptyDirectoryOutcome(
  value: unknown,
): "absent" | "removed" | "not-empty" | "not-directory" {
  if (
    value === "absent" ||
    value === "removed" ||
    value === "not-empty" ||
    value === "not-directory"
  ) {
    return value;
  }
  throw new Error("rooted landing addon removeEmptyDirectory() returned an invalid outcome");
}

function verifyExclusionOutput(output: string): void {
  const tab = output.indexOf("\t");
  const metadata = tab === -1 ? output.trimEnd() : output.slice(0, tab);
  if (!metadata.endsWith(`:${INFO_EXCLUDE_RULE}`)) {
    throw new Error(
      `rooted landing addon could not verify ${INFO_EXCLUDE_RULE} in Git info/exclude`,
    );
  }
}

export function createNativeRoundSourceLandingFileSystem(
  input: CreateNativeRoundSourceLandingFileSystemInput,
): NativeRoundSourceLandingFileSystemHandle {
  const binding: unknown =
    input.binding ??
    (input.loadBinding ?? defaultLoadBinding)(input.addonPath ?? defaultRootedLandingAddonPath());
  const native = bindNativeHost(binding, [
    input.sourceRoot,
    input.workerRoot,
    input.infoExcludePath,
  ]);
  let closed = false;
  let exclusionPromise:
    | Promise<{ readonly source: "git-info-exclude"; readonly pattern: string }>
    | undefined;

  const assertOpen = (): void => {
    if (closed) throw new Error("rooted landing addon host is closed");
  };

  const ensureExclusion = async (): Promise<{
    readonly source: "git-info-exclude";
    readonly pattern: string;
  }> => {
    const tracked = await input.sourceGit(["ls-files", "-z", "--", ARTIFACT_ROOT]);
    const visibleStatus = await input.sourceGit([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ARTIFACT_ROOT,
    ]);
    if (tracked.length > 0 || visibleStatus.length > 0) {
      throw new Error(
        `rooted landing refuses to hide visible preexisting content at ${ARTIFACT_ROOT}`,
      );
    }
    assertOpen();
    const installed = native.ensureInfoExcludeRule(INFO_EXCLUDE_RULE);
    if (
      !isRecord(installed) ||
      (installed.status !== "installed" && installed.status !== "already-present")
    ) {
      throw new Error("rooted landing addon ensureInfoExcludeRule() returned an invalid result");
    }
    const verification = await input.sourceGit(
      ["check-ignore", "-v", "--no-index", "--", INFO_EXCLUDE_PROBE],
      { reject: false },
    );
    verifyExclusionOutput(verification);
    return { source: "git-info-exclude", pattern: INFO_EXCLUDE_RULE };
  };

  const fileSystem: AnchoredRoundSourceLandingFileSystem = {
    ensureInternalExclusion({ artifactRoot }) {
      assertOpen();
      if (relativePath(artifactRoot, "landing artifact root") !== ARTIFACT_ROOT) {
        throw new Error(`rooted landing received an unexpected artifact root: ${artifactRoot}`);
      }
      exclusionPromise ??= ensureExclusion();
      return exclusionPromise;
    },

    async inspect({ root, path, repoPath, attrSource, oidLength }) {
      assertOpen();
      const nativePath = relativePath(path, "landing inspection path");
      const nativeRepoPath = relativePath(repoPath, "landing repository path");
      if (attrSource.length === 0 || attrSource.includes("\0")) {
        throw new Error("landing attribute source is empty or contains NUL");
      }
      if (oidLength !== 40 && oidLength !== 64) {
        throw new Error(`landing object id length is invalid: ${oidLength}`);
      }
      const captured = nativeInspectResult(native.inspect(root, nativePath));
      switch (captured.kind) {
        case "absent":
        case "directory":
        case "unsupported":
          return captured;
        case "regular": {
          const { oid, rawSha256 } = await hashRegularSnapshot({
            descriptor: captured.descriptor,
            workerGit: input.workerGit,
            arguments_: [
              "-c",
              `attr.tree=${attrSource}`,
              "hash-object",
              "--stdin",
              `--path=${nativeRepoPath}`,
            ],
            oidLength,
          });
          return {
            kind: "git",
            mode: captured.executable ? "100755" : "100644",
            oid,
            rawSha256,
          } satisfies RoundSourceLandingObservedPathDescriptor;
        }
        case "symlink":
          return {
            kind: "git",
            mode: "120000",
            oid: symlinkOid(captured.bytes, oidLength),
            rawSha256: sha256(captured.bytes),
          } satisfies RoundSourceLandingObservedPathDescriptor;
        default: {
          const _exhaustive: never = captured;
          return _exhaustive;
        }
      }
    },

    async manifestLeafPaths({ root, path }) {
      assertOpen();
      const base = relativePath(path, "landing manifest path");
      return nativeLeafPaths(native.manifestLeafPaths(root, base), base);
    },

    async ensureParent({ path }) {
      assertOpen();
      expectVoid("ensureParent", native.ensureParent(relativePath(path, "landing parent path")));
    },

    async materializeTarget({ sourcePath, destinationPath, mode }) {
      assertOpen();
      expectVoid(
        "materializeTarget",
        native.materializeTarget(
          relativePath(sourcePath, "landing materialization source path"),
          relativePath(destinationPath, "landing materialization destination path"),
          mode,
        ),
      );
    },

    async move({ sourcePath, destinationPath }) {
      assertOpen();
      return nativeMoveOutcome(
        native.move(
          relativePath(sourcePath, "landing move source path"),
          relativePath(destinationPath, "landing move destination path"),
        ),
      );
    },

    async remove({ path, recursive = false }) {
      assertOpen();
      expectVoid("remove", native.remove(relativePath(path, "landing removal path"), recursive));
    },

    async removeEmptyParents({ path }) {
      assertOpen();
      expectVoid(
        "removeEmptyParents",
        native.removeEmptyParents(relativePath(path, "landing empty-parent path")),
      );
    },

    async removeEmptyDirectory({ path }) {
      assertOpen();
      return removeEmptyDirectoryOutcome(
        native.removeEmptyDirectory(relativePath(path, "landing empty-directory path")),
      );
    },
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    expectVoid("close", native.close());
  };

  return { fileSystem, close };
}
