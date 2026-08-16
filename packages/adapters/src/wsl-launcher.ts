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
 * The launcher is cwd-agnostic (so ONE launcher serves every repo on a distro): the
 * SDK sets the child cwd to the review's repo path per turn, and the launcher
 * translates that Windows/UNC cwd to its distro-native form with `wslpath -u` before
 * running `claude --cd <distro-cwd>`. `-e` (not `--`) is mandatory on every wsl.exe
 * call so argv passes byte-verbatim (the login-shell form mangles backslashes and
 * `$`). The only Windows-side hazard left is `.cmd %*` forwarding of the SDK's own
 * flags — those are simple space-free flags (the prompt rides stdin), so `%*` is
 * safe here; richer arg quoting is the documented lancelot check.
 */

/** A distro name must be a bare identifier — never shell metacharacters in a `.cmd`. */
const SAFE_DISTRO = /^[A-Za-z0-9._-]+$/;

export interface WslClaudeLauncherInput {
  /** The WSL distro to exec into (validated: `[A-Za-z0-9._-]+`). */
  readonly distro: string;
  /** The distro-native absolute path to `claude` (e.g. `/home/rai/.local/bin/claude`). */
  readonly distroClaudePath: string;
}

/**
 * Build the `.cmd` launcher script (pure, so it is unit-tested without touching the
 * filesystem or Windows). Throws on an unsafe distro name or a claude path carrying a
 * newline/quote — a trust-boundary check, since the values land verbatim in a script.
 */
export function wslClaudeLauncherScript(input: WslClaudeLauncherInput): string {
  if (!SAFE_DISTRO.test(input.distro)) {
    throw new Error(`unsafe WSL distro name for launcher: ${JSON.stringify(input.distro)}`);
  }
  if (/["\r\n]/.test(input.distroClaudePath)) {
    throw new Error(`unsafe claude path for launcher: ${JSON.stringify(input.distroClaudePath)}`);
  }
  const wsl = "%SystemRoot%\\System32\\wsl.exe";
  return [
    "@echo off",
    "setlocal",
    // Translate the SDK-set Windows/UNC cwd to its distro path (byte-verbatim via -e).
    `for /f "usebackq delims=" %%d in (\`"${wsl}" -d ${input.distro} -e wslpath -u "%CD%"\`) do set "RENNET_WSL_CD=%%d"`,
    // Run the distro's own claude in that distro cwd, forwarding the SDK's flags.
    `"${wsl}" -d ${input.distro} --cd "%RENNET_WSL_CD%" -e ${input.distroClaudePath} %*`,
    "",
  ].join("\r\n");
}

/**
 * Write the launcher to `dir` (default: a per-distro dir under the OS temp) and return
 * its absolute path, ready to hand to the SDK as `pathToClaudeCodeExecutable`.
 */
export function generateWslClaudeLauncher(
  input: WslClaudeLauncherInput,
  dir: string = join(tmpdir(), "rennet-wsl-launchers"),
): string {
  const script = wslClaudeLauncherScript(input);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `claude-${input.distro}.cmd`);
  writeFileSync(path, script);
  return path;
}
