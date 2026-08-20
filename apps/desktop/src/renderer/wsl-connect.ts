// WSL connect flow (shell side) — the renderer's half of connecting a picked WSL directory to
// that distro's in-distro daemon. Kept in its OWN import-safe module (renderer/index.tsx has
// top-level render side effects, so it can't be imported by a unit test) and injected with the
// preload's two methods, so the decision is testable without Electron.
//
// The renderer cannot import `@rennet/core`: its barrel pulls `node:crypto`, which a browser
// bundle can't take. So the locus regex is duplicated here from packages/core/src/locus.ts.
// ponytail: ~3-line regex twins mirror core; the alternative (bundling core into the renderer)
// breaks the build. Keep them in lockstep with core's `detectLocus` / `toDistroPath`.
import type { ConnectionTarget, DaemonResolution } from "@rennet/app-ui";
import type { WslConnectLogEntry } from "../preload/index";

const WSL_UNC_RE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/i;

/** The distro a `\\wsl.localhost\<distro>\…` / `\\wsl$\…` path names, or null for a host path. */
export function wslDistroOf(path: string): string | null {
  return WSL_UNC_RE.exec(path)?.[1] ?? null;
}

/** UNC → distro-native (`/home/…`); an already-`/` path passes through; anything else is null. */
export function toDistroPath(path: string): string | null {
  const match = WSL_UNC_RE.exec(path);
  if (match) return `/${(match[2] ?? "").replace(/\\/g, "/")}`;
  return path.startsWith("/") ? path : null;
}

/** The preload capability slice this flow needs: resolve a daemon + append a debug line. */
export interface WslConnectDeps {
  resolveDaemonForPath(path: string): Promise<number | null>;
  logWslConnect(entry: WslConnectLogEntry): void;
}

/**
 * Resolve which daemon should serve a just-picked repo path (threaded into `ConnectionHost`,
 * which composes the app-facing `connectDaemonForPath`):
 * - host path → `switched:false` (host behaviour unchanged; nothing to switch);
 * - WSL path → ask MAIN to ensure that distro's in-distro daemon, then return a tokenless LOCAL
 *   target at its loopback port plus the distro-native repo path the remounted app captures;
 * - MAIN rejection (no Node in the distro, WSL unreachable) or an untrusted null → honest inline
 *   failure copy, `switched:false` + `error` — never a gate.
 * Every decision is logged to MAIN's `<userData>/wsl-connect.log` for a live-run SSH trace.
 */
export async function resolveDaemonTarget(
  path: string,
  deps: WslConnectDeps,
): Promise<DaemonResolution> {
  const distro = wslDistroOf(path);
  deps.logWslConnect({
    event: "detect",
    path,
    detail: { locus: distro ? `wsl:${distro}` : "host" },
  });
  if (!distro) return { switched: false };
  try {
    const port = await deps.resolveDaemonForPath(path);
    if (port == null) {
      const error = "Rennet could not resolve this WSL directory's daemon (unavailable).";
      deps.logWslConnect({ event: "error", path, detail: { distro, error } });
      return { switched: false, error };
    }
    const repoPath = toDistroPath(path) ?? path;
    const target: ConnectionTarget = {
      id: `wsl:${distro}`,
      label: `WSL · ${distro}`,
      host: "127.0.0.1",
      port,
    };
    deps.logWslConnect({ event: "switch", path, detail: { distro, port, repoPath } });
    return { switched: true, target, repoPath };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);
    deps.logWslConnect({ event: "error", path, detail: { distro, error } });
    return { switched: false, error };
  }
}
