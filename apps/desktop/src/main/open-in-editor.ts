import { delimiter, join, resolve, sep } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// review.openInEditor — open a review file, honouring the LINE (Rai, wireframes #8).
//
// The inspector shows each site as `path:line`, so "open in editor" must land on the
// line, not just the file. There is no portable single way to do that, so we try a
// short list of common editor CLIs with their line-jump flag (`<cli> -g file:line`,
// the VS Code / Cursor / Sublime family), and fall back to an OS-level open (which
// cannot target a line) only when no editor took it or no line was requested. The
// effects are injected so the resolution + fallback ladder is unit-tested without
// spawning anything or touching Electron.
// ─────────────────────────────────────────────────────────────────────────────

/** The editor CLIs tried, in order, for a line-targeted open (`<cli> -g <file>:<line>`). */
export const EDITOR_CLIS: readonly string[] = ["code", "cursor", "code-insiders", "codium", "subl"];

const MACOS_EDITOR_BUNDLES: Readonly<Record<string, string>> = {
  code: "Visual Studio Code.app/Contents/Resources/app/bin/code",
  cursor: "Cursor.app/Contents/Resources/app/bin/cursor",
  "code-insiders": "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
  codium: "VSCodium.app/Contents/Resources/app/bin/codium",
  subl: "Sublime Text.app/Contents/SharedSupport/bin/subl",
};

export interface EditorResolutionInput {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly inheritedPath: string;
  readonly loginShellPath: string;
}

export async function resolveEditorExecutables(
  input: EditorResolutionInput,
  isExecutable: (candidate: string) => Promise<boolean>,
): Promise<string[]> {
  const pathDirectories = [
    ...input.inheritedPath.split(delimiter),
    ...input.loginShellPath.split(delimiter),
  ]
    .filter((directory) => directory.length > 0)
    .map((directory) => resolve(directory));
  const uniqueDirectories = [...new Set(pathDirectories)];
  const resolved: string[] = [];

  for (const cli of EDITOR_CLIS) {
    const candidates = uniqueDirectories.map((directory) => join(directory, cli));
    const bundle = MACOS_EDITOR_BUNDLES[cli];
    if (input.platform === "darwin" && bundle !== undefined) {
      candidates.push(join("/Applications", bundle), join(input.home, "Applications", bundle));
    }
    for (const candidate of candidates) {
      if ((await isExecutable(candidate)) && !resolved.includes(candidate))
        resolved.push(candidate);
    }
  }
  return resolved;
}

export async function launchResolvedEditor(
  executables: readonly string[],
  absPath: string,
  line: number,
  spawn: (executable: string, args: string[]) => Promise<void>,
): Promise<boolean> {
  for (const executable of executables) {
    try {
      await spawn(executable, ["-g", `${absPath}:${line}`]);
      return true;
    } catch {
      // Try the next resolved editor.
    }
  }
  return false;
}

/**
 * Resolve a repo-relative path within the review root, or null when it escapes the
 * root. The path comes from the symbolic index, but this is guarded regardless — an
 * open that escaped the review root would be an arbitrary-file open.
 */
export function resolveWithinRoot(repositoryRoot: string, relPath: string): string | null {
  const root = resolve(repositoryRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export interface OpenInEditorEffects {
  /** Try to open `absPath` at `line` in an editor; resolves true iff one succeeded. */
  launchAtLine(absPath: string, line: number): Promise<boolean>;
  /** Fallback: open the file via the OS (no line). Resolves true on success. */
  openPath(absPath: string): Promise<boolean>;
}

export interface OpenInEditorInput {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly line?: number;
}

/**
 * Open a review file, honouring the line when one is given: try a line-targeted
 * editor launch first, and fall back to an OS open (no line) when no editor took it
 * or no line was requested. Refuses a path that escapes the review root.
 */
export async function performOpenInEditor(
  effects: OpenInEditorEffects,
  input: OpenInEditorInput,
): Promise<{ ok: boolean }> {
  const target = resolveWithinRoot(input.repositoryRoot, input.path);
  if (target === null) return { ok: false };
  if (input.line !== undefined && (await effects.launchAtLine(target, input.line))) {
    return { ok: true };
  }
  return { ok: await effects.openPath(target) };
}
