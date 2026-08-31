import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface InstalledNativePayloadPaths {
  readonly nativeRoot: string;
  readonly rootedAddonPath: string;
  readonly exclusiveMovePath: string;
}

interface ExclusiveMoveInput {
  readonly helperPath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

interface InstalledNativePayloadOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly loadAddon?: (addonPath: string) => unknown;
  readonly runExclusiveMove?: (input: ExclusiveMoveInput) => void;
}

interface PackagedAppSmokeModule {
  installedNativePayloadPaths(
    appPath: string,
    platform?: { readonly platform?: NodeJS.Platform; readonly arch?: string },
  ): InstalledNativePayloadPaths;
  verifyInstalledNativePayload(
    appPath: string,
    options?: InstalledNativePayloadOptions,
  ): InstalledNativePayloadPaths;
  verifyPackagedUpdateLifecycleSources(sources: {
    readonly autoUpdate: string;
    readonly main: string;
  }): void;
  verifyPackagedUpdateLifecycle(
    appPath: string,
    options?: {
      readonly readArchiveFile?: (archivePath: string, entryPath: string) => Uint8Array;
    },
  ): { readonly archivePath: string };
}

const smokeModuleUrl = pathToFileURL(
  resolve(import.meta.dirname, "../../../scripts/smoke-packaged-app.mjs"),
).href;
const smoke = (await import(smokeModuleUrl)) as unknown as PackagedAppSmokeModule;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(platform: NodeJS.Platform = "darwin", arch = "arm64") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rennet-package-smoke-test-"));
  temporaryRoots.push(root);
  const appPath = join(root, "Rennet.app");
  const paths = smoke.installedNativePayloadPaths(appPath, { platform, arch });
  mkdirSync(paths.nativeRoot, { recursive: true });
  return { appPath, paths, platform, arch };
}

function rootedBinding(onClose?: () => void) {
  return {
    RootedLandingHost: class {
      readonly sourceRoot: string;

      constructor(sourceRoot: string) {
        this.sourceRoot = sourceRoot;
      }

      inspect(root: string, path: string) {
        if (root !== "source" || path !== "probe.txt") throw new Error("unexpected probe");
        return {
          kind: "regular",
          descriptor: openSync(join(this.sourceRoot, path), "r"),
          executable: false,
        };
      }

      close() {
        onClose?.();
      }
    },
  };
}

describe("packaged native payload smoke", () => {
  it("targets the unpacked server native directory inside the installed application", () => {
    const { appPath, paths } = fixture();
    const nativeRoot = join(
      appPath,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "dist",
      "server",
      "native",
      "darwin-arm64",
    );

    expect(paths).toEqual({
      nativeRoot,
      rootedAddonPath: join(nativeRoot, "rennet-rooted-landing.node"),
      exclusiveMovePath: join(nativeRoot, "rennet-exclusive-move"),
    });
  });

  it("loads, calls, and closes the addon and executes the helper from the installed tree", () => {
    const { appPath, paths, platform, arch } = fixture();
    let loadedPath: string | undefined;
    let helperInput: ExclusiveMoveInput | undefined;
    let closed = false;

    const result = smoke.verifyInstalledNativePayload(appPath, {
      platform,
      arch,
      loadAddon(addonPath) {
        loadedPath = addonPath;
        return rootedBinding(() => {
          closed = true;
        });
      },
      runExclusiveMove(input) {
        helperInput = input;
        renameSync(input.sourcePath, input.destinationPath);
      },
    });

    expect(result).toEqual(paths);
    expect(loadedPath).toBe(paths.rootedAddonPath);
    expect(helperInput?.helperPath).toBe(paths.exclusiveMovePath);
    expect(closed).toBe(true);
  });

  it("fails when the exact installed addon path is absent", () => {
    const { appPath, platform, arch } = fixture();
    let helperRan = false;

    expect(() =>
      smoke.verifyInstalledNativePayload(appPath, {
        platform,
        arch,
        runExclusiveMove() {
          helperRan = true;
        },
      }),
    ).toThrow(/rennet-rooted-landing\.node/);
    expect(helperRan).toBe(false);
  });

  it("fails when the installed addon is not a loadable Node-API binary", () => {
    const { appPath, paths, platform, arch } = fixture();
    writeFileSync(paths.rootedAddonPath, "not a native addon");
    let helperRan = false;

    expect(() =>
      smoke.verifyInstalledNativePayload(appPath, {
        platform,
        arch,
        runExclusiveMove() {
          helperRan = true;
        },
      }),
    ).toThrow(/rennet-rooted-landing\.node/);
    expect(helperRan).toBe(false);
  });

  it("fails when the exact installed helper path is absent", () => {
    const { appPath, paths, platform, arch } = fixture();
    let closed = false;

    expect(() =>
      smoke.verifyInstalledNativePayload(appPath, {
        platform,
        arch,
        loadAddon: () =>
          rootedBinding(() => {
            closed = true;
          }),
      }),
    ).toThrow(paths.exclusiveMovePath);
    expect(closed).toBe(true);
  });

  it("fails when a helper exits successfully without performing the move", () => {
    const { appPath, paths, platform, arch } = fixture();

    expect(() =>
      smoke.verifyInstalledNativePayload(appPath, {
        platform,
        arch,
        loadAddon: () => rootedBinding(),
        runExclusiveMove(input) {
          expect(input.helperPath).toBe(paths.exclusiveMovePath);
        },
      }),
    ).toThrow(paths.exclusiveMovePath);
  });

  it("closes the descriptor returned by the rooted addon", () => {
    const { appPath, platform, arch } = fixture();
    let descriptor: number | undefined;
    const binding = rootedBinding();
    const RootedLandingHost = binding.RootedLandingHost;

    smoke.verifyInstalledNativePayload(appPath, {
      platform,
      arch,
      loadAddon: () => ({
        RootedLandingHost: class extends RootedLandingHost {
          override inspect(root: string, path: string) {
            const result = super.inspect(root, path);
            descriptor = result.descriptor;
            return result;
          }
        },
      }),
      runExclusiveMove(input) {
        renameSync(input.sourcePath, input.destinationPath);
      },
    });

    const closedDescriptor = descriptor;
    if (closedDescriptor === undefined) throw new Error("rooted addon was not inspected");
    expect(() => fstatSync(closedDescriptor)).toThrow();
  });

  it("closes an owned descriptor when the addon returns malformed metadata", () => {
    const { appPath, paths, platform, arch } = fixture();
    let descriptor: number | undefined;
    let hostClosed = false;

    expect(() =>
      smoke.verifyInstalledNativePayload(appPath, {
        platform,
        arch,
        loadAddon: () => ({
          RootedLandingHost: class {
            readonly sourceRoot: string;

            constructor(sourceRoot: string) {
              this.sourceRoot = sourceRoot;
            }

            inspect() {
              descriptor = openSync(join(this.sourceRoot, "probe.txt"), "r");
              return { kind: "regular", descriptor, executable: "not-a-boolean" };
            }

            close() {
              hostClosed = true;
            }
          },
        }),
        runExclusiveMove() {
          throw new Error("helper must not run");
        },
      }),
    ).toThrow(paths.rootedAddonPath);

    const closedDescriptor = descriptor;
    if (closedDescriptor === undefined) throw new Error("rooted addon was not inspected");
    expect(() => fstatSync(closedDescriptor)).toThrow();
    expect(hostClosed).toBe(true);
  });

  it("pins the shipped Windows addon to its explicit unsupported-construction behavior", () => {
    const { appPath, paths } = fixture("win32", "x64");

    const result = smoke.verifyInstalledNativePayload(appPath, {
      platform: "win32",
      arch: "x64",
      loadAddon: () => ({
        RootedLandingHost: class {
          constructor() {
            throw new Error("RootedLandingHost is unsupported on Windows");
          }
        },
      }),
      runExclusiveMove(input) {
        renameSync(input.sourcePath, input.destinationPath);
      },
    });

    expect(result).toEqual(paths);
    expect(paths.exclusiveMovePath).toMatch(/rennet-exclusive-move\.exe$/);
  });
});

describe("packaged updater lifecycle smoke", () => {
  const updaterSources = {
    autoUpdate: readFileSync(resolve(import.meta.dirname, "main/auto-update.ts"), "utf8"),
    main: readFileSync(resolve(import.meta.dirname, "main/index.ts"), "utf8"),
  };

  it("requires the packaged main to recover from the close-without-update path", () => {
    expect(() => smoke.verifyPackagedUpdateLifecycleSources(updaterSources)).not.toThrow();

    expect(() =>
      smoke.verifyPackagedUpdateLifecycleSources({
        ...updaterSources,
        main: updaterSources.main.replace("armRelaunchAfterApply:", "removedRelaunchAfterApply:"),
      }),
    ).toThrow("Packaged updater lifecycle is incomplete");

    expect(() =>
      smoke.verifyPackagedUpdateLifecycleSources({
        ...updaterSources,
        main: updaterSources.main.replace(
          "daemonDataDir = dataDir;\n            throw error;",
          "throw error;",
        ),
      }),
    ).toThrow("Packaged updater lifecycle is incomplete");

    expect(() =>
      smoke.verifyPackagedUpdateLifecycleSources({
        ...updaterSources,
        main: updaterSources.main.replace(
          "ensureDaemonForProject(path, activeDataDir)",
          "ensureDaemonForProject(path, hostDataDir)",
        ),
      }),
    ).toThrow("Packaged updater lifecycle is incomplete");
  });

  it("reads that lifecycle from the app.asar main source map", () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        sources: ["../../src/main/auto-update.ts", "../../src/main/index.ts"],
        sourcesContent: [updaterSources.autoUpdate, updaterSources.main],
      }),
    );
    const { appPath } = fixture();
    const readArchiveFile = (archivePath: string, entryPath: string): Uint8Array => {
      expect(archivePath).toBe(join(appPath, "Contents", "Resources", "app.asar"));
      expect(entryPath).toBe("dist/main/index.cjs.map");
      return sourceMap;
    };

    expect(smoke.verifyPackagedUpdateLifecycle(appPath, { readArchiveFile }).archivePath).toBe(
      join(appPath, "Contents", "Resources", "app.asar"),
    );
  });
});
