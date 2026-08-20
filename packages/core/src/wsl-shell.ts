/**
 * Reading a value out of a WSL shell's captured output. An interactive/login
 * shell prepends prompt/cursor ANSI escapes and may interleave warning lines, so
 * a path has to be lifted out of noisy multi-line text.
 *
 * NODE-FREE (mirrors `locus.ts`): pure string transforms only. Shared by
 * `wsl-node.ts` and `wsl-bundle.ts` so the control-stripping is defined — and
 * correct — in ONE place (a prior copy stripped `\n` BEFORE splitting on it,
 * collapsing multi-line output into a single invalid line).
 */

// ANSI CSI escapes + bare control chars, but NOT `\n`/`\r`: line breaks must
// survive so `\n`-splitting still works. `\t` and other C0/C1 controls go.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control output is the point.
const ANSI_AND_CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g; // eslint-disable-line no-control-regex

/** Strip ANSI escapes and control chars, PRESERVING `\n`/`\r` line breaks. */
export function stripShellControl(raw: string): string {
  return raw.replace(ANSI_AND_CONTROL, "");
}

/** The cleaned, trimmed, non-empty lines of shell output (order preserved). */
export function shellLines(raw: string): string[] {
  return stripShellControl(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The LAST line that looks like an absolute path (`/…`), or null — skips warning noise. */
export function lastAbsolutePathLine(raw: string): string | null {
  const lines = shellLines(raw);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("/")) return line;
  }
  return null;
}
