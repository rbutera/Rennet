import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The WSL Claude launcher (add-windows-support, design decision 2 + spike 1.2).
 *
 * The Claude Agent SDK spawns exactly one executable (`pathToClaudeCodeExecutable`)
 * and talks stdio. A Windows app cannot spawn a distro-resident ELF binary directly,
 * so for a WSL-locus project we point the SDK at a generated `.cmd` launcher that
 * execs the distro's own `claude` inside the distro. The spike proved the transport
 * end to end: `wsl.exe … -e <claude>` streams clean UTF-8/LF stream-json and the
 * prompt pipes through stdin byte-exact.
 *
 * The launcher BAKES the distro repo cwd (`--cd <distroCwd>`), it does NOT read
 * `%CD%`. Verified on lancelot (2026-08-16): the SDK sets the child cwd to the repo's
 * `\\wsl.localhost\…` UNC path, and **cmd.exe cannot hold a UNC cwd** — it warns
 * "UNC paths are not supported. Defaulting to Windows directory", so `%CD%` would be
 * `C:\Windows`, not the repo. Baking the cwd sidesteps that entirely; the launcher is
 * therefore per-(distro, repo). `-e` (not `--`) is mandatory so argv passes
 * byte-verbatim (the login-shell form mangles backslashes and `$`). `.cmd %*`
 * forwards the SDK's own flags — simple space-free flags (the prompt rides stdin, a
 * clean binary pipe), so `%*` is safe. The verification ran a real streamed turn to a
 * complete stream-json result envelope (auth-error only, the distro being logged out).
 */

/** A distro name must be a bare identifier — never shell metacharacters in a `.cmd`. */
const SAFE_DISTRO = /^[A-Za-z0-9._-]+$/;

export interface WslClaudeLauncherInput {
  /** The WSL distro to exec into (validated: `[A-Za-z0-9._-]+`). */
  readonly distro: string;
  /** The distro-native absolute path to `claude` (e.g. `/home/rai/.local/bin/claude`). */
  readonly distroClaudePath: string;
  /**
   * The distro-native repo cwd the turn runs in (e.g. `/home/rai/repo`). Baked into
   * `--cd` because cmd.exe cannot inherit a UNC cwd from the SDK. Optional: when
   * absent the distro default (login home) is used — a working turn but not rooted at
   * the repo, so callers that have the repo path SHOULD pass it.
   */
  readonly distroCwd?: string;
}

/**
 * Build the `.cmd` launcher script (pure, so it is unit-tested without touching the
 * filesystem or Windows). Throws on an unsafe distro name or a claude path/cwd
 * carrying a newline/quote — a trust-boundary check, since the values land verbatim
 * in a script.
 */
export function wslClaudeLauncherScript(input: WslClaudeLauncherInput): string {
  if (!SAFE_DISTRO.test(input.distro)) {
    throw new Error(`unsafe WSL distro name for launcher: ${JSON.stringify(input.distro)}`);
  }
  for (const value of [input.distroClaudePath, input.distroCwd ?? ""]) {
    if (/["\r\n]/.test(value)) {
      throw new Error(`unsafe path for launcher: ${JSON.stringify(value)}`);
    }
  }
  const wsl = "%SystemRoot%\\System32\\wsl.exe";
  const cd = input.distroCwd === undefined ? "" : ` --cd "${input.distroCwd}"`;
  return [
    "@echo off",
    // Run the distro's own claude in the baked repo cwd, forwarding the SDK's flags.
    // No `%CD%`: cmd.exe cannot hold the SDK's UNC cwd (lancelot 2026-08-16).
    `"${wsl}" -d ${input.distro}${cd} -e ${input.distroClaudePath} %*`,
    "",
  ].join("\r\n");
}

/**
 * Write the launcher to `dir` (default: a dir under the OS temp — a REAL Windows path,
 * never a UNC path, so cmd.exe can execute it) and return its absolute path, ready to
 * hand to the SDK as `pathToClaudeCodeExecutable`. The filename encodes the distro and
 * a hash of the cwd so per-repo launchers do not collide.
 */
export function generateWslClaudeLauncher(
  input: WslClaudeLauncherInput,
  dir: string = join(tmpdir(), "rennet-wsl-launchers"),
): string {
  const script = wslClaudeLauncherScript(input);
  mkdirSync(dir, { recursive: true });
  const suffix = input.distroCwd === undefined ? "" : `-${cwdTag(input.distroCwd)}`;
  const path = join(dir, `claude-${input.distro}${suffix}.cmd`);
  writeFileSync(path, script);
  return path;
}

/** A short filesystem-safe tag for a distro cwd, so per-repo launchers don't collide. */
function cwdTag(distroCwd: string): string {
  return createHash("sha256").update(distroCwd).digest("hex").slice(0, 12);
}
