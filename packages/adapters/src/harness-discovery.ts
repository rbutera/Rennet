import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix as posixPath, win32 as win32Path } from "node:path";
import {
  type HarnessHealth,
  HOST_LOCUS,
  type Locus,
  locusCommand,
  toWindowsView,
} from "@rennet/core";
import { execa } from "execa";

/**
 * Join path segments for a platform, NOT the host's (add-windows-support). A Windows
 * host resolving a WSL distro's dirs must build POSIX paths (`/home/u/.local/bin`),
 * so the distro/POSIX branch uses `path.posix.join`; the Windows branch uses win32.
 */
function joinFor(platform: NodeJS.Platform | undefined): (...parts: string[]) => string {
  return platform === "win32" ? win32Path.join : posixPath.join;
}

/** `path.resolve` for a platform, NOT the host's: mirrors joinFor so a host-locus
 * candidate is normalized with the LOCUS platform's resolver. Native `resolve` would
 * corrupt a POSIX path on a win32 host (and vice versa); in production the host deps
 * carry `platform: process.platform`, so this is byte-identical to native `resolve`. */
function resolveFor(platform: NodeJS.Platform | undefined): (...parts: string[]) => string {
  return platform === "win32" ? win32Path.resolve : posixPath.resolve;
}

/**
 * Harness discovery (slice 1, Claude Code only).
 *
 * The finding that motivates every line here: a GUI app launched from Finder
 * inherits launchd's minimal PATH, which finds neither `claude` nor `codex` on
 * this machine, and in an interactive shell both are shell FUNCTIONS, so
 * `which`/`command -v` return a function body, not a path. So we never ask a
 * shell to resolve a binary. We harvest PATH, union it with known locations,
 * resolve candidates ourselves with readdir + X_OK, and prove each one is real
 * by EXECUTING it. Every effect is injected so the whole thing is testable and
 * so a test can prove we never touch a credential file.
 */

export interface DiscoveryDeps {
  /** The user's login-shell PATH, harvested once. `null` when the harvest fails. */
  loginShellPath(): Promise<string | null>;
  /** `process.env.PATH` at app start. */
  readonly envPath: string;
  /** The user's home directory. */
  readonly home: string;
  /** Directory listing; returns `[]` on any error (missing dir, permission). */
  listDir(directory: string): Promise<readonly string[]>;
  /** X_OK check on a resolved path. */
  isExecutable(path: string): Promise<boolean>;
  /** Execute `<path> --version` and return the parsed version, or `null`. */
  probeVersion(path: string): Promise<string | null>;
  /** Execute a script through an already-proven runtime and parse its version. */
  probeVersionWithRuntime?(runtimePath: string, scriptPath: string): Promise<string | null>;
  /**
   * The platform the binaries live on (add-windows-support). `win32` ⇒ `;`-delimited
   * PATH, PATHEXT shim matching (`claude.cmd`/`.exe`/…), Windows curated dirs. Absent
   * ⇒ POSIX (macOS/Linux, and the Linux INSIDE a WSL distro). This is the platform of
   * the LOCUS, not necessarily of the host running Rennet.
   */
  readonly platform?: NodeJS.Platform;
  /** PATHEXT for the candidate locus, not necessarily the host process. */
  readonly pathExt?: string;
  /** The locus these candidates belong to (add-windows-support). Absent ⇒ host. */
  readonly locus?: Locus;
}

export interface DiscoveredCandidate {
  readonly path: string;
  readonly version: string | null;
  /** True when the path came from a curated known location rather than a PATH entry. */
  readonly fromKnownLocation: boolean;
  /** The locus this candidate lives on (add-windows-support). */
  readonly locus: Locus;
  /** The runtime a runtime-hosted candidate was probed and must be launched through
   *  (a codex JS launcher under an asdf node install needs its sibling `node`). */
  readonly runtimePath?: string;
}

/** The PATH delimiter for a platform: `;` on Windows, `:` elsewhere. */
function delimiterFor(platform: NodeJS.Platform | undefined): string {
  return platform === "win32" ? ";" : ":";
}

/**
 * Resolve which filename in a directory listing IS the binary, honouring Windows
 * PATHEXT from the candidate locus. POSIX resolves only the bare name.
 */
function resolveBinaryFilename(
  entries: readonly string[],
  base: string,
  platform: NodeJS.Platform | undefined,
  pathExt: string | undefined,
): string | null {
  if (platform === "win32") {
    const byLowerCase = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
    for (const extension of (pathExt ?? "").split(";").filter(Boolean)) {
      const candidate = `${base}${extension}`.toLowerCase();
      const actual = byLowerCase.get(candidate);
      if (actual !== undefined) return actual;
    }
    return byLowerCase.get(base.toLowerCase()) ?? null;
  }
  return entries.includes(base) ? base : null;
}

export interface DiscoveryResult {
  readonly candidates: readonly DiscoveredCandidate[];
  readonly chosen: {
    readonly path: string;
    readonly version: string;
    /** Exact runtime used to probe and execute a runtime-hosted harness. */
    readonly runtimePath?: string;
  } | null;
  readonly health: HarnessHealth;
}

export interface VersionRange {
  readonly min: string;
  readonly maxTested: string;
}

const CLAUDE_BINARY = "claude";

/** Curated Windows per-user install locations for `base` (`claude`/`codex`). */
function windowsKnownDirectories(base: string): readonly string[] {
  const join = win32Path.join;
  const env = process.env;
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  const userProfile = env.USERPROFILE ?? env.HOME ?? "";
  const dirs: string[] = [];
  // npm global (`%APPDATA%\npm\claude.cmd`), the most common shim location.
  if (appData) dirs.push(join(appData, "npm"));
  if (localAppData) {
    dirs.push(join(localAppData, "Programs", base)); // per-user "Programs" installs
    dirs.push(join(localAppData, base, "bin"));
  }
  if (userProfile) {
    dirs.push(join(userProfile, ".local", "bin"));
    dirs.push(join(userProfile, ".bun", "bin"));
    dirs.push(join(userProfile, "scoop", "shims")); // scoop per-user
    dirs.push(join(userProfile, ".volta", "bin"));
  }
  return dirs;
}

/**
 * Curated locations, checked even when they are not on PATH (the launchd case, and
 * the GUI-inherited-PATH case). POSIX by default; on Windows the per-user install
 * dirs; inside a WSL distro the POSIX set plus linuxbrew (add-windows-support).
 */
function knownDirectories(home: string, platform: NodeJS.Platform | undefined): readonly string[] {
  if (platform === "win32") {
    return [...windowsKnownDirectories(CLAUDE_BINARY)];
  }
  const join = posixPath.join;
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".volta", "bin"),
  ];
}

function splitPath(value: string, delimiter: string): readonly string[] {
  return value.split(delimiter).filter((entry) => entry.length > 0);
}

/** Numeric-tuple version compare. Returns <0, 0, or >0. Non-numeric segments sort as 0. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? "0", 10) || 0;
    const rightValue = Number.parseInt(rightParts[index] ?? "0", 10) || 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function healthFor(version: string, range: VersionRange): HarnessHealth {
  if (compareVersions(version, range.min) < 0) {
    return { state: "degraded", version, reason: "below-floor" };
  }
  if (compareVersions(version, range.maxTested) > 0) {
    return { state: "degraded", version, reason: "above-tested" };
  }
  return { state: "ready", version };
}

export async function discoverClaude(
  deps: DiscoveryDeps,
  range: VersionRange,
): Promise<DiscoveryResult> {
  const locus = deps.locus ?? HOST_LOCUS;
  const delimiter = delimiterFor(deps.platform);
  const join = joinFor(deps.platform);
  const known = knownDirectories(deps.home, deps.platform);
  const knownSet = new Set(known);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of [
    ...splitPath(harvested ?? "", delimiter),
    ...splitPath(deps.envPath, delimiter),
    ...known,
  ]) {
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }

  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, CLAUDE_BINARY, deps.platform, deps.pathExt);
    if (filename === null) continue;
    const path = join(directory, filename);
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await deps.probeVersion(path);
    candidates.push({
      path,
      version,
      fromKnownLocation: knownSet.has(directory),
      locus,
    });
  }

  // Rank: a known-location hit with a version first, then highest version, then
  // PATH order (already the insertion order of `candidates`).
  const withVersion = candidates.filter(
    (candidate): candidate is DiscoveredCandidate & { version: string } =>
      candidate.version !== null,
  );
  const ranked = [...withVersion].sort((left, right) => {
    if (left.fromKnownLocation !== right.fromKnownLocation) return left.fromKnownLocation ? -1 : 1;
    return compareVersions(right.version, left.version);
  });
  const best = ranked[0];

  if (!best) {
    // Name the distro in the reason so a WSL-locus miss reads "…inside the Ubuntu
    // distro", never a host binary silently chosen (harness-discovery spec).
    const where = locus.kind === "wsl" ? ` inside the ${locus.distro} distro` : "";
    return {
      candidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: candidates.length > 0 ? "spawn-failed" : "not-found",
        detail:
          candidates.length > 0
            ? `A claude binary was found${where} but did not report a version.`
            : `No claude binary found on PATH or in any known location${where}.`,
      },
    };
  }

  return {
    candidates,
    chosen: { path: best.path, version: best.version },
    health: healthFor(best.version, range),
  };
}

/**
 * The default effects: real login shell, filesystem, and process execution.
 *
 * On Windows there is NO POSIX login shell to harvest (windows-native-runtime spec):
 * `loginShellPath` returns `null` and discovery proceeds from the process env plus
 * the curated Windows locations, and `probeVersion` runs the shim directly (execa
 * launches a `.cmd`/`.bat` through the Windows launcher). PATH is `;`-delimited and
 * candidate matching honours PATHEXT — all driven by `platform`.
 */
export function defaultDiscoveryDeps(): DiscoveryDeps {
  const platform = process.platform;
  return {
    platform,
    pathExt: process.env.PATHEXT ?? "",
    locus: HOST_LOCUS,
    async loginShellPath(): Promise<string | null> {
      if (platform === "win32") return null; // no POSIX shell on Windows
      const shell = process.env.SHELL ?? "/bin/zsh";
      try {
        const result = await execa(shell, ["-ilc", 'printf %s "$PATH"'], {
          reject: false,
          shell: false,
        });
        return result.exitCode === 0 ? result.stdout : null;
      } catch {
        return null;
      }
    },
    envPath: process.env.PATH ?? "",
    home: homedir(),
    async listDir(directory: string): Promise<readonly string[]> {
      try {
        return await readdir(directory);
      } catch {
        return [];
      }
    },
    async isExecutable(path: string): Promise<boolean> {
      // On Windows, X_OK is not meaningful for a `.cmd`/`.exe`; presence + a readable
      // check is the signal, and the version probe is the real proof (as on POSIX).
      try {
        await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async probeVersion(path: string): Promise<string | null> {
      try {
        const result = await execa(path, ["--version"], {
          reject: false,
          shell: false,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
    async probeVersionWithRuntime(runtimePath: string, scriptPath: string): Promise<string | null> {
      try {
        const result = await execa(runtimePath, [scriptPath, "--version"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: 10_000,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
  };
}

// ── WSL-locus discovery (add-windows-support) ──────────────────────────────────
//
// Discovery INSIDE a distro: the exact POSIX algorithm above, executed across the
// wsl.exe boundary. PATH is harvested from the distro's login shell, directory
// listings read the distro filesystem through its `\\wsl.localhost\<distro>\…` UNC
// view (spike: UNC reads are clean), and executability/version probes run the
// candidate INSIDE the distro via `wsl.exe … -e`. Every candidate is stamped with
// the WSL locus, so a host binary can never satisfy a WSL-locus project: the
// composition picks these deps for a WSL project and the host deps for a host one.

/** Run a fixed-literal command in the distro and return trimmed stdout, or null. */
async function wslProbe(distro: string, argv: readonly string[]): Promise<string | null> {
  const command = locusCommand({ kind: "wsl", distro }, argv[0] ?? "", argv.slice(1));
  try {
    const result = await execa(command.file, [...command.args], {
      reject: false,
      shell: false,
      stdin: "ignore",
    });
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Discovery effects for a WSL distro. `home`/`loginShellPath` are harvested from the
 * distro's own login shell (a fixed-literal `bash -lc` payload — the one sanctioned
 * `-e bash -lc` use, since the payload is not user data). Listings read the distro
 * via UNC; executability and version probes run inside the distro. Async because the
 * distro home must be probed before the deps can be built.
 */
export async function wslDiscoveryDeps(distro: string): Promise<DiscoveryDeps> {
  const locus: Locus = { kind: "wsl", distro };
  const home = (await wslProbe(distro, ["bash", "-lc", 'printf %s "$HOME"'])) ?? "/root";
  return {
    platform: "linux",
    locus,
    home,
    envPath: "", // the distro's PATH is harvested via loginShellPath, not the host env
    loginShellPath: () => wslProbe(distro, ["bash", "-lc", 'printf %s "$PATH"']),
    async listDir(directory: string): Promise<readonly string[]> {
      try {
        return await readdir(toWindowsView(directory, distro));
      } catch {
        return [];
      }
    },
    async isExecutable(path: string): Promise<boolean> {
      const command = locusCommand(locus, "test", ["-x", path]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
        });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    async probeVersion(path: string): Promise<string | null> {
      const command = locusCommand(locus, path, ["--version"]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
    async probeVersionWithRuntime(runtimePath: string, scriptPath: string): Promise<string | null> {
      const command = locusCommand(locus, runtimePath, [scriptPath, "--version"]);
      try {
        const result = await execa(command.file, [...command.args], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: 10_000,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
  };
}

// ── Codex discovery (bead workspace-6qp15) ─────────────────────────────────────
//
// `codex` cannot be resolved by a plain PATH lookup. On this class of machine the
// `codex` on PATH is the asdf SHIM, which defers to asdf's per-directory version
// resolution and, under version drift, launches a broken/missing install — one
// real install on this machine 400s with `ENOENT` on its vendored native binary.
// The DEPENDABLE binary is the absolute install path
// `~/.asdf/installs/nodejs/<ver>/bin/codex`. So, exactly like `discoverClaude`, we
// never trust bare `codex`: we harvest candidate directories (login-shell PATH +
// env PATH + curated locations INCLUDING every asdf node install's `bin`), resolve
// each `codex`, prove it by EXECUTING `codex --version`, and prefer a real install
// over the shim. Resolving to an ABSOLUTE path is what stops the Codex seat from
// silently failing to launch — dual-model degrading to single-Claude at the
// PROCESS layer (a different layer than the #212 schema fix).

const CODEX_BINARY = "codex";

/**
 * A codex-safe `--version` probe: stdin CLOSED and a hard timeout, both
 * load-bearing. A broken asdf install (missing vendored native binary) HANGS on
 * `codex --version` when stdin is an open pipe (observed: a multi-minute wedge);
 * closing stdin turns that hang into a fast non-zero exit. Without this, one
 * broken install poisons discovery for the whole app. The rest of the effects are
 * the shared `defaultDiscoveryDeps` (login-shell PATH harvest, listing, X_OK).
 */
export function defaultCodexDiscoveryDeps(): DiscoveryDeps {
  const base = defaultDiscoveryDeps();
  return {
    ...base,
    async probeVersion(path: string): Promise<string | null> {
      try {
        const result = await execa(path, ["--version"], {
          reject: false,
          shell: false,
          stdin: "ignore",
          timeout: 10_000,
        });
        if (result.exitCode !== 0) return null;
        const match = result.stdout.match(/\d+\.\d+\.\d+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Curated codex locations, checked even when they are not on PATH. Every asdf node
 * install's `bin` is included (listed dynamically) so a real absolute binary is a
 * candidate even though normally only the shim is on PATH. The shims directory is
 * included too — but DEMOTED at ranking time, so a real install always wins.
 */
async function codexKnownDirectories(
  home: string,
  listDir: (directory: string) => Promise<readonly string[]>,
  platform: NodeJS.Platform | undefined,
): Promise<{ readonly dirs: readonly string[]; readonly shimsDir: string }> {
  if (platform === "win32") {
    // Windows codex installs are npm/scoop shims, not asdf; no asdf-install scan.
    return { dirs: windowsKnownDirectories(CODEX_BINARY), shimsDir: "" };
  }
  const join = posixPath.join;
  const asdfInstallsRoot = join(home, ".asdf", "installs", "nodejs");
  const versions = await listDir(asdfInstallsRoot);
  const asdfInstallBins = versions.map((version) => join(asdfInstallsRoot, version, "bin"));
  const shimsDir = join(home, ".asdf", "shims");
  return {
    dirs: [
      ...asdfInstallBins,
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      join(home, ".bun", "bin"),
      join(home, ".volta", "bin"),
      shimsDir,
    ],
    shimsDir,
  };
}

/** True when `binaryPath` is the codex under the asdf shims directory — the
 *  unreliable indirection we prefer to skip whenever a real install is present. */
function isAsdfShim(binaryPath: string, shimsDir: string, binary: string): boolean {
  return shimsDir.length > 0 && binaryPath === posixPath.join(shimsDir, binary);
}

/** Options for {@link discoverCodex}. */
export interface DiscoverCodexOptions {
  /**
   * An operator-configured absolute `codex` path (the composition root passes
   * `RENNET_CODEX_BIN`). Honoured only if it actually answers `--version`; a
   * stale/broken override falls through to normal discovery rather than bricking
   * the app.
   */
  readonly explicitBin?: string;
}

/**
 * Resolve an ABSOLUTE `codex` binary. Resolution order: (1) an explicit override
 * that probes to a version, else (2) the union of login-shell PATH + env PATH +
 * curated codex locations, each resolved, X_OK-checked, and PROVEN by executing
 * `codex --version`, ranked to prefer a real install over the asdf shim and then
 * the highest version. Returns `chosen: null` with an `unavailable` health when
 * nothing resolvable is found, so the caller fails LOUD (no Codex seat) rather
 * than launching a bad `codex` that would silently degrade dual-model to single.
 */
/**
 * The sibling `node` a codex candidate must run through, or null. A codex installed
 * under an asdf node install (`~/.asdf/installs/nodejs/<ver>/bin/codex`) is a JS
 * launcher whose `#!/usr/bin/env node` finds no `node` on a non-interactive PATH
 * (asdf's shim init lives in the user's interactive shell rc, not `.profile`). Its
 * runnable node is the sibling in the SAME install bin dir. Mirrors the omp/Bun
 * precedent — probe and launch a runtime-hosted harness through its exact runtime.
 */
function pairedNodeRuntime(
  codexPath: string,
  platform: NodeJS.Platform | undefined,
): string | null {
  const p = platform === "win32" ? win32Path : posixPath;
  const dir = p.dirname(codexPath);
  if (!/[\\/]\.asdf[\\/]installs[\\/]nodejs[\\/][^\\/]+[\\/]bin$/.test(dir)) return null;
  return p.join(dir, "node");
}

/**
 * Probe a codex path, PLAIN first so a normal install (node on PATH) is byte-identical;
 * only on a null plain probe does it fall back to the paired sibling `node`. Returns the
 * version and, when the paired runtime was needed, the runtime to launch through.
 */
async function probeCodexCandidate(
  deps: DiscoveryDeps,
  path: string,
): Promise<{ readonly version: string | null; readonly runtimePath?: string }> {
  const version = await deps.probeVersion(path);
  if (version !== null) return { version };
  const node = pairedNodeRuntime(path, deps.platform);
  if (node !== null && (await deps.isExecutable(node))) {
    const paired = await deps.probeVersionWithRuntime?.(node, path);
    if (paired != null) return { version: paired, runtimePath: node };
  }
  return { version: null };
}

export async function discoverCodex(
  deps: DiscoveryDeps,
  options: DiscoverCodexOptions = {},
): Promise<DiscoveryResult> {
  // (1) Explicit override wins, but only if it truly runs.
  if (options.explicitBin !== undefined && options.explicitBin.length > 0) {
    // Normalize to ABSOLUTE: codex-exec spawns from a fresh scratch cwd, so a
    // relative override (e.g. "codex") must be anchored against the app's cwd
    // HERE, at resolution time, not left to resolve against the wrong dir later.
    const path = resolveFor(deps.platform)(options.explicitBin);
    if (await deps.isExecutable(path)) {
      const { version, runtimePath } = await probeCodexCandidate(deps, path);
      if (version !== null) {
        const runtime = runtimePath === undefined ? {} : { runtimePath };
        return {
          candidates: [{ path, version, fromKnownLocation: true, locus: HOST_LOCUS, ...runtime }],
          chosen: { path, version, ...runtime },
          health: { state: "ready", version },
        };
      }
    }
  }

  const locus = deps.locus ?? HOST_LOCUS;
  const delimiter = delimiterFor(deps.platform);
  const join = joinFor(deps.platform);
  const { dirs: known, shimsDir } = await codexKnownDirectories(
    deps.home,
    deps.listDir,
    deps.platform,
  );
  const knownSet = new Set(known);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of [
    ...splitPath(harvested ?? "", delimiter),
    ...splitPath(deps.envPath, delimiter),
    ...known,
  ]) {
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }

  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, CODEX_BINARY, deps.platform, deps.pathExt);
    if (filename === null) continue;
    // Host: normalize to ABSOLUTE so a relative PATH entry (e.g. ".") never yields a
    // relative `chosen.path` that codex-exec would resolve against its scratch cwd.
    // WSL: keep the distro-native POSIX path (resolve would corrupt it on a Windows host).
    const joined = join(directory, filename);
    const path = locus.kind === "host" ? resolveFor(deps.platform)(joined) : joined;
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const { version, runtimePath } = await probeCodexCandidate(deps, path);
    candidates.push({
      path,
      version,
      fromKnownLocation: knownSet.has(directory),
      locus,
      ...(runtimePath === undefined ? {} : { runtimePath }),
    });
  }

  const withVersion = candidates.filter(
    (candidate): candidate is DiscoveredCandidate & { version: string } =>
      candidate.version !== null,
  );
  const ranked = [...withVersion].sort((left, right) => {
    // A real install beats the asdf shim, whatever their reported versions.
    const leftShim = isAsdfShim(left.path, shimsDir, CODEX_BINARY);
    const rightShim = isAsdfShim(right.path, shimsDir, CODEX_BINARY);
    if (leftShim !== rightShim) return leftShim ? 1 : -1;
    // Then a curated known location beats a bare PATH hit.
    if (left.fromKnownLocation !== right.fromKnownLocation) return left.fromKnownLocation ? -1 : 1;
    // Then the highest version.
    return compareVersions(right.version, left.version);
  });
  const best = ranked[0];

  if (!best) {
    const where = locus.kind === "wsl" ? ` inside the ${locus.distro} distro` : "";
    return {
      candidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: candidates.length > 0 ? "spawn-failed" : "not-found",
        detail:
          candidates.length > 0
            ? `A codex binary was found${where} but did not report a version.`
            : `No codex binary found on PATH or in any known location${where}.`,
      },
    };
  }

  return {
    candidates,
    chosen: {
      path: best.path,
      version: best.version,
      ...(best.runtimePath === undefined ? {} : { runtimePath: best.runtimePath }),
    },
    health: { state: "ready", version: best.version },
  };
}

// ── omp discovery with Bun-aware health (#26) ──────────────────────────────────
//
// omp (`@oh-my-pi/pi-coding-agent`, bin `omp` — NEVER the abandoned npm namesake
// `oh-my-pi`) is a Bun-first harness: its bin is a TypeScript entry point executed by
// Bun (`engines.bun >= 1.3.14`). A discovered `omp` with no runnable `bun` fails at
// first spawn with a confusing exec error, so discovery proves BOTH the `omp` binary
// and a runnable `bun`, and folds a missing runtime into the slot's health with a
// reason that NAMES Bun — the same product move as "found your Claude config but not
// the binary" (harness-discovery spec: a runtime-dependent harness names its missing
// runtime). The resolution machinery is the shared one (login-shell PATH harvest ∪
// env PATH ∪ curated dirs with `~/.bun/bin` FIRST, X_OK, execute-to-prove), because
// PATH lies (the launchd/GUI case) exactly as it does for claude and codex.

const OMP_BINARY = "omp";
const BUN_BINARY = "bun";

/** Curated omp locations, `~/.bun/bin` first (the omp + bun install home). */
function ompKnownDirectories(
  home: string,
  platform: NodeJS.Platform | undefined,
): { readonly dirs: readonly string[]; readonly shimsDir: string } {
  if (platform === "win32") {
    return { dirs: windowsKnownDirectories(OMP_BINARY), shimsDir: "" };
  }
  const join = posixPath.join;
  const shimsDir = join(home, ".asdf", "shims");
  return {
    dirs: [
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      shimsDir,
      join(home, ".volta", "bin"),
    ],
    shimsDir,
  };
}

/** The harvested directory union (login-shell PATH ∪ env PATH ∪ curated), deduped. */
async function harvestedDirectories(
  deps: DiscoveryDeps,
  known: readonly string[],
): Promise<readonly string[]> {
  const delimiter = delimiterFor(deps.platform);
  const harvested = await deps.loginShellPath();
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of [
    ...splitPath(harvested ?? "", delimiter),
    ...splitPath(deps.envPath, delimiter),
    ...known,
  ]) {
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

/** Resolve every candidate for `binary` across `directories`, using the supplied probe. */
async function resolveCandidates(
  deps: DiscoveryDeps,
  binary: string,
  directories: readonly string[],
  known: ReadonlySet<string>,
  probe: (path: string) => Promise<string | null> = (path) => deps.probeVersion(path),
): Promise<DiscoveredCandidate[]> {
  const locus = deps.locus ?? HOST_LOCUS;
  const join = joinFor(deps.platform);
  const candidates: DiscoveredCandidate[] = [];
  const resolved = new Set<string>();
  for (const directory of directories) {
    const entries = await deps.listDir(directory);
    const filename = resolveBinaryFilename(entries, binary, deps.platform, deps.pathExt);
    if (filename === null) continue;
    const joined = join(directory, filename);
    const path = locus.kind === "host" ? resolveFor(deps.platform)(joined) : joined;
    if (resolved.has(path)) continue;
    if (!(await deps.isExecutable(path))) continue;
    resolved.add(path);
    const version = await probe(path);
    candidates.push({
      path,
      version,
      fromKnownLocation: known.has(directory),
      locus,
    });
  }
  return candidates;
}

/** Options for {@link discoverOmp}. */
export interface DiscoverOmpOptions {
  /**
   * An operator-configured `omp` path (the composition root passes `RENNET_OMP_BIN`).
   * Honoured only if it actually answers `--version`; a stale/broken override falls
   * through to normal discovery rather than bricking the slot.
   */
  readonly explicitBin?: string;
}

/** The default omp discovery effects: the codex-hardened probe (stdin closed + timeout),
 *  since omp is a Bun script whose probe could wedge on an open stdin pipe. */
export function defaultOmpDiscoveryDeps(): DiscoveryDeps {
  return defaultCodexDiscoveryDeps();
}

/**
 * Resolve an `omp` binary AND prove a runnable `bun` runtime. Resolution order for omp:
 * (1) an explicit `RENNET_OMP_BIN` override that probes to a version, else (2) the union
 * of login-shell PATH + env PATH + curated omp locations (`~/.bun/bin` first), each
 * X_OK-checked. Bun is resolved and floor-checked first; only then is each omp script
 * proven by executing `<exact bun path> <omp path> --version`.
 *
 * Health mapping (the acceptance criterion):
 * - omp probes, bun probes → `ready` (version from omp).
 * - omp probes, bun missing → `unavailable`, reason `handshake-failed`, detail NAMES Bun,
 *   and the resolved omp path is STILL reported in `candidates` ("found omp but not Bun",
 *   never "no omp found"). `chosen` is null so no session can be created against the slot.
 * - omp missing → `unavailable`, reason `not-found`.
 */
export async function discoverOmp(
  deps: DiscoveryDeps,
  options: DiscoverOmpOptions = {},
): Promise<DiscoveryResult> {
  const { dirs: known, shimsDir } = ompKnownDirectories(deps.home, deps.platform);
  const knownSet = new Set(known);
  const directories = await harvestedDirectories(deps, known);

  const discoveredOmp = await resolveCandidates(deps, OMP_BINARY, directories, knownSet, () =>
    Promise.resolve(null),
  );
  let explicitOmp: DiscoveredCandidate | null = null;
  if (options.explicitBin !== undefined && options.explicitBin.length > 0) {
    const locus = deps.locus ?? HOST_LOCUS;
    const path =
      locus.kind === "host" ? resolveFor(deps.platform)(options.explicitBin) : options.explicitBin;
    if (await deps.isExecutable(path)) {
      explicitOmp = { path, version: null, fromKnownLocation: true, locus };
    }
  }
  const ompPaths = [
    ...(explicitOmp === null ? [] : [explicitOmp]),
    ...discoveredOmp.filter((candidate) => candidate.path !== explicitOmp?.path),
  ];
  if (ompPaths.length === 0) {
    return {
      candidates: [],
      chosen: null,
      health: {
        state: "unavailable",
        reason: "not-found",
        detail: "No omp binary found on PATH or in any known location.",
      },
    };
  }

  // Prove Bun FIRST. An omp script cannot be version-probed honestly before its runtime.
  const bunCandidates = await resolveCandidates(deps, BUN_BINARY, directories, knownSet);
  const runnableBun = bunCandidates
    .filter(
      (candidate): candidate is DiscoveredCandidate & { version: string } =>
        candidate.version !== null && compareVersions(candidate.version, "1.3.14") >= 0,
    )
    .sort((left, right) => {
      const leftShim = isAsdfShim(left.path, shimsDir, BUN_BINARY);
      const rightShim = isAsdfShim(right.path, shimsDir, BUN_BINARY);
      if (leftShim !== rightShim) return leftShim ? 1 : -1;
      if (left.fromKnownLocation !== right.fromKnownLocation) {
        return left.fromKnownLocation ? -1 : 1;
      }
      return compareVersions(right.version, left.version);
    })[0];
  if (!runnableBun) {
    const foundVersions = bunCandidates
      .map((candidate) => candidate.version)
      .filter((version): version is string => version !== null);
    const runtimeDetail =
      foundVersions.length > 0
        ? `found Bun ${foundVersions.join(", ")}, below the required 1.3.14 floor`
        : "no runnable Bun runtime";
    return {
      candidates: ompPaths,
      chosen: null,
      health: {
        state: "unavailable",
        reason: "handshake-failed",
        detail: `Found omp at ${ompPaths[0]?.path ?? "unknown"} but ${runtimeDetail}; omp needs Bun >= 1.3.14 to execute.`,
      },
    };
  }

  const probeWithBun = (path: string): Promise<string | null> =>
    deps.probeVersionWithRuntime?.(runnableBun.path, path) ?? Promise.resolve(null);
  const ompCandidates = await Promise.all(
    ompPaths.map(async (candidate) => ({
      ...candidate,
      version: await probeWithBun(candidate.path),
    })),
  );
  const validExplicit =
    explicitOmp === null
      ? undefined
      : ompCandidates.find(
          (candidate): candidate is DiscoveredCandidate & { version: string } =>
            candidate.path === explicitOmp.path && candidate.version !== null,
        );
  const bestOmp =
    validExplicit ??
    ompCandidates
      .filter(
        (candidate): candidate is DiscoveredCandidate & { version: string } =>
          candidate.version !== null,
      )
      .sort((left, right) => {
        const leftShim = isAsdfShim(left.path, shimsDir, OMP_BINARY);
        const rightShim = isAsdfShim(right.path, shimsDir, OMP_BINARY);
        if (leftShim !== rightShim) return leftShim ? 1 : -1;
        if (left.fromKnownLocation !== right.fromKnownLocation) {
          return left.fromKnownLocation ? -1 : 1;
        }
        return compareVersions(right.version, left.version);
      })[0];

  if (!bestOmp) {
    return {
      candidates: ompCandidates,
      chosen: null,
      health: {
        state: "unavailable",
        reason: "spawn-failed",
        detail: `Found omp at ${ompPaths[0]?.path ?? "unknown"}, but it did not report a version when executed through ${runnableBun.path}.`,
      },
    };
  }

  return {
    candidates: ompCandidates,
    chosen: {
      path: bestOmp.path,
      version: bestOmp.version,
      runtimePath: runnableBun.path,
    },
    health: { state: "ready", version: bestOmp.version },
  };
}
