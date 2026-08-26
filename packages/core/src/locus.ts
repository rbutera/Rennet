/**
 * Execution locus — the per-project seam that lets Rennet run as a Windows (or
 * macOS/Linux) app while a project's repo, git, and harness binaries live either
 * on the host OS or inside a named WSL distro (add-windows-support change).
 *
 * NODE-FREE (mirrors escape-path.ts): pure string transforms only, so `core`
 * stays node-free and the whole thing is trivially unit-testable from any CI.
 *
 * The load-bearing spike finding (design.md §"Argv marshalling"): a WSL process
 * spawn MUST use `wsl.exe -d <distro> [--cd <dir>] -e <program> <argv…>` — the
 * `-e`/`--exec` form passes argv byte-verbatim. The `--`/shell form routes argv
 * through the distro's login shell, which $-expands, strips backslashes, and
 * merges quoted args (command-injection-grade). So every repo-facing spawn goes
 * through `locusCommand`, and it always emits the `-e` form.
 */

import type { Locus } from "@rennet/protocol";

export type { Locus };

/** The host locus singleton — today's behaviour on macOS/Linux/native-Windows. */
export const HOST_LOCUS: Locus = { kind: "host" };

/** The Windows launcher that spawns into a distro. Resolved on PATH on Windows. */
export const WSL_EXE = "wsl.exe";

/**
 * A no-shell spawn descriptor: the program (or absolute path) to run and its argv,
 * plus the cwd to run it in. `execa(file, args, { cwd })` consumes it directly.
 */
export interface LocusCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

// `\\wsl.localhost\<distro>\rest...` or the legacy `\\wsl$\<distro>\rest...` alias.
// Case-insensitive host part; the distro name is the first UNC segment.
const WSL_UNC_RE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/i;

export class LocusDistroMismatchError extends Error {
  override readonly name = "LocusDistroMismatchError";

  constructor(
    readonly pathDistro: string,
    readonly locusDistro: string,
  ) {
    super(
      `WSL path names distro "${pathDistro}" but the execution locus names distro "${locusDistro}".`,
    );
  }
}

/**
 * A WSL-locus project whose repo path cannot be expressed distro-natively (a `C:\`
 * host path or a relative path pinned to a WSL locus). The turn must fail plainly
 * naming both the path and the distro — never fall back to the untranslatable host
 * path (which would run codex in the wrong place) and never silently run host-side.
 */
export class LocusPathUntranslatableError extends Error {
  override readonly name = "LocusPathUntranslatableError";

  constructor(
    readonly path: string,
    readonly distro: string,
  ) {
    super(
      `Cannot run in WSL distro "${distro}": the path "${path}" is not translatable to a ` +
        `distro-native path (it is a Windows or relative path, not a \\\\wsl.localhost\\${distro}\\… path). ` +
        `Pin the project to the host, or open it from its \\\\wsl.localhost path.`,
    );
  }
}

/**
 * Detect a project's locus from its root path. A project living under a
 * `\\wsl$`/`\\wsl.localhost` UNC root is a WSL-locus project on the named distro;
 * everything else is the host. This is auto-detection only — the value is a plain
 * editable setting, never a confirmation gate (Rule Zero, wsl-execution-mode spec).
 */
export function detectLocus(projectPath: string): Locus {
  const match = WSL_UNC_RE.exec(projectPath);
  return match?.[1] ? { kind: "wsl", distro: match[1] } : HOST_LOCUS;
}

/**
 * Translate a path to its distro-native form (`/home/u/repo/…`).
 * - A `\\wsl.localhost\<distro>\home\u\repo` (or `\\wsl$`) UNC path → `/home/u/repo`.
 * - An already distro-native (`/`-leading) path → returned unchanged.
 * - Anything else (a `C:\…` host path, a relative path) → `null` (not translatable).
 * Spaces and non-ASCII are literal characters and pass through untouched.
 */
export function toDistroPath(path: string, expectedDistro?: string): string | null {
  const match = WSL_UNC_RE.exec(path);
  if (match) {
    const pathDistro = match[1];
    if (
      expectedDistro !== undefined &&
      pathDistro !== undefined &&
      pathDistro.toLowerCase() !== expectedDistro.toLowerCase()
    ) {
      throw new LocusDistroMismatchError(pathDistro, expectedDistro);
    }
    const rest = match[2] ?? "";
    return `/${rest.replace(/\\/g, "/")}`;
  }
  if (path.startsWith("/")) return path;
  return null;
}

/**
 * Translate a distro-native absolute path (`/home/u/repo/…`) to the Windows UNC
 * view (`\\wsl.localhost\<distro>\home\u\repo\…`), used only where the Windows-side
 * app must read/watch/open a distro file directly.
 */
export function toWindowsView(distroPath: string, distro: string): string {
  const rest = distroPath.replace(/^\//, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}\\${rest}`;
}

/**
 * Rewrite a repo-facing spawn for a project's locus.
 * - host: run the program directly in `cwd` (today's behaviour, unchanged).
 * - wsl: `wsl.exe -d <distro> [--cd <distro-cwd>] -e <program> <argv…>`. The cwd is
 *   translated to its distro-native form; a cwd that is already distro-native is
 *   used as-is. `-e` guarantees byte-verbatim argv (spike finding).
 */
export function locusCommand(
  locus: Locus,
  program: string,
  args: readonly string[],
  cwd?: string,
): LocusCommand {
  if (locus.kind === "host") {
    return cwd === undefined ? { file: program, args } : { file: program, args, cwd };
  }
  const wslArgs: string[] = ["-d", locus.distro];
  if (cwd !== undefined) {
    wslArgs.push("--cd", toDistroPath(cwd, locus.distro) ?? cwd);
  }
  wslArgs.push("-e", program, ...args);
  return { file: WSL_EXE, args: wslArgs };
}
