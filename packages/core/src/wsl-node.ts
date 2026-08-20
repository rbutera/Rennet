/**
 * Resolve the Node binary inside a WSL distro so the shell can spawn the daemon
 * THERE (native inotify, native git, native fs — none of the 9P pain that a
 * Windows daemon reaching across `\\wsl.localhost\…` suffers). This is the one
 * load-bearing gap the WSL-daemon spike (lancelot, 2026-08-20) surfaced.
 *
 * NODE-FREE (mirrors `locus.ts`): pure string/argv transforms plus an injected
 * `run`, so `core` stays node-free and every branch is unit-testable off-box.
 *
 * The spike finding this encodes: a version-managed Node (asdf/nvm/fnm) is on
 * PATH only in an INTERACTIVE shell — those managers hook the interactive rc
 * (`.zshrc`/`.bashrc`), not the login profile. So `wsl.exe -e bash -lc "node …"`
 * finds NOTHING (proven: empty output), while the user's login shell run
 * interactively (`-ic`) finds it. `process.execPath` then resolves a shim to the
 * real binary, so the daemon is spawned by absolute path with no shell in the
 * hot path (and no reliance on the manager at spawn time).
 */

import { type LocusCommand, locusCommand } from "./locus";
import { shellLines, stripShellControl } from "./wsl-shell";

/** Probe for the user's login shell: `getent passwd <user>`'s 7th field. */
export function buildWslLoginShellProbe(distro: string): LocusCommand {
  return locusCommand({ kind: "wsl", distro }, "sh", [
    "-lc",
    'getent passwd "$(id -un)" | cut -d: -f7',
  ]);
}

/** The absolute login-shell path from the probe, or `/bin/sh` when unreadable. */
export function parseLoginShell(raw: string): string {
  const line = shellLines(raw).at(-1) ?? "";
  return /^\/\S*\/[^/]+$/.test(line) ? line : "/bin/sh";
}

/**
 * Probe for the real Node binary: run the login shell INTERACTIVELY (`-ic`, so its
 * rc sources the version manager) and print `process.execPath` (a shim resolves to
 * the real binary). `-e <shell> -ic <cmd>` passes argv byte-verbatim — the shell
 * gets exactly one `-c` command string, never a second shell layer.
 */
export function buildWslNodeProbe(distro: string, loginShell: string): LocusCommand {
  return locusCommand({ kind: "wsl", distro }, loginShell, [
    "-ic",
    "node -e 'process.stdout.write(process.execPath)'",
  ]);
}

/** The absolute `…/node` binary from the probe output, or `null` if none is present. */
export function parseWslNodePath(raw: string): string | null {
  const cleaned = stripShellControl(raw);
  // The real binary is an absolute path ending in `/node`; interactive noise (job
  // messages, a stripped prompt) may surround it, so take the LAST such token.
  const matches = cleaned.match(/\/\S*\/node\b/g);
  return matches?.at(-1) ?? null;
}

/** The daemon-launch spec, all paths already distro-native (`/home/u/…`). */
export interface WslDaemonLaunchSpec {
  readonly distro: string;
  /** Absolute Node binary inside the distro (from `resolveWslNode`). */
  readonly nodePath: string;
  /** Absolute daemon bundle path inside the distro fs (delivered copy, not the 9P view). */
  readonly bundlePath: string;
  /** Distro-native data dir the daemon owns (`daemon.json`, `daemon.log`, sqlite). */
  readonly dataDir: string;
  readonly serverVersion?: string;
  readonly uiDistPath?: string;
}

/**
 * The `wsl.exe … -e <node> <bundle> serve --data-dir <dir>` descriptor the shell
 * spawns (exactly the invocation the spike ran). Built through `locusCommand`, so
 * argv is byte-verbatim and there is no shell in the daemon's launch path.
 */
export function buildWslDaemonLaunch(spec: WslDaemonLaunchSpec): LocusCommand {
  const args = [spec.bundlePath, "serve", "--data-dir", spec.dataDir];
  if (spec.serverVersion) args.push("--server-version", spec.serverVersion);
  if (spec.uiDistPath) args.push("--ui-dist", spec.uiDistPath);
  return locusCommand({ kind: "wsl", distro: spec.distro }, spec.nodePath, args);
}

/** No usable Node in the distro — the shell must ship one or prompt the user. */
export class WslNodeNotFoundError extends Error {
  override readonly name = "WslNodeNotFoundError";
  constructor(readonly distro: string) {
    super(
      `No usable Node found in WSL distro "${distro}" (probed the login shell ` +
        `interactively). Install Node in the distro, or Rennet must ship one.`,
    );
  }
}

/**
 * Resolve the distro's real Node binary: read the login shell, then ask it
 * (interactively) for `process.execPath`. `run` executes a `LocusCommand` and
 * resolves its stdout — the desktop injects an `execa`-backed runner; tests inject
 * a fake. Throws `WslNodeNotFoundError` when the distro has no Node on its
 * interactive PATH.
 */
export async function resolveWslNode(
  distro: string,
  run: (command: LocusCommand) => Promise<string>,
): Promise<string> {
  const loginShell = parseLoginShell(await run(buildWslLoginShellProbe(distro)));
  const node = parseWslNodePath(await run(buildWslNodeProbe(distro, loginShell)));
  if (!node) throw new WslNodeNotFoundError(distro);
  return node;
}
