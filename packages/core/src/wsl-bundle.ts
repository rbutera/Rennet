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
export function wslServerBundlePath(distroHome: string, version: string): string {
  return `${trimTrailingSlash(distroHome)}/.rennet/server/${version}/rennet.cjs`;
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

/**
 * Ensure the versioned bundle exists in the distro's native fs, returning its
 * absolute distro-native path. Copy-once-per-version (design.md Decision 1):
 * `test -f` the target — present ⇒ no-op; absent ⇒ `mkdir -p` its dir, translate
 * the host path with `wslpath -u`, then `cp` it in. Only copies into native fs;
 * it never runs the bundle over 9P. `run` executes a `LocusCommand` (desktop
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
  const target = wslServerBundlePath(distroHome, version);

  // `test -f`: exit 0 ⇒ present, 1 ⇒ absent, anything else ⇒ the probe itself failed.
  const present = await run(locusCommand(locus, "test", ["-f", target]));
  if (present.code === 0) return target; // already delivered this version — skip the copy.
  if (present.code !== 1) {
    throw new WslBundleDeliveryError(
      `could not probe the bundle path in "${distro}" (test exited ${present.code})`,
    );
  }

  const targetDir = target.slice(0, target.lastIndexOf("/"));
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
  const copied = await run(locusCommand(locus, "cp", [source, target]));
  if (copied.code !== 0) {
    throw new WslBundleDeliveryError(
      `bundle copy failed in "${distro}" (cp exited ${copied.code})`,
    );
  }
  return target;
}
