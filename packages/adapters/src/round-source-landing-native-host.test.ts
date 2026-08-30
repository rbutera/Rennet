import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { assertTestOnlyLandingRelativePath } from "./round-source-landing.test-only-unsafe-host";
import {
  type BoundRoundSourceLandingGitWithInput,
  createNativeRoundSourceLandingFileSystem,
  defaultRootedLandingAddonPath,
  type RootedLandingNativeBinding,
  type RootedLandingNativeHost,
} from "./round-source-landing-native-host";

const roots: string[] = [];
const descriptors = new Set<number>();

afterEach(() => {
  for (const descriptor of descriptors) {
    try {
      closeSync(descriptor);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  descriptors.clear();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
  };
}

function boundGit(
  root: string,
  observe?: (arguments_: readonly string[], input: Buffer | Readable | undefined) => void,
): BoundRoundSourceLandingGitWithInput {
  return async (arguments_, options) => {
    observe?.(arguments_, options?.input);
    const result = await execa("git", [...arguments_], {
      cwd: root,
      encoding: "utf8",
      env: isolatedGitEnvironment(),
      input: options?.input,
      reject: false,
      shell: false,
    });
    if (result.exitCode !== 0 && options?.reject !== false) {
      throw new Error(
        `git ${arguments_.join(" ")} exited ${result.exitCode}: ${result.stderr.trimEnd()}`,
      );
    }
    return result.stdout;
  };
}

function runGit(root: string, arguments_: readonly string[], input?: Buffer): Promise<string> {
  return boundGit(root)(arguments_, { input });
}

type FakeBehavior = {
  inspectResult: unknown;
  manifestResult: unknown;
  moveResult: unknown;
  removeEmptyDirectoryResult: unknown;
  infoExcludeResult?: unknown;
  voidResult?: unknown;
  closeResult?: unknown;
  constructorArguments: string[];
  calls: Array<{ readonly method: string; readonly arguments_: readonly unknown[] }>;
  ensureInfoExcludeCount: number;
  closeCount: number;
};

function behavior(overrides: Partial<FakeBehavior> = {}): FakeBehavior {
  return {
    inspectResult: { kind: "absent" },
    manifestResult: [],
    moveResult: { kind: "moved" },
    removeEmptyDirectoryResult: "absent",
    constructorArguments: [],
    calls: [],
    ensureInfoExcludeCount: 0,
    closeCount: 0,
    ...overrides,
  };
}

function fakeBinding(state: FakeBehavior): RootedLandingNativeBinding {
  return {
    RootedLandingHost: class implements RootedLandingNativeHost {
      readonly #infoExcludePath: string;

      constructor(sourceRoot: string, workerRoot: string, infoExcludePath: string) {
        state.constructorArguments.push(sourceRoot, workerRoot, infoExcludePath);
        this.#infoExcludePath = infoExcludePath;
      }

      inspect(...arguments_: ["source" | "worker", string]): unknown {
        state.calls.push({ method: "inspect", arguments_ });
        return state.inspectResult;
      }

      manifestLeafPaths(...arguments_: ["source" | "worker", string]): unknown {
        state.calls.push({ method: "manifestLeafPaths", arguments_ });
        return state.manifestResult;
      }

      ensureParent(...arguments_: [string]): unknown {
        state.calls.push({ method: "ensureParent", arguments_ });
        return state.voidResult;
      }

      materializeTarget(...arguments_: [string, string, string]): unknown {
        state.calls.push({ method: "materializeTarget", arguments_ });
        return state.voidResult;
      }

      move(...arguments_: [string, string]): unknown {
        state.calls.push({ method: "move", arguments_ });
        return state.moveResult;
      }

      remove(...arguments_: [string, boolean]): unknown {
        state.calls.push({ method: "remove", arguments_ });
        return state.voidResult;
      }

      removeEmptyParents(...arguments_: [string]): unknown {
        state.calls.push({ method: "removeEmptyParents", arguments_ });
        return state.voidResult;
      }

      removeEmptyDirectory(...arguments_: [string]): unknown {
        state.calls.push({ method: "removeEmptyDirectory", arguments_ });
        return state.removeEmptyDirectoryResult;
      }

      ensureInfoExcludeRule(rule: string): unknown {
        state.calls.push({ method: "ensureInfoExcludeRule", arguments_: [rule] });
        state.ensureInfoExcludeCount += 1;
        if (state.infoExcludeResult !== undefined) return state.infoExcludeResult;
        const current = existsSync(this.#infoExcludePath)
          ? readFileSync(this.#infoExcludePath, "utf8")
          : "";
        if (current.split(/\r?\n/).includes(rule)) return { status: "already-present" };
        mkdirSync(dirname(this.#infoExcludePath), { recursive: true });
        appendFileSync(
          this.#infoExcludePath,
          `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${rule}\n`,
        );
        return { status: "installed" };
      }

      close(): unknown {
        state.closeCount += 1;
        return state.closeResult;
      }
    },
  };
}

async function gitFixture(): Promise<{
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly infoExcludePath: string;
  readonly attrSource: string;
}> {
  const temporaryRoot = realpathSync(tmpdir());
  const sourceRoot = mkdtempSync(join(temporaryRoot, "rennet-native-source-"));
  const workerRoot = mkdtempSync(join(temporaryRoot, "rennet-native-worker-"));
  roots.push(sourceRoot, workerRoot);
  for (const root of [sourceRoot, workerRoot]) {
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.email", "native-landing@test.invalid"]);
    await runGit(root, ["config", "user.name", "Native Landing Test"]);
  }
  writeFileSync(join(workerRoot, ".gitattributes"), "filtered.txt text eol=lf\n");
  await runGit(workerRoot, ["add", ".gitattributes"]);
  await runGit(workerRoot, ["commit", "-m", "attributes"]);
  const attrSource = (await runGit(workerRoot, ["rev-parse", "HEAD"])).trim();
  const infoExcludePath = (
    await runGit(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
  ).trim();
  return { sourceRoot, workerRoot, infoExcludePath, attrSource };
}

describe("native rooted round source landing host", () => {
  it("hashes a regular native snapshot through worker Git attributes", async () => {
    const fixture = await gitFixture();
    const snapshot = Buffer.from("line\r\n");
    const snapshotPath = join(fixture.workerRoot, "snapshot.bin");
    writeFileSync(snapshotPath, snapshot);
    const descriptor = openSync(snapshotPath, "r");
    descriptors.add(descriptor);
    const state = behavior({
      inspectResult: { kind: "regular", descriptor, executable: true },
    });
    const gitCalls: Array<{
      readonly arguments_: readonly string[];
      readonly streamed: boolean;
    }> = [];
    const runWorkerGit = boundGit(fixture.workerRoot);
    const workerGit: BoundRoundSourceLandingGitWithInput = async (arguments_, options) => {
      gitCalls.push({
        arguments_: [...arguments_],
        streamed: options?.input instanceof Readable,
      });
      return runWorkerGit(arguments_, options);
    };
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit,
      binding: fakeBinding(state),
    });

    const observed = await fileSystem.inspect({
      root: "worker",
      path: assertTestOnlyLandingRelativePath("filtered.txt"),
      repoPath: assertTestOnlyLandingRelativePath("filtered.txt"),
      attrSource: fixture.attrSource,
      oidLength: 40,
    });
    expect(() => fstatSync(descriptor)).toThrow();
    const normalizedOid = (
      await runGit(fixture.workerRoot, ["hash-object", "--stdin"], Buffer.from("line\n"))
    ).trim();
    const rawOid = (
      await runGit(fixture.workerRoot, ["hash-object", "--stdin"], Buffer.from("line\r\n"))
    ).trim();

    expect(observed).toEqual({
      kind: "git",
      mode: "100755",
      oid: normalizedOid,
      rawSha256: createHash("sha256").update("line\r\n").digest("hex"),
    });
    expect(normalizedOid).not.toBe(rawOid);
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]?.arguments_).toEqual([
      "-c",
      `attr.tree=${fixture.attrSource}`,
      "hash-object",
      "--stdin",
      "--path=filtered.txt",
    ]);
    expect(gitCalls[0]?.streamed).toBe(true);
    close();
  });

  it.skipIf(process.platform === "win32")(
    "streams the real addon's anchored regular-file descriptor into Git",
    async () => {
      const fixture = await gitFixture();
      const snapshot = Buffer.from("native line\r\n");
      writeFileSync(join(fixture.workerRoot, "filtered.txt"), snapshot);
      const gitInputs: boolean[] = [];
      const runWorkerGit = boundGit(fixture.workerRoot);
      const handle = createNativeRoundSourceLandingFileSystem({
        ...fixture,
        sourceGit: boundGit(fixture.sourceRoot),
        workerGit: async (arguments_, options) => {
          gitInputs.push(options?.input instanceof Readable);
          return runWorkerGit(arguments_, options);
        },
      });

      try {
        const observed = await handle.fileSystem.inspect({
          root: "worker",
          path: assertTestOnlyLandingRelativePath("filtered.txt"),
          repoPath: assertTestOnlyLandingRelativePath("filtered.txt"),
          attrSource: fixture.attrSource,
          oidLength: 40,
        });
        const normalizedOid = (
          await runGit(fixture.workerRoot, ["hash-object", "--stdin"], Buffer.from("native line\n"))
        ).trim();

        expect(observed).toEqual({
          kind: "git",
          mode: "100644",
          oid: normalizedOid,
          rawSha256: createHash("sha256").update(snapshot).digest("hex"),
        });
        expect(gitInputs).toEqual([true]);
      } finally {
        handle.close();
      }
    },
  );

  it("closes the regular descriptor before surfacing an immediate Git failure", async () => {
    const fixture = await gitFixture();
    const snapshotPath = join(fixture.workerRoot, "rejected-snapshot.bin");
    writeFileSync(snapshotPath, "content\n");
    const descriptor = openSync(snapshotPath, "r");
    descriptors.add(descriptor);
    const state = behavior({
      inspectResult: { kind: "regular", descriptor, executable: false },
    });
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: () => {
        throw new Error("git unavailable");
      },
      binding: fakeBinding(state),
    });

    await expect(
      fileSystem.inspect({
        root: "worker",
        path: assertTestOnlyLandingRelativePath("file"),
        repoPath: assertTestOnlyLandingRelativePath("file"),
        attrSource: fixture.attrSource,
        oidLength: 40,
      }),
    ).rejects.toThrow("git unavailable");
    expect(() => fstatSync(descriptor)).toThrow();
    close();
  });

  it("computes symlink identity without asking Git to read the filesystem", async () => {
    const fixture = await gitFixture();
    const payload = Buffer.from("target\n");
    const state = behavior({ inspectResult: { kind: "symlink", bytes: payload } });
    let workerGitCalls = 0;
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot, () => {
        workerGitCalls += 1;
      }),
      binding: fakeBinding(state),
    });

    await expect(
      fileSystem.inspect({
        root: "source",
        path: assertTestOnlyLandingRelativePath("link"),
        repoPath: assertTestOnlyLandingRelativePath("link"),
        attrSource: fixture.attrSource,
        oidLength: 40,
      }),
    ).resolves.toEqual({
      kind: "git",
      mode: "120000",
      oid: createHash("sha1").update(`blob ${payload.length}\0`).update(payload).digest("hex"),
      rawSha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(workerGitCalls).toBe(0);
    close();
  });

  it("preflights visibility, appends the exclusion once, and verifies it through Git", async () => {
    const fixture = await gitFixture();
    const state = behavior();
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(state),
    });
    const artifactRoot = assertTestOnlyLandingRelativePath(".rennet/round-landings");

    const [first, second] = await Promise.all([
      fileSystem.ensureInternalExclusion({ artifactRoot }),
      fileSystem.ensureInternalExclusion({ artifactRoot }),
    ]);

    expect(first).toEqual({
      source: "git-info-exclude",
      pattern: "/.rennet/round-landings/",
    });
    expect(second).toEqual(first);
    expect(state.ensureInfoExcludeCount).toBe(1);
    expect(
      readFileSync(fixture.infoExcludePath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line === "/.rennet/round-landings/"),
    ).toHaveLength(1);
    close();
  });

  it("refuses tracked transaction content before changing info/exclude", async () => {
    const fixture = await gitFixture();
    mkdirSync(join(fixture.sourceRoot, ".rennet", "round-landings"), { recursive: true });
    writeFileSync(join(fixture.sourceRoot, ".rennet", "round-landings", "visible"), "visible\n");
    await runGit(fixture.sourceRoot, ["add", ".rennet/round-landings/visible"]);
    const state = behavior();
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(state),
    });

    await expect(
      fileSystem.ensureInternalExclusion({
        artifactRoot: assertTestOnlyLandingRelativePath(".rennet/round-landings"),
      }),
    ).rejects.toThrow("refuses to hide visible preexisting content");
    expect(state.ensureInfoExcludeCount).toBe(0);
    close();
  });

  it("maps every filesystem method to relative native calls", async () => {
    const fixture = await gitFixture();
    const state = behavior({
      manifestResult: ["tree/z", "tree/a"],
      moveResult: { kind: "path-missing", nativeCode: 2 },
      removeEmptyDirectoryResult: "not-empty",
    });
    const { fileSystem, close } = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(state),
    });
    const path = assertTestOnlyLandingRelativePath;

    await expect(
      fileSystem.manifestLeafPaths({ root: "worker", path: path("tree") }),
    ).resolves.toEqual(["tree/a", "tree/z"]);
    await fileSystem.ensureParent({ path: path("tree/a") });
    await fileSystem.materializeTarget({
      sourcePath: path("tree/a"),
      destinationPath: path("stage/a"),
      mode: "100644",
    });
    await expect(
      fileSystem.move({ sourcePath: path("stage/a"), destinationPath: path("live/a") }),
    ).resolves.toEqual({ kind: "path-missing", nativeCode: 2 });
    await fileSystem.remove({ path: path("stage/a"), recursive: true });
    await fileSystem.removeEmptyParents({ path: path("stage/a") });
    await expect(fileSystem.removeEmptyDirectory({ path: path("stage") })).resolves.toBe(
      "not-empty",
    );

    expect(state.calls).toEqual([
      { method: "manifestLeafPaths", arguments_: ["worker", "tree"] },
      { method: "ensureParent", arguments_: ["tree/a"] },
      { method: "materializeTarget", arguments_: ["tree/a", "stage/a", "100644"] },
      { method: "move", arguments_: ["stage/a", "live/a"] },
      { method: "remove", arguments_: ["stage/a", true] },
      { method: "removeEmptyParents", arguments_: ["stage/a"] },
      { method: "removeEmptyDirectory", arguments_: ["stage"] },
    ]);
    await expect(
      Reflect.apply(fileSystem.ensureParent, fileSystem, [{ path: "../escape" }]),
    ).rejects.toThrow("not normalized and repository-relative");
    close();
  });

  it("rejects malformed native and Git results at the adapter boundary", async () => {
    const fixture = await gitFixture();
    const malformedInspect = behavior({
      inspectResult: { kind: "regular", descriptor: "not a descriptor", executable: false },
    });
    const first = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(malformedInspect),
    });
    await expect(
      first.fileSystem.inspect({
        root: "source",
        path: assertTestOnlyLandingRelativePath("file"),
        repoPath: assertTestOnlyLandingRelativePath("file"),
        attrSource: fixture.attrSource,
        oidLength: 40,
      }),
    ).rejects.toThrow("malformed regular snapshot");
    first.close();

    const malformedExecutablePath = join(fixture.workerRoot, "malformed-executable-input");
    writeFileSync(malformedExecutablePath, "content\n");
    const malformedExecutableDescriptor = openSync(malformedExecutablePath, "r");
    descriptors.add(malformedExecutableDescriptor);
    const malformedExecutable = behavior({
      inspectResult: {
        kind: "regular",
        descriptor: malformedExecutableDescriptor,
        executable: "not a boolean",
      },
    });
    const malformedExecutableHandle = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(malformedExecutable),
    });
    await expect(
      malformedExecutableHandle.fileSystem.inspect({
        root: "source",
        path: assertTestOnlyLandingRelativePath("file"),
        repoPath: assertTestOnlyLandingRelativePath("file"),
        attrSource: fixture.attrSource,
        oidLength: 40,
      }),
    ).rejects.toThrow("malformed regular snapshot");
    expect(() => fstatSync(malformedExecutableDescriptor)).toThrow();
    malformedExecutableHandle.close();

    const malformedVoid = behavior({ voidResult: true });
    const second = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(malformedVoid),
    });
    await expect(
      second.fileSystem.ensureParent({ path: assertTestOnlyLandingRelativePath("file") }),
    ).rejects.toThrow("ensureParent() returned a value");
    second.close();

    const malformedMove = behavior({ moveResult: { kind: "failed", nativeCode: "EIO" } });
    const third = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      binding: fakeBinding(malformedMove),
    });
    await expect(
      third.fileSystem.move({
        sourcePath: assertTestOnlyLandingRelativePath("a"),
        destinationPath: assertTestOnlyLandingRelativePath("b"),
      }),
    ).rejects.toThrow("invalid nativeCode");
    third.close();

    const invalidOidPath = join(fixture.workerRoot, "invalid-oid-input");
    writeFileSync(invalidOidPath, "content\n");
    const invalidOidDescriptor = openSync(invalidOidPath, "r");
    descriptors.add(invalidOidDescriptor);
    const invalidOid = behavior({
      inspectResult: {
        kind: "regular",
        descriptor: invalidOidDescriptor,
        executable: false,
      },
    });
    const fourth = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: async () => "not-an-object-id\n",
      binding: fakeBinding(invalidOid),
    });
    await expect(
      fourth.fileSystem.inspect({
        root: "worker",
        path: assertTestOnlyLandingRelativePath("file"),
        repoPath: assertTestOnlyLandingRelativePath("file"),
        attrSource: fixture.attrSource,
        oidLength: 40,
      }),
    ).rejects.toThrow("invalid 40-character object id");
    expect(() => fstatSync(invalidOidDescriptor)).toThrow();
    fourth.close();
  });

  it("resolves an explicit addon and closes the native host exactly once", async () => {
    const fixture = await gitFixture();
    const state = behavior();
    const binding = fakeBinding(state);
    const loadedPaths: string[] = [];
    const handle = createNativeRoundSourceLandingFileSystem({
      ...fixture,
      sourceGit: boundGit(fixture.sourceRoot),
      workerGit: boundGit(fixture.workerRoot),
      addonPath: "/installed/rennet-rooted-landing.node",
      loadBinding(addonPath) {
        loadedPaths.push(addonPath);
        return binding;
      },
    });

    expect(loadedPaths).toEqual(["/installed/rennet-rooted-landing.node"]);
    expect(state.constructorArguments).toEqual([
      fixture.sourceRoot,
      fixture.workerRoot,
      fixture.infoExcludePath,
    ]);
    const layoutRoot = join(realpathSync(tmpdir()), "rennet-addon-layout");
    expect(
      defaultRootedLandingAddonPath({
        moduleUrl: pathToFileURL(
          join(layoutRoot, "packages/adapters/src/round-source-landing-native-host.ts"),
        ).href,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(
      join(layoutRoot, "packages/adapters/dist/native/darwin-arm64/rennet-rooted-landing.node"),
    );
    expect(
      defaultRootedLandingAddonPath({
        moduleUrl: pathToFileURL(join(layoutRoot, "dist/server/index.cjs")).href,
        platform: "linux",
        arch: "x64",
      }),
    ).toBe(join(layoutRoot, "dist/server/native/linux-x64/rennet-rooted-landing.node"));
    handle.close();
    handle.close();
    expect(state.closeCount).toBe(1);
    await expect(
      handle.fileSystem.ensureParent({ path: assertTestOnlyLandingRelativePath("closed") }),
    ).rejects.toThrow("host is closed");
  });
});
