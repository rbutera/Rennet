import { describe, expect, it } from "vitest";
import {
  compareVersions,
  type DiscoveryDeps,
  discoverClaude,
  type VersionRange,
} from "./harness-discovery";

const RANGE: VersionRange = { min: "2.0.0", maxTested: "2.1.220" };

interface Fixture {
  loginShellPath?: string | null;
  envPath?: string;
  home?: string;
  dirContents?: Record<string, readonly string[]>;
  executables?: ReadonlySet<string>;
  versions?: Record<string, string>;
}

function recordingDeps(fixture: Fixture): { deps: DiscoveryDeps; accessed: string[] } {
  const accessed: string[] = [];
  const deps: DiscoveryDeps = {
    loginShellPath: () => Promise.resolve(fixture.loginShellPath ?? "/usr/bin:/bin"),
    envPath: fixture.envPath ?? "/usr/bin:/bin",
    home: fixture.home ?? "/home/rai",
    listDir: (directory) => {
      accessed.push(directory);
      return Promise.resolve(fixture.dirContents?.[directory] ?? []);
    },
    isExecutable: (path) => {
      accessed.push(path);
      return Promise.resolve(fixture.executables?.has(path) ?? false);
    },
    probeVersion: (path) => {
      accessed.push(path);
      return Promise.resolve(fixture.versions?.[path] ?? null);
    },
  };
  return { deps, accessed };
}

/** A credential FILE, never a bin directory. `~/.claude/local` is a bin dir, not a secret. */
function isCredentialPath(path: string): boolean {
  return (
    path.endsWith("/.credentials.json") ||
    path.endsWith("/auth.json") ||
    path.includes("/.codex/auth")
  );
}

describe("discoverClaude", () => {
  it("finds claude in a bare login shell where it is a shell function", async () => {
    // The login-shell PATH (approximating launchd's minimal env) does NOT
    // contain the real bin dir, and `claude` is a shell function so `command -v`
    // would return a function body. Discovery must still find it via a known
    // location, resolved by readdir + X_OK, proven by execution.
    const claude = "/home/rai/.local/bin/claude";
    const { deps } = recordingDeps({
      loginShellPath: "/usr/bin:/bin",
      envPath: "/usr/bin:/bin",
      home: "/home/rai",
      dirContents: { "/home/rai/.local/bin": ["claude", "node"], "/usr/bin": ["ls"] },
      executables: new Set([claude]),
      versions: { [claude]: "2.1.220" },
    });
    const result = await discoverClaude(deps, RANGE);
    expect(result.chosen).toEqual({ path: claude, version: "2.1.220" });
    expect(result.health).toEqual({ state: "ready", version: "2.1.220" });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.fromKnownLocation).toBe(true);
  });

  it("never requests a credential path, and the control proves the check can fire", async () => {
    const claude = "/home/rai/.local/bin/claude";
    const { deps, accessed } = recordingDeps({
      home: "/home/rai",
      dirContents: { "/home/rai/.local/bin": ["claude"] },
      executables: new Set([claude]),
      versions: { [claude]: "2.1.220" },
    });
    await discoverClaude(deps, RANGE);
    // Positive control: the reader actually touched the filesystem.
    expect(accessed.length).toBeGreaterThan(0);
    // The finding: none of those touches was a credential file.
    expect(accessed.filter(isCredentialPath)).toEqual([]);
    // Control that the predicate CAN catch a credential path (81ak).
    expect(isCredentialPath("/home/rai/.claude/.credentials.json")).toBe(true);
    expect(isCredentialPath("/home/rai/.codex/auth.json")).toBe(true);
    expect(isCredentialPath("/home/rai/.claude/local")).toBe(false);
    expect(isCredentialPath("/home/rai/.local/bin")).toBe(false);
  });

  it("reports unavailable/not-found when no binary exists anywhere", async () => {
    const { deps } = recordingDeps({ dirContents: {} });
    const result = await discoverClaude(deps, RANGE);
    expect(result.chosen).toBeNull();
    expect(result.health).toEqual({
      state: "unavailable",
      reason: "not-found",
      detail: expect.any(String),
    });
  });

  it("degrades above-tested for a version beyond the ceiling", async () => {
    const claude = "/opt/homebrew/bin/claude";
    const { deps } = recordingDeps({
      loginShellPath: "/opt/homebrew/bin",
      envPath: "/opt/homebrew/bin",
      dirContents: { "/opt/homebrew/bin": ["claude"] },
      executables: new Set([claude]),
      versions: { [claude]: "3.0.0" },
    });
    const result = await discoverClaude(deps, RANGE);
    expect(result.health).toEqual({ state: "degraded", version: "3.0.0", reason: "above-tested" });
  });
});

describe("compareVersions", () => {
  it("orders numeric version tuples", () => {
    expect(compareVersions("2.1.220", "2.1.220")).toBe(0);
    expect(compareVersions("2.0.0", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("2.1.221", "2.1.220")).toBeGreaterThan(0);
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
  });
});
