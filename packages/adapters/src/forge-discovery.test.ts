import { describe, expect, it } from "vitest";
import {
  createForgeCommandRunner,
  defaultForgeDetectionDeps,
  detectForge,
  detectForges,
  FORGE_REGISTRY,
  type ForgeCommandRunner,
  type ForgeDetectionDeps,
  githubForge,
  resolveGitHubCliToken,
} from "./forge-discovery";

interface Fixture {
  loginShellPath?: string | null;
  envPath?: string;
  home?: string;
  dirContents?: Record<string, readonly string[]>;
  executables?: ReadonlySet<string>;
  versions?: Record<string, string>;
  authed?: ReadonlySet<string>;
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
    probeAuth: (path) => {
      accessed.push(`auth ${path}`);
      return Promise.resolve(fixture.authed?.has(path) ?? false);
    },
    platform: fixture.platform ?? "linux",
    pathExt: fixture.pathExt,
  };
  return { deps, accessed };
}

describe("forge-discovery (gh CLI detection)", () => {
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
    expect(accessed).toContain("auth /opt/homebrew/bin/gh");
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
      detail: expect.stringContaining("not found"),
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

  it("detectForges runs the singleton registry (#484 boundary: gh only)", async () => {
    expect(FORGE_REGISTRY.map((spec) => spec.id)).toEqual(["github"]);
    const { deps } = recordingDeps({
      dirContents: { "/usr/local/bin": ["gh"] },
      executables: new Set(["/usr/local/bin/gh"]),
      versions: { "/usr/local/bin/gh": "2.40.1" },
      authed: new Set(["/usr/local/bin/gh"]),
    });
    const detected = await detectForges(deps);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.id).toBe("github");
    expect(detected[0]?.status).toBe("available");
  });

  it("defaultForgeDetectionDeps carries the real gh binary name + host platform", () => {
    const deps = defaultForgeDetectionDeps();
    expect(deps.platform).toBe(process.platform);
    expect(githubForge.binary).toBe("gh");
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
