import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  type DiscoveryDeps,
  defaultCodexDiscoveryDeps,
  discoverClaude,
  discoverCodex,
  discoverOmp,
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
  runtimeVersions?: Record<string, string>;
  pathExt?: string;
  platform?: NodeJS.Platform;
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
    probeVersionWithRuntime: (runtimePath, scriptPath) => {
      accessed.push(`${runtimePath} ${scriptPath}`);
      return Promise.resolve(fixture.runtimeVersions?.[scriptPath] ?? null);
    },
    pathExt: fixture.pathExt,
    platform: fixture.platform,
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

describe("discoverCodex (bead workspace-6qp15)", () => {
  const HOME = "/home/rai";
  const INSTALLS = "/home/rai/.asdf/installs/nodejs";
  const SHIMS = "/home/rai/.asdf/shims";
  const goodInstall = "/home/rai/.asdf/installs/nodejs/24.16.0/bin/codex";
  const brokenInstall = "/home/rai/.asdf/installs/nodejs/22.18.0/bin/codex";
  const shim = "/home/rai/.asdf/shims/codex";

  it("resolves the ABSOLUTE real install and prefers it over the on-PATH shim", async () => {
    // The exact machine shape of the bug: the shim is what is on PATH, but the
    // dependable binary is the absolute asdf install path. Both probe to the same
    // version, so only the shim-demotion — not a version tiebreak — can pick the
    // real install. That is precisely what stops the Codex seat launching a shim.
    const { deps } = recordingDeps({
      loginShellPath: `${SHIMS}:/usr/bin`,
      envPath: `${SHIMS}:/usr/bin`,
      home: HOME,
      dirContents: {
        [INSTALLS]: ["24.16.0", "22.18.0"],
        "/home/rai/.asdf/installs/nodejs/24.16.0/bin": ["codex", "node"],
        "/home/rai/.asdf/installs/nodejs/22.18.0/bin": ["codex"],
        [SHIMS]: ["codex", "node"],
      },
      executables: new Set([goodInstall, brokenInstall, shim]),
      // The broken install answers no version (the ENOENT-on-vendored-binary case);
      // the good install and the shim both report the same version.
      versions: { [goodInstall]: "0.144.1", [shim]: "0.144.1" },
    });
    const result = await discoverCodex(deps);
    expect(result.chosen).toEqual({ path: goodInstall, version: "0.144.1" });
    expect(result.chosen?.path).not.toBe(shim);
    expect(result.health).toEqual({ state: "ready", version: "0.144.1" });
  });

  it("falls back to the shim when the only versioned candidate IS the shim", async () => {
    // A broken install (no version, filtered out) plus a working shim: the shim is
    // an absolute path too and is a legitimate last resort. Proves version-probing
    // excludes the broken install rather than blindly picking the first on PATH.
    const { deps } = recordingDeps({
      loginShellPath: `${SHIMS}:/usr/bin`,
      envPath: `${SHIMS}:/usr/bin`,
      home: HOME,
      dirContents: {
        [INSTALLS]: ["22.18.0"],
        "/home/rai/.asdf/installs/nodejs/22.18.0/bin": ["codex"],
        [SHIMS]: ["codex"],
      },
      executables: new Set([brokenInstall, shim]),
      versions: { [shim]: "0.144.1" },
    });
    const result = await discoverCodex(deps);
    expect(result.chosen).toEqual({ path: shim, version: "0.144.1" });
  });

  it("fails LOUD (unavailable/not-found) when no codex exists anywhere", async () => {
    // The honesty contract the composition root depends on: no resolvable codex →
    // chosen is null → the desktop passes NO codex port → the pipeline degrades to
    // single-Claude with the existing DEGRADED marker, never a silent single seat
    // masquerading as a dual-model run. A null `chosen` means there is no path to
    // bind an executor to at all.
    const { deps } = recordingDeps({ home: HOME, dirContents: {} });
    const result = await discoverCodex(deps);
    expect(result.chosen).toBeNull();
    expect(result.health).toEqual({
      state: "unavailable",
      reason: "not-found",
      detail: expect.any(String),
    });
  });

  it("fails LOUD (unavailable/spawn-failed) when a codex is found but reports no version", async () => {
    // A present-but-unrunnable codex (the broken shim/install) must NOT be chosen:
    // launching it is exactly the silent-degrade we are removing.
    const { deps } = recordingDeps({
      loginShellPath: `${SHIMS}:/usr/bin`,
      envPath: `${SHIMS}:/usr/bin`,
      home: HOME,
      dirContents: { [SHIMS]: ["codex"] },
      executables: new Set([shim]),
      versions: {},
    });
    const result = await discoverCodex(deps);
    expect(result.chosen).toBeNull();
    expect(result.health).toEqual({
      state: "unavailable",
      reason: "spawn-failed",
      detail: expect.any(String),
    });
  });

  it("honours an explicit override path when it runs", async () => {
    const custom = "/custom/bin/codex";
    const { deps } = recordingDeps({
      home: HOME,
      dirContents: { [SHIMS]: ["codex"] },
      executables: new Set([custom, shim]),
      versions: { [custom]: "0.150.0", [shim]: "0.144.1" },
    });
    const result = await discoverCodex(deps, { explicitBin: custom });
    expect(result.chosen).toEqual({ path: custom, version: "0.150.0" });
  });

  it("ignores a broken explicit override and falls through to discovery", async () => {
    // A stale/broken RENNET_CODEX_BIN must not brick the app: it falls through to
    // normal resolution rather than being trusted blindly.
    const stale = "/custom/bin/codex";
    const { deps } = recordingDeps({
      loginShellPath: `${SHIMS}:/usr/bin`,
      envPath: `${SHIMS}:/usr/bin`,
      home: HOME,
      dirContents: { [SHIMS]: ["codex"] },
      executables: new Set([stale, shim]),
      // The override is executable but answers no version (broken); the shim works.
      versions: { [shim]: "0.144.1" },
    });
    const result = await discoverCodex(deps, { explicitBin: stale });
    expect(result.chosen).toEqual({ path: shim, version: "0.144.1" });
  });

  it("normalizes a RELATIVE explicit override to an absolute chosen.path", async () => {
    // codex-exec spawns from a fresh scratch cwd, so a relative "codex" must be
    // anchored to an absolute path at resolution time — else the "executable port"
    // isn't reliably executable. resolve() mirrors what discoverCodex does.
    const abs = resolve("codex");
    const { deps } = recordingDeps({
      home: HOME,
      platform: process.platform,
      executables: new Set([abs]),
      versions: { [abs]: "0.150.0" },
    });
    const result = await discoverCodex(deps, { explicitBin: "codex" });
    expect(result.chosen).not.toBeNull();
    expect(isAbsolute(result.chosen?.path ?? "")).toBe(true);
    expect(result.chosen?.path).toBe(abs);
  });

  it("normalizes a RELATIVE PATH entry to an absolute chosen.path", async () => {
    // A PATH entry of "." must not yield a relative "codex" candidate.
    const abs = resolve("codex");
    const { deps } = recordingDeps({
      loginShellPath: ".",
      envPath: ".",
      home: HOME,
      platform: process.platform,
      dirContents: { ".": ["codex"] },
      executables: new Set([abs]),
      versions: { [abs]: "0.144.1" },
    });
    const result = await discoverCodex(deps);
    expect(result.chosen).not.toBeNull();
    expect(isAbsolute(result.chosen?.path ?? "")).toBe(true);
    expect(result.chosen?.path).toBe(abs);
  });

  it("the real probe returns null (never throws) on a missing binary", async () => {
    // Exercises the codex-safe probe: stdin closed + a non-existent path resolves
    // to null rather than hanging or throwing. (A broken install would ENOENT the
    // same way; the closed stdin is what turns a would-be hang into this exit.)
    const deps = defaultCodexDiscoveryDeps();
    await expect(deps.probeVersion("/no/such/path/codex")).resolves.toBeNull();
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

describe("discoverOmp (#26 — Bun-aware health)", () => {
  const HOME = "/home/rai";
  const BUN_BIN = "/home/rai/.bun/bin";
  const omp = "/home/rai/.bun/bin/omp";
  const bun = "/home/rai/.bun/bin/bun";

  it("resolves ~/.bun/bin/omp from curated locations when the login-shell PATH omits it", async () => {
    // The login-shell PATH (launchd's minimal env) does NOT contain ~/.bun/bin, and
    // `omp` is often a shell alias. Discovery must still find it via the curated
    // location, resolved by readdir + X_OK, proven by execution — with a runnable bun.
    const { deps } = recordingDeps({
      loginShellPath: "/usr/bin:/bin",
      envPath: "/usr/bin:/bin",
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp", "bun"], "/usr/bin": ["ls"] },
      executables: new Set([omp, bun]),
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [omp]: "17.1.3" },
    });
    const result = await discoverOmp(deps);
    expect(result.chosen).toEqual({
      path: omp,
      version: "17.1.3",
      runtimePath: bun,
    });
    expect(result.health).toEqual({ state: "ready", version: "17.1.3" });
  });

  it("reports 'found omp but not Bun' — reason names Bun, omp path still reported, never not-found", async () => {
    const { deps } = recordingDeps({
      loginShellPath: BUN_BIN,
      envPath: BUN_BIN,
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp"] }, // no bun
      executables: new Set([omp]),
      runtimeVersions: { [omp]: "17.1.3" },
    });
    const result = await discoverOmp(deps);
    // No session against the slot…
    expect(result.chosen).toBeNull();
    // …but the resolved omp path is STILL reported, and the reason NAMES Bun.
    expect(result.candidates.map((c) => c.path)).toContain(omp);
    expect(result.health.state).toBe("unavailable");
    if (result.health.state === "unavailable") {
      expect(result.health.reason).not.toBe("not-found");
      expect(result.health.detail).toMatch(/bun/i);
      expect(result.health.detail).toContain(omp);
    }
  });

  it("reports unavailable/not-found when no omp exists anywhere", async () => {
    const { deps } = recordingDeps({ home: HOME, dirContents: {} });
    const result = await discoverOmp(deps);
    expect(result.chosen).toBeNull();
    expect(result.health).toEqual({
      state: "unavailable",
      reason: "not-found",
      detail: expect.any(String),
    });
  });

  it("honours a probing RENNET_OMP_BIN override (bun present → ready)", async () => {
    const override = "/custom/omp";
    const { deps } = recordingDeps({
      loginShellPath: BUN_BIN,
      envPath: BUN_BIN,
      home: HOME,
      dirContents: { [BUN_BIN]: ["bun"] },
      executables: new Set([override, bun]),
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [override]: "17.2.0" },
    });
    const result = await discoverOmp(deps, { explicitBin: override });
    expect(result.chosen).toEqual({
      path: override,
      version: "17.2.0",
      runtimePath: bun,
    });
    expect(result.health).toEqual({ state: "ready", version: "17.2.0" });
  });

  it("falls through a stale RENNET_OMP_BIN override to normal discovery", async () => {
    const stale = "/stale/omp";
    const { deps } = recordingDeps({
      loginShellPath: BUN_BIN,
      envPath: BUN_BIN,
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp", "bun"] },
      executables: new Set([omp, bun]), // stale is NOT executable
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [omp]: "17.1.3" },
    });
    const result = await discoverOmp(deps, { explicitBin: stale });
    expect(result.chosen).toEqual({
      path: omp,
      version: "17.1.3",
      runtimePath: bun,
    });
  });

  it("never requests a credential path while discovering omp + bun", async () => {
    const { deps, accessed } = recordingDeps({
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp", "bun"] },
      executables: new Set([omp, bun]),
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [omp]: "17.1.3" },
    });
    await discoverOmp(deps);
    expect(accessed.length).toBeGreaterThan(0);
    expect(accessed.filter(isCredentialPath)).toEqual([]);
  });

  it("resolves Bun first, enforces its floor, and probes omp through that exact runtime", async () => {
    const calls: string[] = [];
    const { deps } = recordingDeps({
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp", "bun"] },
      executables: new Set([omp, bun]),
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [omp]: "17.1.3" },
    });
    const wrapped: DiscoveryDeps = {
      ...deps,
      probeVersion: async (path) => {
        calls.push(`direct:${path}`);
        return deps.probeVersion(path);
      },
      probeVersionWithRuntime: async (runtimePath, scriptPath) => {
        calls.push(`runtime:${runtimePath}:${scriptPath}`);
        return deps.probeVersionWithRuntime?.(runtimePath, scriptPath) ?? null;
      },
    };
    const result = await discoverOmp(wrapped);
    expect(result.chosen?.runtimePath).toBe(bun);
    expect(calls.indexOf(`direct:${bun}`)).toBeLessThan(calls.indexOf(`runtime:${bun}:${omp}`));
    expect(calls).not.toContain(`direct:${omp}`);

    const belowFloor = recordingDeps({
      home: HOME,
      dirContents: { [BUN_BIN]: ["omp", "bun"] },
      executables: new Set([omp, bun]),
      versions: { [bun]: "1.3.13" },
      runtimeVersions: { [omp]: "17.1.3" },
    });
    const rejected = await discoverOmp(belowFloor.deps);
    expect(rejected.chosen).toBeNull();
    expect(rejected.health).toEqual(
      expect.objectContaining({
        state: "unavailable",
        detail: expect.stringMatching(/1\.3\.14/),
      }),
    );
  });

  it("prefers a real omp install over an equally versioned asdf shim", async () => {
    const shims = `${HOME}/.asdf/shims`;
    const shim = `${shims}/omp`;
    const { deps } = recordingDeps({
      loginShellPath: shims,
      envPath: shims,
      home: HOME,
      dirContents: { [shims]: ["omp"], [BUN_BIN]: ["omp", "bun"] },
      executables: new Set([shim, omp, bun]),
      versions: { [bun]: "1.3.14" },
      runtimeVersions: { [shim]: "17.1.3", [omp]: "17.1.3" },
    });
    const result = await discoverOmp(deps);
    expect(result.chosen?.path).toBe(omp);
  });
});
