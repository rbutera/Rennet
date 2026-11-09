import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type InstallOutputStream,
  type InstallPlan,
  resolveInstallPlan,
  runInstallPlan,
  TOOL_DOCS_URL,
} from "./tool-install";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

function script(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A stub Homebrew and a stub git on a PATH of their own. Each logs its argv to `calls`,
 * so a test can assert what ran, in what order, and what did not run at all.
 */
function stubs(brewExit: number): { bin: string; calls: string } {
  const bin = dir("rennet-stub-brew-");
  const calls = join(bin, "calls.log");
  script(
    bin,
    "brew",
    [
      `echo "brew $*" >> "${calls}"`,
      'echo "==> Downloading $2"',
      'echo "==> Pouring $2" ',
      'echo "Warning: a stub is pouring" >&2',
      brewExit === 0 ? "exit 0" : `echo "Error: $2: no bottle available" >&2\nexit ${brewExit}`,
    ].join("\n"),
  );
  // `git lfs install` must find what brew put on the PATH: the stub answers only then.
  script(bin, "git", [`echo "git $*" >> "${calls}"`, 'echo "Git LFS initialized."'].join("\n"));
  return { bin, calls };
}

/** `path` is the WHOLE inherited PATH the runner sees: `/bin` carries no git, so a step
 *  can only find the stub git through the plan's own prefix, and a missing prefix fails
 *  instead of running a real `git lfs install` against the real global config. */
async function run(plan: InstallPlan, path?: string) {
  const chunks: { chunk: string; stream: InstallOutputStream }[] = [];
  let probes = 0;
  const result = await runInstallPlan(plan, {
    onOutput: (chunk, stream) => chunks.push({ chunk, stream }),
    reprobe: async () => {
      probes += 1;
      return { status: "available" as const };
    },
    ...(path === undefined ? {} : { env: { PATH: path } }),
  });
  return { result, chunks, probes };
}

describe("resolveInstallPlan", () => {
  it("plans brew install git-lfs then git lfs install on macOS with brew on the PATH", async () => {
    const { bin } = stubs(0);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: `${bin}:/usr/bin`,
      brewDirectories: [],
    });
    expect(plan).toEqual({
      plan: "brew",
      tool: "git-lfs",
      steps: [
        { file: join(bin, "brew"), args: ["install", "git-lfs"] },
        { file: "git", args: ["lfs", "install"] },
      ],
      command: "brew install git-lfs && git lfs install",
      pathPrefix: bin,
    });
  });

  it("plans brew install git for git", async () => {
    const { bin } = stubs(0);
    const plan = await resolveInstallPlan("git", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    expect(plan).toMatchObject({
      plan: "brew",
      steps: [{ file: join(bin, "brew"), args: ["install", "git"] }],
      command: "brew install git",
    });
  });

  it("finds brew in Homebrew's own directory when the PATH lacks it", async () => {
    const { bin } = stubs(0);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: "/usr/bin:/bin",
      brewDirectories: [bin],
    });
    expect(plan).toMatchObject({ plan: "brew", pathPrefix: bin });
  });

  it("falls back to manual instructions when brew is absent", async () => {
    const empty = dir("rennet-no-brew-");
    expect(
      await resolveInstallPlan("git-lfs", {
        platform: "darwin",
        envPath: empty,
        brewDirectories: [],
      }),
    ).toEqual({
      plan: "manual",
      tool: "git-lfs",
      command: "brew install git-lfs && git lfs install",
      docsUrl: TOOL_DOCS_URL["git-lfs"],
    });
    expect(
      await resolveInstallPlan("git", { platform: "darwin", envPath: empty, brewDirectories: [] }),
    ).toMatchObject({ plan: "manual", command: "xcode-select --install" });
  });

  it("is manual off macOS even with brew present", async () => {
    const { bin } = stubs(0);
    expect(
      await resolveInstallPlan("git-lfs", { platform: "linux", envPath: bin, brewDirectories: [] }),
    ).toMatchObject({ plan: "manual", command: "sudo apt-get install git-lfs && git lfs install" });
    expect(
      await resolveInstallPlan("git", { platform: "win32", envPath: bin, brewDirectories: [] }),
    ).toMatchObject({ plan: "manual", command: "winget install --id Git.Git" });
  });
});

describe("runInstallPlan", () => {
  it("runs brew then git lfs install, streams their output, and re-probes", async () => {
    const { bin, calls } = stubs(0);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    // Only Homebrew's directory carries the stub git, so `git lfs install` resolving it
    // proves the prefix reached the second step.
    const { result, chunks, probes } = await run(plan, "/bin");

    expect(result.status).toBe("installed");
    expect(readFileSync(calls, "utf8")).toBe("brew install git-lfs\ngit lfs install\n");
    expect(probes).toBe(1);
    const streamed = chunks.map((entry) => entry.chunk).join("");
    expect(streamed).toContain("$ brew install git-lfs");
    expect(streamed).toContain("==> Pouring git-lfs");
    expect(streamed).toContain("$ git lfs install");
    expect(streamed).toContain("Git LFS initialized.");
    expect(
      chunks.some((entry) => entry.stream === "stderr" && entry.chunk.includes("Warning")),
    ).toBe(true);
    if (result.status === "installed") expect(result.output).toBe(streamed);
    expect(result.probe).toEqual({ status: "available" });
  });

  it("stops at a failing brew, keeps its output as detail, and still re-probes", async () => {
    const { bin, calls } = stubs(1);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    const { result, probes } = await run(plan, "/bin");

    expect(result).toMatchObject({
      status: "failed",
      message: "Git LFS couldn't be installed.",
      failedCommand: "brew install git-lfs",
      exitCode: 1,
    });
    if (result.status === "failed") expect(result.output).toContain("no bottle available");
    // The second step never ran.
    expect(readFileSync(calls, "utf8")).toBe("brew install git-lfs\n");
    expect(probes).toBe(1);
  });

  it("reports a step that cannot start as failed with the reason", async () => {
    const plan: InstallPlan = {
      plan: "brew",
      tool: "git",
      steps: [{ file: join(dir("rennet-gone-"), "brew"), args: ["install", "git"] }],
      command: "brew install git",
      pathPrefix: "/nowhere",
    };
    const { result } = await run(plan, "/bin");
    expect(result).toMatchObject({
      status: "failed",
      exitCode: null,
      message: "Git couldn't be installed.",
    });
    if (result.status === "failed") expect(result.output).toMatch(/ENOENT|not found|no such file/i);
  });

  it("runs nothing for a manual plan and re-probes", async () => {
    const empty = dir("rennet-no-brew-");
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: empty,
      brewDirectories: [],
    });
    const { result, chunks, probes } = await run(plan);
    expect(result).toEqual({ status: "manual", plan, probe: { status: "available" } });
    expect(chunks).toEqual([]);
    expect(probes).toBe(1);
    expect(existsSync(join(empty, "calls.log"))).toBe(false);
  });
});
