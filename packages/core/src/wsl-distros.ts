/**
 * Enumerate installed WSL distros (`wsl.exe -l -q`), for the source-aware project
 * picker's WSL branch. Mirrors `wsl-node.ts`'s shape: pure parsing plus an
 * injected `run`, so the actual spawn (and its `win32`-only gate) is the only
 * platform-specific bit and the desktop supplies the real `execFile`.
 */

import { shellLines } from "./wsl-shell";

/**
 * Parse `wsl.exe -l -q` output into bare distro names (one per line, no `*`
 * default marker — that's only in the non-`-q` listing). Reuses `shellLines`'
 * split/trim/drop-blank, which is exactly this contract.
 *
 * ponytail: `wsl.exe -l -q` writes UTF-16LE. This function only splits/trims —
 * the CALLER (the desktop `run`) must decode the child-process output as
 * `utf16le` before it reaches here. Ceiling: a distro name containing a NUL
 * would be stripped by that decode; distro names can't contain one.
 */
export function parseWslDistroList(raw: string): string[] {
  return shellLines(raw);
}

/**
 * List installed WSL distros, or `[]` on non-Windows, no WSL, or any error —
 * never throws. `run` executes `wsl.exe -l -q` and resolves its (already
 * utf16le-decoded) stdout; the desktop injects the real `execFile`, tests inject
 * a fake.
 */
export async function listWslDistros(
  run: (cmd: string, args: string[]) => Promise<string>,
): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    return parseWslDistroList(await run("wsl.exe", ["-l", "-q"]));
  } catch {
    return [];
  }
}
