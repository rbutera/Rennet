import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type InspectResult =
  | { readonly kind: "absent" }
  | { readonly kind: "directory" }
  | { readonly kind: "regular"; readonly bytes: Buffer; readonly executable: boolean }
  | { readonly kind: "symlink"; readonly bytes: Buffer }
  | { readonly kind: "unsupported"; readonly detail: string };

type MoveResult =
  | { readonly kind: "moved" }
  | {
      readonly kind:
        | "destination-exists"
        | "path-missing"
        | "cross-device"
        | "unsupported"
        | "failed";
      readonly nativeCode: number;
    };

interface RootedLandingHost {
  inspect(root: "source" | "worker", path: string): InspectResult;
  manifestLeafPaths(root: "source" | "worker", path: string): string[];
  ensureParent(path: string): undefined;
  materializeTarget(source: string, destination: string, mode: string): undefined;
  move(source: string, destination: string): MoveResult;
  remove(path: string, recursive: boolean): undefined;
  removeEmptyParents(path: string): undefined;
  removeEmptyDirectory(path: string): "absent" | "removed" | "not-empty" | "not-directory";
  ensureInfoExcludeRule(rule: string): { readonly status: "installed" | "already-present" };
  close(): undefined;
}

interface RootedLandingBinding {
  readonly RootedLandingHost: new (
    sourceRoot: string,
    workerRoot: string,
    infoExcludePath: string,
  ) => RootedLandingHost;
}

const addonPath = join(
  dirname(import.meta.dirname),
  "dist",
  "native",
  `${process.platform}-${process.arch}`,
  "rennet-rooted-landing.node",
);
const require = createRequire(import.meta.url);

function loadBinding(): RootedLandingBinding {
  const loaded: unknown = require(addonPath);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("RootedLandingHost" in loaded) ||
    typeof loaded.RootedLandingHost !== "function"
  ) {
    throw new Error("native addon did not export RootedLandingHost");
  }
  return loaded as unknown as RootedLandingBinding;
}

const binding = loadBinding();
const scratchRoots: string[] = [];
const openHosts: RootedLandingHost[] = [];

afterEach(() => {
  for (const host of openHosts.splice(0)) host.close();
  for (const root of scratchRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): {
  readonly scratchRoot: string;
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly infoExcludePath: string;
  readonly host: RootedLandingHost;
} {
  const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), "rennet-rooted-landing-test-"));
  const sourceRoot = join(scratchRoot, "source");
  const workerRoot = join(scratchRoot, "worker");
  const infoParent = join(scratchRoot, "git-info");
  const infoExcludePath = join(infoParent, "exclude");
  mkdirSync(sourceRoot);
  mkdirSync(workerRoot);
  mkdirSync(infoParent);
  const host = new binding.RootedLandingHost(sourceRoot, workerRoot, infoExcludePath);
  scratchRoots.push(scratchRoot);
  openHosts.push(host);
  return { scratchRoot, sourceRoot, workerRoot, infoExcludePath, host };
}

function missing(path: string): boolean {
  return !existsSync(path);
}

function runContender(input: {
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly infoExcludePath: string;
  readonly source: string;
  readonly destination: string;
}): Promise<MoveResult> {
  const program = `
const binding = require(process.argv[1]);
const host = new binding.RootedLandingHost(process.argv[2], process.argv[3], process.argv[4]);
const outcome = host.move(process.argv[5], process.argv[6]);
host.close();
process.stdout.write(JSON.stringify(outcome));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        program,
        addonPath,
        input.sourceRoot,
        input.workerRoot,
        input.infoExcludePath,
        input.source,
        input.destination,
      ],
      { shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            signal === null
              ? `native contender exited ${code}: ${stderr}`
              : `native contender terminated by ${signal}: ${stderr}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(stdout) as MoveResult);
    });
  });
}

describe("rooted landing addon loading", () => {
  it("exports its stable constructor", () => {
    expect(binding.RootedLandingHost).toBeTypeOf("function");
  });

  it.skipIf(process.platform !== "win32")("loads on Windows and rejects unsupported use", () => {
    expect(
      () => new binding.RootedLandingHost("C:/source", "C:/worker", "C:/info/exclude"),
    ).toThrow(/unsupported on Windows/);
  });
});

describe.skipIf(process.platform === "win32")("rooted landing addon POSIX semantics", () => {
  it("rejects an ancestor symlink while capturing roots", () => {
    const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), "rennet-rooted-capture-test-"));
    const realParent = join(scratchRoot, "real");
    const aliasParent = join(scratchRoot, "alias");
    mkdirSync(join(realParent, "source"), { recursive: true });
    mkdirSync(join(realParent, "worker"));
    mkdirSync(join(realParent, "info"));
    symlinkSync(realParent, aliasParent, "dir");
    scratchRoots.push(scratchRoot);

    const captures = [
      [
        join(aliasParent, "source"),
        join(realParent, "worker"),
        join(realParent, "info", "exclude"),
      ],
      [
        join(realParent, "source"),
        join(aliasParent, "worker"),
        join(realParent, "info", "exclude"),
      ],
      [
        join(realParent, "source"),
        join(realParent, "worker"),
        join(aliasParent, "info", "exclude"),
      ],
    ] as const;
    for (const [sourceRoot, workerRoot, infoExcludePath] of captures) {
      expect(
        () => new binding.RootedLandingHost(sourceRoot, workerRoot, infoExcludePath),
      ).toThrow();
    }
  });

  it("keeps captured roots after a path swap and refuses symlink ancestors", () => {
    const { scratchRoot, sourceRoot, workerRoot, infoExcludePath, host } = fixture();
    const capturedRoot = join(scratchRoot, "captured-source");
    const capturedWorker = join(scratchRoot, "captured-worker");
    const capturedInfo = join(scratchRoot, "captured-info");
    const sentinelRoot = join(scratchRoot, "sentinel");
    mkdirSync(sentinelRoot);
    writeFileSync(join(sentinelRoot, "sentinel.txt"), "outside\n");
    writeFileSync(join(workerRoot, "payload.bin"), Buffer.from([0x00, 0xff, 0x41]));

    renameSync(sourceRoot, capturedRoot);
    renameSync(workerRoot, capturedWorker);
    renameSync(dirname(infoExcludePath), capturedInfo);
    symlinkSync(sentinelRoot, sourceRoot, "dir");
    symlinkSync(sentinelRoot, workerRoot, "dir");
    symlinkSync(sentinelRoot, dirname(infoExcludePath), "dir");

    expect(host.ensureParent("safe/payload.bin")).toBeUndefined();
    expect(host.materializeTarget("payload.bin", "safe/payload.bin", "100644")).toBeUndefined();
    expect(host.ensureInfoExcludeRule("/.rennet/")).toEqual({ status: "installed" });
    expect(readFileSync(join(capturedRoot, "safe", "payload.bin"))).toEqual(
      Buffer.from([0x00, 0xff, 0x41]),
    );
    expect(missing(join(sentinelRoot, "safe", "payload.bin"))).toBe(true);
    expect(readFileSync(join(capturedInfo, "exclude"), "utf8")).toBe("/.rennet/\n");
    expect(missing(join(sentinelRoot, "exclude"))).toBe(true);

    symlinkSync(sentinelRoot, join(capturedRoot, "escape"), "dir");
    expect(() => host.ensureParent("escape/created.txt")).toThrow();
    expect(() =>
      host.materializeTarget("payload.bin", "escape/materialized.bin", "100644"),
    ).toThrow();
    expect(() => host.inspect("source", "escape/sentinel.txt")).toThrow();
    expect(readFileSync(join(sentinelRoot, "sentinel.txt"), "utf8")).toBe("outside\n");

    for (const path of ["../escape", "/absolute", "a//b", "a\\b", "a/./b"]) {
      expect(() => host.inspect("source", path)).toThrow(/repository-relative|POSIX/);
    }
  });

  it("creates, snapshots, moves, and removes every supported leaf shape", () => {
    const { sourceRoot, workerRoot, infoExcludePath, host } = fixture();
    const binary = Buffer.from([0x00, 0xff, 0x7f, 0x0a]);
    mkdirSync(join(workerRoot, "input"));
    writeFileSync(join(workerRoot, "input", "binary"), binary);
    writeFileSync(join(workerRoot, "input", "executable"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(workerRoot, "input", "executable"), 0o755);
    symlinkSync("../target with spaces", join(workerRoot, "input", "link"));

    expect(host.inspect("worker", "input/executable")).toMatchObject({
      kind: "regular",
      executable: true,
    });
    expect(host.ensureParent("artifact/binary")).toBeUndefined();
    expect(host.materializeTarget("input/binary", "artifact/binary", "100644")).toBeUndefined();
    expect(
      host.materializeTarget("input/executable", "artifact/executable", "100755"),
    ).toBeUndefined();
    expect(host.materializeTarget("input/link", "artifact/link", "120000")).toBeUndefined();

    expect(host.inspect("source", "artifact/binary")).toEqual({
      kind: "regular",
      bytes: binary,
      executable: false,
    });
    expect(host.inspect("source", "artifact/executable")).toEqual({
      kind: "regular",
      bytes: Buffer.from("#!/bin/sh\nexit 0\n"),
      executable: true,
    });
    expect(host.inspect("source", "artifact/link")).toEqual({
      kind: "symlink",
      bytes: Buffer.from("../target with spaces"),
    });
    expect(readlinkSync(join(sourceRoot, "artifact", "link"))).toBe("../target with spaces");
    expect(host.manifestLeafPaths("source", "artifact")).toEqual([
      "artifact/binary",
      "artifact/executable",
      "artifact/link",
    ]);
    expect(host.inspect("source", "artifact")).toEqual({ kind: "directory" });

    const fifoPath = join(sourceRoot, "unsupported-fifo");
    const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8", shell: false });
    if (fifo.error !== undefined) throw fifo.error;
    if (fifo.status !== 0) throw new Error(`mkfifo exited ${fifo.status}: ${fifo.stderr}`);
    expect(host.inspect("source", "unsupported-fifo")).toEqual({
      kind: "unsupported",
      detail: "unsupported host filesystem entry",
    });

    expect(() => host.materializeTarget("input/executable", "artifact/binary", "100755")).toThrow();
    expect(readFileSync(join(sourceRoot, "artifact", "binary"))).toEqual(binary);
    expect(host.move("artifact/binary", "artifact/moved")).toEqual({ kind: "moved" });
    expect(host.move("artifact/executable", "artifact/moved")).toMatchObject({
      kind: "destination-exists",
    });
    expect(host.move("artifact/missing", "artifact/other")).toMatchObject({
      kind: "path-missing",
    });

    writeFileSync(infoExcludePath, "existing-without-newline");
    expect(host.ensureInfoExcludeRule("/.rennet/round-landings/")).toEqual({
      status: "installed",
    });
    expect(host.ensureInfoExcludeRule("/.rennet/round-landings/")).toEqual({
      status: "already-present",
    });
    expect(
      readFileSync(infoExcludePath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line === "/.rennet/round-landings/"),
    ).toHaveLength(1);

    mkdirSync(join(sourceRoot, "empty"));
    mkdirSync(join(sourceRoot, "not-empty"));
    writeFileSync(join(sourceRoot, "not-empty", "leaf"), "leaf");
    writeFileSync(join(sourceRoot, "not-directory"), "leaf");
    expect(host.removeEmptyDirectory("missing")).toBe("absent");
    expect(host.removeEmptyDirectory("empty")).toBe("removed");
    expect(host.removeEmptyDirectory("not-empty")).toBe("not-empty");
    expect(host.removeEmptyDirectory("not-directory")).toBe("not-directory");

    expect(host.remove("artifact", true)).toBeUndefined();
    expect(host.inspect("source", "artifact")).toEqual({ kind: "absent" });
    mkdirSync(join(sourceRoot, "parents", "nested"), { recursive: true });
    writeFileSync(join(sourceRoot, "parents", "nested", "leaf"), "leaf");
    host.remove("parents/nested/leaf", false);
    expect(host.removeEmptyParents("parents/nested/leaf")).toBeUndefined();
    expect(missing(join(sourceRoot, "parents"))).toBe(true);
  });

  it("recursively cleans a tree without following links outside it", () => {
    const { scratchRoot, sourceRoot, host } = fixture();
    const outside = join(scratchRoot, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep\n");
    mkdirSync(join(sourceRoot, "tree", "nested"), { recursive: true });
    writeFileSync(join(sourceRoot, "tree", "nested", "leaf"), "delete\n");
    symlinkSync(outside, join(sourceRoot, "tree", "outside-link"), "dir");

    expect(host.remove("tree", true)).toBeUndefined();
    expect(missing(join(sourceRoot, "tree"))).toBe(true);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep\n");

    symlinkSync(outside, join(sourceRoot, "escape"), "dir");
    expect(() => host.remove("escape/sentinel", true)).toThrow();
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  it("allows one process to win an exclusive rooted move", async () => {
    const { sourceRoot, workerRoot, infoExcludePath } = fixture();
    const contenders = Array.from({ length: 16 }, (_, index) => `contender-${index}`);
    for (const contender of contenders) writeFileSync(join(sourceRoot, contender), contender);

    const outcomes = await Promise.all(
      contenders.map((source) =>
        runContender({
          sourceRoot,
          workerRoot,
          infoExcludePath,
          source,
          destination: "winner",
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.kind === "moved")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "destination-exists")).toHaveLength(15);
    expect(contenders).toContain(readFileSync(join(sourceRoot, "winner"), "utf8"));
  });

  it("closes idempotently and rejects later operations", () => {
    const { host } = fixture();
    expect(host.close()).toBeUndefined();
    expect(host.close()).toBeUndefined();
    expect(() => host.inspect("source", "anything")).toThrow(/closed/);
    expect(() => host.ensureInfoExcludeRule("/.rennet/")).toThrow(/closed/);
    expect(lstatSync(addonPath).isFile()).toBe(true);
  });
});
