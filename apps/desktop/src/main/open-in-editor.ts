import { delimiter, join, resolve, sep, win32 as win32Path } from "node:path";
import { type Locus, toDistroPath } from "@rennet/core";

/**
 * Whether `target` is contained within `root` (equal to it or beneath it). Pure and
 * separator-injectable so the Windows drive-letter case is testable off-Windows
 * (add-windows-support). On Windows the comparison is case-insensitive — `C:\Dev` and
 * `c:\dev` are the same directory — and the separator is `\`; a bare `startsWith`
 * without the trailing separator would let `/rootX` masquerade as inside `/root`.
 */
export function isWithinRoot(
  root: string,
  target: string,
  options: { sep?: string; caseInsensitive?: boolean } = {},
): boolean {
  const separator = options.sep ?? sep;
  const fold = options.caseInsensitive
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  const foldedRoot = fold(root);
  const foldedTarget = fold(target);
  if (foldedTarget === foldedRoot) return true;
  const prefix = foldedRoot.endsWith(separator) ? foldedRoot : foldedRoot + separator;
  return foldedTarget.startsWith(prefix);
}

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

// The `.cmd`/`.exe` launcher for each editor family, relative to a Windows install
// root (add-windows-support). VS Code-family ships a `bin\<cli>.cmd`; Sublime a bare
// `subl.exe`. `code` gets an extra Program Files (system-install) location.
const WINDOWS_EDITOR_BUNDLES: Readonly<Record<string, readonly string[]>> = {
  code: ["Microsoft VS Code\\bin\\code.cmd"],
  cursor: ["cursor\\resources\\app\\bin\\cursor.cmd"],
  "code-insiders": ["Microsoft VS Code Insiders\\bin\\code-insiders.cmd"],
  codium: ["VSCodium\\bin\\codium.cmd"],
  subl: ["Sublime Text\\subl.exe"],
};

/** Absolute Windows install-location candidates for an editor CLI (`.cmd`/`.exe`). */
function windowsEditorLocations(cli: string, env: NodeJS.ProcessEnv): string[] {
  const bundles = WINDOWS_EDITOR_BUNDLES[cli];
  if (!bundles) return [];
  const join = win32Path.join;
  // Per-user `%LOCALAPPDATA%\Programs\…` (VS Code/Cursor default) + system installs.
  const roots: string[] = [];
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "Programs"));
  if (env.ProgramFiles) roots.push(env.ProgramFiles);
  if (env["ProgramFiles(x86)"]) roots.push(env["ProgramFiles(x86)"] as string);
  return roots.flatMap((root) => bundles.map((bundle) => join(root, bundle)));
}

export interface EditorResolutionInput {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly inheritedPath: string;
  readonly loginShellPath: string;
  /** The process env, for Windows install-location roots. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
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
    const candidates: string[] = [];
    for (const directory of uniqueDirectories) {
      candidates.push(join(directory, cli));
      // On Windows the CLI on PATH is a `.cmd`/`.exe` shim, not a bare name.
      if (input.platform === "win32") {
        candidates.push(join(directory, `${cli}.cmd`), join(directory, `${cli}.exe`));
      }
    }
    const bundle = MACOS_EDITOR_BUNDLES[cli];
    if (input.platform === "darwin" && bundle !== undefined) {
      candidates.push(join("/Applications", bundle), join(input.home, "Applications", bundle));
    }
    if (input.platform === "win32") {
      candidates.push(...windowsEditorLocations(cli, input.env ?? process.env));
    }
    for (const candidate of candidates) {
      if ((await isExecutable(candidate)) && !resolved.includes(candidate))
        resolved.push(candidate);
    }
  }
  return resolved;
}

/**
 * The launch argv for a line-targeted open (add-windows-support). Host: `-g abs:line`
 * (unchanged). WSL locus: `--remote wsl+<distro> -g <distro-path>:line`, so a
 * WSL-remote-capable editor (VS Code family) opens INSIDE the distro on the
 * distro-native path — where `path:line` still lands. `absPath` is translated to its
 * distro form; a path that cannot translate falls back to the host `-g` shape.
 */
export function editorOpenArgs(absPath: string, line: number, locus: Locus): string[] {
  if (locus.kind === "wsl") {
    const distroPath = toDistroPath(absPath, locus.distro);
    if (distroPath !== null) {
      return ["--remote", `wsl+${locus.distro}`, "-g", `${distroPath}:${line}`];
    }
  }
  return ["-g", `${absPath}:${line}`];
}

export async function launchResolvedEditor(
  executables: readonly string[],
  absPath: string,
  line: number,
  spawn: (executable: string, args: string[]) => Promise<void>,
  locus: Locus = { kind: "host" },
): Promise<boolean> {
  const args = editorOpenArgs(absPath, line, locus);
  for (const executable of executables) {
    try {
      await spawn(executable, args);
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
  // Case-insensitive on Windows so a drive-letter/case mismatch (`C:\` vs `c:\`)
  // does not read as an escape (add-windows-support).
  if (!isWithinRoot(root, target, { caseInsensitive: process.platform === "win32" })) {
    return null;
  }
  return target;
}

export interface OpenInEditorEffects {
  /** Try to open `absPath` at `line` in an editor; resolves true iff one succeeded. */
  launchAtLine(absPath: string, line: number, locus?: Locus): Promise<boolean>;
  /** Fallback: open the file via the OS (no line). Resolves true on success. */
  openPath(absPath: string): Promise<boolean>;
}

export interface EditorLaunchEffectsInput {
  resolveExecutables(): Promise<string[]>;
  spawn(executable: string, args: string[]): Promise<void>;
  openPath(absPath: string): Promise<boolean>;
}

export interface EditorLaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: false;
}

/** Preserve a resolved editor shim and its arguments as a no-shell execution spec. */
export function editorLaunchSpec(executable: string, args: readonly string[]): EditorLaunchSpec {
  return { file: executable, args: [...args], shell: false };
}

export function createEditorLaunchEffects(input: EditorLaunchEffectsInput): OpenInEditorEffects {
  let executables: Promise<string[]> | null = null;
  return {
    async launchAtLine(absPath, line, locus) {
      executables ??= input.resolveExecutables();
      return launchResolvedEditor(await executables, absPath, line, input.spawn, locus);
    },
    openPath: input.openPath,
  };
}

export interface OpenInEditorInput {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly line?: number;
  /** The project's execution locus (add-windows-support); WSL opens via its remote. */
  readonly locus?: Locus;
}

/**
 * Open a review file, honouring the line when one is given: try a line-targeted
 * editor launch first, and fall back to an OS open (no line) when no editor took it
 * or no line was requested. Refuses a path that escapes the review root. For a WSL
 * locus the launch targets the editor's WSL remote (editorOpenArgs).
 */
export async function performOpenInEditor(
  effects: OpenInEditorEffects,
  input: OpenInEditorInput,
): Promise<{ ok: boolean }> {
  const target = resolveWithinRoot(input.repositoryRoot, input.path);
  if (target === null) return { ok: false };
  if (input.line !== undefined && (await effects.launchAtLine(target, input.line, input.locus))) {
    return { ok: true };
  }
  return { ok: await effects.openPath(target) };
}
