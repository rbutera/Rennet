import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_OUTPUT_CAP,
  type InstallOutputStream,
  type InstallPlan,
  OUTPUT_NOT_CAPTURED,
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
async function run(
  plan: InstallPlan,
  path?: string,
  probed: "available" | "not-installed" = "available",
) {
  const chunks: { chunk: string; stream: InstallOutputStream }[] = [];
  let probes = 0;
  const result = await runInstallPlan(plan, {
    onOutput: (chunk, stream) => chunks.push({ chunk, stream }),
    reprobe: async () => {
      probes += 1;
      return { status: probed };
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

  it("every step succeeding is not 'installed' when the re-probe still cannot find the tool", async () => {
    // Sighted in review: `installed` beside `probe.status: "not-installed"`. The verdict is
    // the re-probe's, so this says plainly that the tool is still not found.
    const { bin, calls } = stubs(0);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    const { result, probes } = await run(plan, "/bin", "not-installed");

    expect(readFileSync(calls, "utf8")).toBe("brew install git-lfs\ngit lfs install\n");
    expect(probes).toBe(1);
    expect(result).toMatchObject({
      status: "failed",
      message: "The install finished, but Rennet still can't find Git LFS on this machine.",
      failedCommand: "brew install git-lfs && git lfs install",
      exitCode: null,
      probe: { status: "not-installed" },
    });
    if (result.status === "failed") {
      expect(result.cancelled).toBeUndefined();
      expect(result.output).toContain("Git LFS initialized.");
    }
  });

  it("says the tool was installed but doesn't run yet when the re-probe finds it unreachable", async () => {
    // `unreachable` is a binary that is there but could not be asked. "Still can't find" would
    // send the person looking for an install that happened; the probe's own detail says why.
    const { bin } = stubs(0);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    const detail =
      "The first `git-lfs` on the PATH, `/opt/homebrew/bin/git-lfs`, did not answer `git-lfs --version`.";
    const result = await runInstallPlan(plan, {
      onOutput: () => undefined,
      reprobe: async () => ({ status: "unreachable", detail }),
      env: { PATH: "/bin" },
    });

    expect(result).toMatchObject({
      status: "failed",
      message: "Git LFS was installed, but Rennet can't run it yet.",
      exitCode: null,
      probe: { status: "unreachable", detail },
    });
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

  it("cancels the whole process tree, runs no later step, and still re-probes", async () => {
    const bin = dir("rennet-stub-brew-cancel-");
    const calls = join(bin, "calls.log");
    const late = join(bin, "late-write");
    // Homebrew's children (curl, tar, post-install scripts) outlive a signal to brew alone.
    // This brew starts one that writes a file after a delay, then waits.
    script(
      bin,
      "brew",
      [
        `echo "brew $*" >> "${calls}"`,
        `( sleep 1; echo "too late" > "${late}" ) &`,
        'echo "==> Downloading git-lfs"',
        "sleep 30",
      ].join("\n"),
    );
    script(bin, "git", `echo "git $*" >> "${calls}"`);
    const plan = await resolveInstallPlan("git-lfs", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });

    const controller = new AbortController();
    let probes = 0;
    const started = Date.now();
    const result = await runInstallPlan(plan, {
      // Cancel once brew is visibly running, so its child exists.
      onOutput: (chunk) => {
        if (chunk.includes("==> Downloading")) controller.abort();
      },
      reprobe: async () => {
        probes += 1;
        return { status: "not-installed" as const };
      },
      signal: controller.signal,
      env: { PATH: "/bin:/usr/bin" },
    });

    // Not held open by the child's inherited pipes, nor by brew's own `sleep 30`.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({
      status: "failed",
      failedCommand: "brew install git-lfs",
      exitCode: null,
      cancelled: true,
    });
    if (result.status === "failed") expect(result.output).toContain("Install cancelled.");
    expect(probes).toBe(1);
    expect(readFileSync(calls, "utf8")).toBe("brew install git-lfs\n");
    // Past the child's delay: had it survived the cancel, the file would be there.
    await sleep(1_800);
    expect(existsSync(late)).toBe(false);
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "kills a descendant that ignores SIGTERM, even once the step itself has exited",
    async () => {
      const bin = dir("rennet-stub-brew-stubborn-");
      const calls = join(bin, "calls.log");
      const late = join(bin, "late-write");
      // A post-install child that ignores SIGTERM (so does its `sleep`, which inherits the
      // ignored disposition) and keeps brew's pipes. brew itself dies on the SIGTERM, so
      // only an escalation that does not wait on brew's exit or its pipes can reach it.
      script(
        bin,
        "brew",
        [
          `echo "brew $*" >> "${calls}"`,
          `( trap '' TERM; sleep 3; echo "too late" > "${late}" ) &`,
          'echo "==> Downloading git-lfs"',
          "sleep 30",
        ].join("\n"),
      );
      script(bin, "git", `echo "git $*" >> "${calls}"`);
      const plan = await resolveInstallPlan("git-lfs", {
        platform: "darwin",
        envPath: bin,
        brewDirectories: [],
      });

      const controller = new AbortController();
      let aborted = 0;
      let probes = 0;
      const result = await runInstallPlan(plan, {
        onOutput: (chunk) => {
          if (chunk.includes("==> Downloading")) {
            aborted = Date.now();
            controller.abort();
          }
        },
        reprobe: async () => {
          probes += 1;
          return { status: "not-installed" as const };
        },
        signal: controller.signal,
        env: { PATH: "/bin:/usr/bin" },
      });

      expect(result).toMatchObject({
        status: "failed",
        failedCommand: "brew install git-lfs",
        exitCode: null,
        cancelled: true,
      });
      if (result.status === "failed") expect(result.output).toContain("Install cancelled.");
      expect(probes).toBe(1);
      expect(readFileSync(calls, "utf8")).toBe("brew install git-lfs\n");
      // Past the child's 3 s delay: had it outlived the cancel, the file would be there.
      await sleep(Math.max(0, 3_500 - (Date.now() - aborted)));
      expect(existsSync(late)).toBe(false);
    },
    20_000,
  );

  it.skipIf(!hasPerl())(
    "does not wait on a descendant that left the process group and kept the pipes",
    async () => {
      const bin = dir("rennet-stub-brew-daemon-");
      // A post-install that daemonises (new session) and keeps brew's stdout open.
      script(
        bin,
        "brew",
        ["perl -e 'use POSIX; setsid(); sleep 15;' &", 'echo "==> Done"', "exit 0"].join("\n"),
      );
      const plan = await resolveInstallPlan("git", {
        platform: "darwin",
        envPath: bin,
        brewDirectories: [],
      });
      const started = Date.now();
      const { result } = await run(plan, "/bin:/usr/bin");
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(result.status).toBe("installed");
      if (result.status === "installed") expect(result.output).toContain("==> Done");
    },
    20_000,
  );

  it("never drops output written after the step exits without saying so", async () => {
    const bin = dir("rennet-stub-brew-late-");
    // The step exits at once; a child it left behind writes its verdict a second later,
    // through the pipes it inherited.
    script(
      bin,
      "brew",
      ["( sleep 1; echo final-diagnostic ) &", 'echo "==> Done"', "exit 0"].join("\n"),
    );
    const plan = await resolveInstallPlan("git", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    const { result } = await run(plan, "/bin:/usr/bin");
    expect(result.status).toBe("installed");
    if (result.status !== "installed") return;
    expect(result.output).toContain("==> Done");
    const captured = result.output.includes("final-diagnostic");
    const flagged = result.output.includes(OUTPUT_NOT_CAPTURED);
    expect(captured || flagged).toBe(true);
  });

  it("counts every discarded character in the omitted marker and never splits a character", async () => {
    const bin = dir("rennet-stub-brew-loud-");
    // 3 bytes per line ("é\n"), 2 characters: well over twice the cap, in chunks whose
    // byte boundaries fall inside the two-byte "é".
    const lines = INSTALL_OUTPUT_CAP * 1.5;
    script(bin, "brew", `yes 'é' | head -n ${lines}`);
    const plan = await resolveInstallPlan("git", {
      platform: "darwin",
      envPath: bin,
      brewDirectories: [],
    });
    const { result, chunks } = await run(plan, "/bin:/usr/bin");
    expect(result.status).toBe("installed");
    const streamed = chunks.map((entry) => entry.chunk).join("");
    expect(streamed).not.toContain("\uFFFD");
    expect(streamed.length).toBe("$ brew install git\n".length + lines * 2);
    expect(streamed.length).toBeGreaterThan(INSTALL_OUTPUT_CAP * 2);
    if (result.status !== "installed") return;
    const omitted = streamed.length - INSTALL_OUTPUT_CAP;
    expect(result.output).toBe(
      `… ${omitted} characters of earlier output omitted …\n${streamed.slice(-INSTALL_OUTPUT_CAP)}`,
    );
  });
});

function hasPerl(): boolean {
  try {
    execFileSync("perl", ["-e", "use POSIX; exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
