import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createForgeCommandRunner,
  defaultForgeDetectionDeps,
  detectForge,
  detectForges,
  FORGE_REGISTRY,
  type ForgeAuthProbe,
  type ForgeCommandRunner,
  type ForgeDetectionDeps,
  githubForge,
  gitlabForge,
  resolveGitHubCliToken,
  wslForgeAuthCommand,
} from "./forge-discovery";

interface Fixture {
  loginShellPath?: string | null;
  envPath?: string;
  home?: string;
  dirContents?: Record<string, readonly string[]>;
  executables?: ReadonlySet<string>;
  versions?: Record<string, string>;
  authed?: ReadonlySet<string>;
  authOutputs?: Readonly<Record<string, string>>;
  unreachableAuth?: ReadonlySet<string>;
  platform?: NodeJS.Platform;
  pathExt?: string;
}

/** Records every path a probe touched, so a test can assert NO credential file is read
 *  and that the auth probe never runs when the binary is absent. */
function recordingDeps(fixture: Fixture): { deps: ForgeDetectionDeps; accessed: string[] } {
  const accessed: string[] = [];
  const deps: ForgeDetectionDeps = {
    loginShellPath: () => Promise.resolve(fixture.loginShellPath ?? "/usr/bin:/bin"),
    envPath: fixture.envPath ?? "/usr/bin:/bin",
    home: fixture.home ?? "/home/rai",
    listDir: (directory) => {
      accessed.push(`list ${directory}`);
      return Promise.resolve(fixture.dirContents?.[directory] ?? []);
    },
    isExecutable: (path) => {
      accessed.push(`x ${path}`);
      return Promise.resolve(fixture.executables?.has(path) ?? false);
    },
    probeVersion: (path) => {
      accessed.push(`version ${path}`);
      return Promise.resolve(fixture.versions?.[path] ?? null);
    },
    probeAuth: (path, args) => {
      accessed.push(`auth ${path} ${args.join(" ")}`);
      let result: ForgeAuthProbe;
      if (fixture.unreachableAuth?.has(path)) {
        result = { kind: "unreachable" };
      } else if (fixture.authed?.has(path)) {
        result = { kind: "authenticated" };
      } else {
        result = {
          kind: "failed",
          output:
            fixture.authOutputs?.[path] ??
            (path.toLowerCase().includes("glab")
              ? "gitlab.com has not been authenticated with glab"
              : "You are not logged into any GitHub hosts"),
        };
      }
      return Promise.resolve(result);
    },
    platform: fixture.platform ?? "linux",
    pathExt: fixture.pathExt,
  };
  return { deps, accessed };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("forge-discovery (forge CLI detection)", () => {
  it("reports `available` for a present, authenticated gh", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: { "/opt/homebrew/bin/gh": "2.62.0" },
      authed: new Set(["/opt/homebrew/bin/gh"]),
    });
    const detected = await detectForge(githubForge, deps);
    expect(detected).toEqual({
      id: "github",
      version: "2.62.0",
      status: "available",
      detail: expect.stringContaining("Authenticated"),
    });
  });

  it("reports `not-authenticated` for a present-but-signed-out gh", async () => {
    const { deps, accessed } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: { "/opt/homebrew/bin/gh": "2.62.0" },
      authed: new Set(), // gh present, but `gh auth status` failed
    });
    const detected = await detectForge(githubForge, deps);
    expect(detected.status).toBe("not-authenticated");
    expect(detected.version).toBe("2.62.0");
    expect(detected.detail).toContain("gh auth login");
    // The auth probe DID run against the resolved binary (it is present).
    expect(accessed).toContain("auth /opt/homebrew/bin/gh auth status");
  });

  it("POSITIVE CONTROL: gh absent from PATH ⇒ not-installed, no version, no auth probe", async () => {
    const { deps, accessed } = recordingDeps({
      // No directory lists a `gh` entry — the rename-out-of-PATH invariant at unit scale.
      dirContents: { "/opt/homebrew/bin": ["git", "node"] },
      executables: new Set(["/opt/homebrew/bin/gh"]), // even if X_OK would pass, absence wins
      versions: { "/opt/homebrew/bin/gh": "2.62.0" }, // must NOT surface as a stale hit
      authed: new Set(["/opt/homebrew/bin/gh"]),
    });
    const detected = await detectForge(githubForge, deps);
    expect(detected).toEqual({
      id: "github",
      version: null,
      status: "not-installed",
      detail:
        "The `gh` CLI was not found on this host. On Linux, run `brew install gh` after installing Homebrew from https://brew.sh if needed.",
    });
    // No stale version, and crucially the auth probe never ran (nothing to authenticate).
    expect(accessed.some((entry) => entry.startsWith("auth "))).toBe(false);
    expect(accessed.some((entry) => entry.startsWith("version "))).toBe(false);
  });

  it("does not treat a gh that will not answer --version as installed", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: {}, // resolves + is executable, but --version returns null
    });
    const detected = await detectForge(githubForge, deps);
    expect(detected.status).toBe("not-installed");
    expect(detected.version).toBeNull();
  });

  it("reports exact platform repair instructions for a missing GitHub CLI", async () => {
    await expect(
      detectForge(githubForge, recordingDeps({ platform: "darwin" }).deps),
    ).resolves.toEqual({
      id: "github",
      version: null,
      status: "not-installed",
      detail: "The `gh` CLI was not found on this host. Run `brew install gh`.",
    });
    await expect(
      detectForge(githubForge, recordingDeps({ platform: "win32" }).deps),
    ).resolves.toEqual({
      id: "github",
      version: null,
      status: "not-installed",
      detail: "The `gh` CLI was not found on this host. Run `winget install --id GitHub.cli`.",
    });
  });

  it("reports `available` for a present, authenticated glab", async () => {
    const { deps, accessed } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["glab"] },
      executables: new Set(["/opt/homebrew/bin/glab"]),
      versions: { "/opt/homebrew/bin/glab": "1.80.0" },
      authed: new Set(["/opt/homebrew/bin/glab"]),
    });
    const detected = await detectForge(gitlabForge, deps);
    expect(detected).toEqual({
      id: "gitlab",
      version: "1.80.0",
      status: "available",
      detail: expect.stringContaining("Authenticated with GitLab"),
    });
    expect(accessed).toContain("auth /opt/homebrew/bin/glab auth status --hostname gitlab.com");
  });

  it("reports exact platform repair instructions for missing and signed-out installs", async () => {
    const signedOut = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["glab"] },
      executables: new Set(["/opt/homebrew/bin/glab"]),
      versions: { "/opt/homebrew/bin/glab": "1.80.0" },
      authed: new Set(),
      platform: "darwin",
    });
    await expect(detectForge(gitlabForge, signedOut.deps)).resolves.toEqual({
      id: "gitlab",
      version: "1.80.0",
      status: "not-authenticated",
      detail:
        "`glab` is installed but not signed in to gitlab.com. Run `glab auth login --hostname gitlab.com`.",
    });

    const missingMac = recordingDeps({ platform: "darwin" });
    await expect(detectForge(gitlabForge, missingMac.deps)).resolves.toEqual({
      id: "gitlab",
      version: null,
      status: "not-installed",
      detail: "The `glab` CLI was not found on this host. Run `brew install glab`.",
    });

    const missingWindows = recordingDeps({ platform: "win32" });
    await expect(detectForge(gitlabForge, missingWindows.deps)).resolves.toEqual({
      id: "gitlab",
      version: null,
      status: "not-installed",
      detail: "The `glab` CLI was not found on this host. Run `winget install glab.glab`.",
    });

    const missingLinux = recordingDeps({ platform: "linux" });
    await expect(detectForge(gitlabForge, missingLinux.deps)).resolves.toEqual({
      id: "gitlab",
      version: null,
      status: "not-installed",
      detail:
        "The `glab` CLI was not found on this host. On Linux, run `brew install glab` after installing Homebrew from https://brew.sh if needed.",
    });
  });

  it("finds a WinGet user-scope glab install even when the app PATH is stale", async () => {
    const home = "C:\\Users\\rai";
    vi.stubEnv("LOCALAPPDATA", `${home}\\AppData\\Local`);
    const installed = "C:\\Users\\rai\\AppData\\Local\\Programs\\glab\\glab.exe";
    const { deps, accessed } = recordingDeps({
      home,
      envPath: "C:\\Windows\\System32",
      loginShellPath: null,
      platform: "win32",
      pathExt: ".EXE;.CMD",
      dirContents: { "C:\\Users\\rai\\AppData\\Local\\Programs\\glab": ["glab.exe"] },
      executables: new Set([installed]),
      versions: { [installed]: "1.111.0" },
      authed: new Set([installed]),
    });

    await expect(detectForge(gitlabForge, deps)).resolves.toMatchObject({
      status: "available",
      version: "1.111.0",
    });
    expect(accessed).toContain(`version ${installed}`);
  });

  it("distinguishes credential rejection from a failed GitLab service probe", async () => {
    const path = "/usr/local/bin/glab";
    const base = {
      dirContents: { "/usr/local/bin": ["glab"] },
      executables: new Set([path]),
      versions: { [path]: "1.80.0" },
    };
    const rejected = recordingDeps({
      ...base,
      authOutputs: { [path]: "gitlab.com: API call failed: 401 Unauthorized" },
    });
    const revokedOAuth = recordingDeps({
      ...base,
      authOutputs: {
        [path]:
          'gitlab.com: API call failed: Get "https://gitlab.com/api/v4/user": oauth2: "invalid_grant" "Token is expired or revoked"',
      },
    });
    const offline = recordingDeps({
      ...base,
      authOutputs: {
        [path]:
          "gitlab.com: API call failed: dial tcp: no such host\nNo token found (checked config file, keyring, and environment variables).",
      },
    });
    const offlineWithEnvironmentToken = recordingDeps({
      ...base,
      authOutputs: {
        [path]:
          "gitlab.com: API call failed: dial tcp: lookup gitlab.com: no such host\nA wrapper may be injecting a different or expired token from the GITLAB_TOKEN environment variable.",
      },
    });
    const timedOut = recordingDeps({ ...base, unreachableAuth: new Set([path]) });

    await expect(detectForge(gitlabForge, rejected.deps)).resolves.toMatchObject({
      status: "not-authenticated",
    });
    const revoked = await detectForge(gitlabForge, revokedOAuth.deps);
    expect(revoked.status).toBe("not-authenticated");
    expect(revoked).not.toHaveProperty("authProbe");
    await expect(detectForge(gitlabForge, offline.deps)).resolves.toEqual({
      id: "gitlab",
      version: "1.80.0",
      status: "not-authenticated",
      authProbe: "unreachable",
      detail:
        "`glab` could not reach or verify GitLab.com. Run `glab auth status --hostname gitlab.com`.",
    });
    await expect(detectForge(gitlabForge, timedOut.deps)).resolves.toMatchObject({
      status: "not-authenticated",
      authProbe: "unreachable",
    });
    await expect(detectForge(gitlabForge, offlineWithEnvironmentToken.deps)).resolves.toMatchObject(
      {
        status: "not-authenticated",
        authProbe: "unreachable",
      },
    );
  });

  it("detectForges runs the GitHub + GitLab registry on the same host", async () => {
    expect(FORGE_REGISTRY.map((spec) => spec.id)).toEqual(["github", "gitlab"]);
    const { deps } = recordingDeps({
      dirContents: { "/usr/local/bin": ["gh", "glab"] },
      executables: new Set(["/usr/local/bin/gh", "/usr/local/bin/glab"]),
      versions: {
        "/usr/local/bin/gh": "2.40.1",
        "/usr/local/bin/glab": "1.80.0",
      },
      authed: new Set(["/usr/local/bin/gh", "/usr/local/bin/glab"]),
    });
    const detected = await detectForges(deps);
    expect(detected).toEqual([
      expect.objectContaining({ id: "github", status: "available" }),
      expect.objectContaining({ id: "gitlab", status: "available" }),
    ]);
  });

  it("keeps an authenticated GitHub row when GitLab is not installed", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/usr/local/bin": ["gh"] },
      executables: new Set(["/usr/local/bin/gh"]),
      versions: { "/usr/local/bin/gh": "2.76.0" },
      authed: new Set(["/usr/local/bin/gh"]),
    });

    await expect(detectForges(deps)).resolves.toEqual([
      expect.objectContaining({ id: "github", status: "available", version: "2.76.0" }),
      expect.objectContaining({ id: "gitlab", status: "not-installed", version: null }),
    ]);
  });

  it("keeps an authenticated GitLab row when GitHub is not installed", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/usr/local/bin": ["glab"] },
      executables: new Set(["/usr/local/bin/glab"]),
      versions: { "/usr/local/bin/glab": "1.80.0" },
      authed: new Set(["/usr/local/bin/glab"]),
    });

    await expect(detectForges(deps)).resolves.toEqual([
      expect.objectContaining({ id: "github", status: "not-installed", version: null }),
      expect.objectContaining({ id: "gitlab", status: "available", version: "1.80.0" }),
    ]);
  });

  it("plans GitLab auth inside the selected WSL distro with provider argv intact", () => {
    expect(wslForgeAuthCommand("Ubuntu", "/usr/bin/glab", gitlabForge.authStatusArgs)).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu", "-e", "/usr/bin/glab", "auth", "status", "--hostname", "gitlab.com"],
    });
  });

  it("includes both machine-scope glab installer directories on Windows", () => {
    const directories = gitlabForge.knownDirectories("C:\\Users\\rai", "win32");
    expect(directories.some((directory) => directory.endsWith("\\Program Files\\glab"))).toBe(true);
    expect(directories.some((directory) => directory.endsWith("\\Program Files (x86)\\glab"))).toBe(
      true,
    );
  });

  it("defaultForgeDetectionDeps carries the registered binary names + host platform", () => {
    const deps = defaultForgeDetectionDeps();
    expect(deps.platform).toBe(process.platform);
    expect(githubForge.binary).toBe("gh");
    expect(gitlabForge.binary).toBe("glab");
  });
});

describe("resolveGitHubCliToken", () => {
  it("executes the exact proven gh path with the github.com token argv", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: { "/opt/homebrew/bin/gh": "2.62.0" },
    });
    const calls: { executable: string; args: readonly string[] }[] = [];
    const run: ForgeCommandRunner = (executable, args) => {
      calls.push({ executable, args });
      return Promise.resolve({ exitCode: 0, stdout: "  gho_from_cli\n" });
    };

    await expect(resolveGitHubCliToken(deps, run)).resolves.toEqual({
      kind: "token",
      token: "gho_from_cli",
    });
    expect(calls).toEqual([
      {
        executable: "/opt/homebrew/bin/gh",
        args: ["auth", "token", "--hostname", "github.com"],
      },
    ]);
  });

  it("kills a stalled credential command at its deadline", async () => {
    const run = createForgeCommandRunner(100);

    await expect(
      run(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"]),
    ).resolves.toEqual({ exitCode: 1, stdout: "" });
  });

  it("does not invoke a command when no gh binary is proven", async () => {
    const { deps } = recordingDeps({ dirContents: { "/opt/homebrew/bin": ["git"] } });
    const run: ForgeCommandRunner = () => {
      throw new Error("must not run");
    };

    await expect(resolveGitHubCliToken(deps, run)).resolves.toEqual({ kind: "missing" });
  });

  it("keeps a present executable whose version probe fails gh-owned", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: {},
    });
    const run: ForgeCommandRunner = () => {
      throw new Error("must not ask an unproven binary for a token");
    };

    await expect(resolveGitHubCliToken(deps, run)).resolves.toEqual({ kind: "failure" });
  });

  it("uses a later valid candidate after an earlier executable fails its version probe", async () => {
    const { deps } = recordingDeps({
      dirContents: {
        "/opt/homebrew/bin": ["gh"],
        "/usr/local/bin": ["gh"],
      },
      executables: new Set(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]),
      versions: { "/usr/local/bin/gh": "2.62.0" },
    });
    const calls: string[] = [];
    const run: ForgeCommandRunner = (executable) => {
      calls.push(executable);
      return Promise.resolve({ exitCode: 0, stdout: "gho_from_later_candidate" });
    };

    await expect(resolveGitHubCliToken(deps, run)).resolves.toEqual({
      kind: "token",
      token: "gho_from_later_candidate",
    });
    expect(calls).toEqual(["/usr/local/bin/gh"]);
  });

  it("keeps every present-CLI command failure gh-owned and secret-free", async () => {
    const { deps } = recordingDeps({
      dirContents: { "/opt/homebrew/bin": ["gh"] },
      executables: new Set(["/opt/homebrew/bin/gh"]),
      versions: { "/opt/homebrew/bin/gh": "2.62.0" },
    });

    const nonzero = await resolveGitHubCliToken(deps, () =>
      Promise.resolve({ exitCode: 1, stdout: "gho_stdout_must_not_escape" }),
    );
    const empty = await resolveGitHubCliToken(deps, () =>
      Promise.resolve({ exitCode: 0, stdout: " \n" }),
    );
    const thrown = await resolveGitHubCliToken(deps, () =>
      Promise.reject(new Error("gho_error_must_not_escape")),
    );

    expect([nonzero, empty, thrown]).toEqual([
      { kind: "failure" },
      { kind: "failure" },
      { kind: "failure" },
    ]);
    const serialized = JSON.stringify([nonzero, empty, thrown]);
    expect(serialized).not.toContain("gho_stdout_must_not_escape");
    expect(serialized).not.toContain("gho_error_must_not_escape");
  });
});
