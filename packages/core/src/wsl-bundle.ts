/**
 * Deliver the daemon bundle INTO a WSL distro's native fs and name the paths it
 * lives at. The daemon must run from native fs (`~/.rennet/server/<version>/…`),
 * never over 9P — running the bundle across `\\wsl.localhost\…` would reintroduce
 * exactly the tax the WSL-daemon change exists to delete (design.md Decision 1).
 *
 * NODE-FREE (mirrors `wsl-node.ts`/`locus.ts`): pure path/argv builders plus an
 * injected `run`, so `core` stays node-free and every branch is unit-testable
 * off-box. The daemon is spawned `wsl.exe -e <node> <bundle>` with NO shell, so
 * every path here is distro-native ABSOLUTE — `~` would never expand.
 */

import { type LocusCommand, locusCommand } from "./locus";
import { lastAbsolutePathLine } from "./wsl-shell";

/** Drop a trailing slash so `/` or `/home/u/` don't yield a doubled separator. */
function trimTrailingSlash(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/** Absolute distro-native path the versioned daemon bundle is delivered to. */
export function wslServerDir(distroHome: string, version: string): string {
  return `${trimTrailingSlash(distroHome)}/.rennet/server/${version}`;
}

/** The distro-native path of the daemon ENTRY (`index.cjs`) inside the delivered dir. */
export function wslServerBundlePath(distroHome: string, version: string): string {
  return `${wslServerDir(distroHome, version)}/index.cjs`;
}

/** The final path segment of a host bundle path (Windows `\\` or POSIX `/`), e.g. `index.cjs`. */
function hostBundleBasename(hostBundlePath: string): string {
  return (
    hostBundlePath
      .split(/[/\\]/)
      .filter((seg) => seg.length > 0)
      .pop() ?? "index.cjs"
  );
}

/** Absolute distro-native data dir the WSL daemon owns (daemon.json, log, sqlite). */
export function wslDaemonDataDir(distroHome: string): string {
  return `${trimTrailingSlash(distroHome)}/.local/share/rennet`;
}

/** Probe the distro's `$HOME`: `sh -lc 'printf %s "$HOME"'`, byte-verbatim argv. */
export function buildWslHomeProbe(distro: string): LocusCommand {
  return locusCommand({ kind: "wsl", distro }, "sh", ["-lc", 'printf %s "$HOME"']);
}

/** The absolute `$HOME` from the probe, or `null` when the value is not absolute. */
export function parseWslHome(raw: string): string | null {
  return lastAbsolutePathLine(raw);
}

/** Result the injected runner returns: the daemon needs stdout + the exit code. */
export interface WslRunResult {
  readonly stdout: string;
  readonly code: number;
}

/** What `ensureWslBundleDelivered` needs to place the versioned bundle. */
export interface WslBundleDelivery {
  readonly distro: string;
  /** Distro-native `$HOME` (from `resolveWslNode`'s sibling home probe). */
  readonly distroHome: string;
  readonly version: string;
  /** The host bundle path (a Windows path); translated with `wslpath` before copy. */
  readonly hostBundlePath: string;
}

/** Delivery could not place the versioned bundle — the caller must not spawn. */
export class WslBundleDeliveryError extends Error {
  override readonly name = "WslBundleDeliveryError";
}

interface RequiredWslBundleFile {
  readonly path: string;
  readonly testFlag: "-f" | "-x";
}

const WSL_BUNDLE_COMPLETION_MARKER = ".rennet-bundle-complete";

function requiredWslBundleFiles(targetDir: string, entry: string): RequiredWslBundleFile[] {
  return [
    { path: entry, testFlag: "-f" },
    {
      path: `${targetDir}/native/linux-x64/rennet-rooted-landing.node`,
      testFlag: "-f",
    },
    {
      path: `${targetDir}/native/linux-x64/rennet-exclusive-move`,
      testFlag: "-x",
    },
  ];
}

async function firstMissingRequiredFile(
  distro: string,
  files: readonly RequiredWslBundleFile[],
  run: (command: LocusCommand) => Promise<WslRunResult>,
): Promise<string | null> {
  const locus = { kind: "wsl", distro } as const;
  for (const file of files) {
    const probe = await run(locusCommand(locus, "test", [file.testFlag, file.path]));
    if (probe.code === 0) continue;
    if (probe.code === 1) return file.path;
    throw new WslBundleDeliveryError(
      `could not probe required bundle file ${file.path} in "${distro}" (test exited ${probe.code})`,
    );
  }
  return null;
}

async function removeCompletionMarker(
  distro: string,
  markerPath: string,
  run: (command: LocusCommand) => Promise<WslRunResult>,
): Promise<void> {
  const locus = { kind: "wsl", distro } as const;
  const removed = await run(locusCommand(locus, "rm", ["-f", markerPath]));
  if (removed.code !== 0) {
    throw new WslBundleDeliveryError(
      `could not remove bundle completion marker ${markerPath} in "${distro}" (rm exited ${removed.code})`,
    );
  }
}

async function publishCompletionMarker(
  distro: string,
  markerPath: string,
  run: (command: LocusCommand) => Promise<WslRunResult>,
): Promise<void> {
  const locus = { kind: "wsl", distro } as const;
  const created = await run(locusCommand(locus, "touch", [markerPath]));
  if (created.code !== 0) {
    await removeCompletionMarker(distro, markerPath, run);
    throw new WslBundleDeliveryError(
      `could not create bundle completion marker ${markerPath} in "${distro}" (touch exited ${created.code})`,
    );
  }

  const verified = await run(locusCommand(locus, "test", ["-f", markerPath]));
  if (verified.code === 0) return;

  await removeCompletionMarker(distro, markerPath, run);
  throw new WslBundleDeliveryError(
    verified.code === 1
      ? `bundle completion marker ${markerPath} is missing after creation in "${distro}"`
      : `could not verify bundle completion marker ${markerPath} in "${distro}" (test exited ${verified.code})`,
  );
}

/**
 * Ensure the versioned bundle exists in the distro's native fs, returning its
 * absolute distro-native path. Copy-once-per-complete-version (design.md Decision 1):
 * probe the entry, Linux x64 rooted addon, executable move helper, and a marker
 * created only after their post-copy checks — complete means no-op. Any missing
 * member removes the marker before `mkdir -p`, path translation, and the whole-dir
 * copy, so an interrupted overlay retries on the next call. Only copies into native
 * fs; it never runs the bundle over 9P. `run` executes a `LocusCommand` (desktop
 * injects an `execa`-backed runner; tests inject a fake).
 *
 * FAILS LOUDLY at this boundary: every command's exit code is checked and the
 * translated source must be an absolute path, so a failed copy is a clear
 * `WslBundleDeliveryError` here — never a "delivered" report that makes a later
 * spawn run a nonexistent bundle.
 */
export async function ensureWslBundleDelivered(
  delivery: WslBundleDelivery,
  run: (command: LocusCommand) => Promise<WslRunResult>,
): Promise<string> {
  const { distro, distroHome, version, hostBundlePath } = delivery;
  if (!distroHome.startsWith("/")) {
    throw new WslBundleDeliveryError(
      `distroHome must be an absolute distro path, got "${distroHome}"`,
    );
  }
  const locus = { kind: "wsl", distro } as const;
  const targetDir = wslServerDir(distroHome, version);
  const entry = `${targetDir}/${hostBundleBasename(hostBundlePath)}`;
  const requiredPayloadFiles = requiredWslBundleFiles(targetDir, entry);
  const exclusiveMovePath = `${targetDir}/native/linux-x64/rennet-exclusive-move`;
  const completionMarkerPath = `${targetDir}/${WSL_BUNDLE_COMPLETION_MARKER}`;
  const completionMarkerFile: RequiredWslBundleFile = {
    path: completionMarkerPath,
    testFlag: "-f",
  };
  const requiredCompletedBundleFiles = [...requiredPayloadFiles, completionMarkerFile];

  const missingBeforeCopy = await firstMissingRequiredFile(
    distro,
    requiredCompletedBundleFiles,
    run,
  );
  if (missingBeforeCopy === null) return entry;

  await removeCompletionMarker(distro, completionMarkerPath, run);
  const made = await run(locusCommand(locus, "mkdir", ["-p", targetDir]));
  if (made.code !== 0) {
    throw new WslBundleDeliveryError(
      `could not create ${targetDir} in "${distro}" (exit ${made.code})`,
    );
  }
  const translated = await run(locusCommand(locus, "wslpath", ["-u", hostBundlePath]));
  const source = lastAbsolutePathLine(translated.stdout);
  if (translated.code !== 0 || source === null) {
    throw new WslBundleDeliveryError(
      `could not translate host bundle path "${hostBundlePath}" for "${distro}" (exit ${translated.code})`,
    );
  }
  // Deliver the WHOLE server directory, not just the entry file. The bundle is
  // code-split (`index.cjs` plus its `rolldown-runtime-*.cjs` and lazy `sdk-*.cjs`
  // chunks), so a single-file copy makes the daemon crash at startup with a
  // missing-module error. `<dir>/.` copies the directory's contents (no shell glob).
  const sourceDir = source.slice(0, source.lastIndexOf("/"));
  const copied = await run(locusCommand(locus, "cp", ["-r", `${sourceDir}/.`, targetDir]));
  if (copied.code !== 0) {
    throw new WslBundleDeliveryError(
      `bundle copy failed in "${distro}" (cp exited ${copied.code})`,
    );
  }

  const madeExecutable = await run(locusCommand(locus, "chmod", ["0755", exclusiveMovePath]));
  if (madeExecutable.code !== 0) {
    throw new WslBundleDeliveryError(
      `could not make copied Linux helper executable at ${exclusiveMovePath} in "${distro}" (chmod exited ${madeExecutable.code})`,
    );
  }

  const missingAfterCopy = await firstMissingRequiredFile(distro, requiredPayloadFiles, run);
  if (missingAfterCopy !== null) {
    throw new WslBundleDeliveryError(
      `required bundle file ${missingAfterCopy} is missing or unusable after copy in "${distro}"`,
    );
  }
  await publishCompletionMarker(distro, completionMarkerPath, run);
  return entry;
}
