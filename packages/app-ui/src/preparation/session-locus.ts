import type { Locus } from "@rennet/protocol";
import { useCommand, useRefreshCommand } from "../data";
import { sourceOfLocus } from "../data/tool-install";

// ─────────────────────────────────────────────────────────────────────────────
// WHERE a session's git runs, for Install for me. A missing `git-lfs` is missing on the
// machine that checks the repository out — this Mac, or a WSL distro — so the install has
// to go there. The project's settings row names its locus.
//
// While `settings.get` has not answered, the locus is UNKNOWN, not "this Mac": guessing the
// host for a WSL project would install Git LFS on the wrong machine and report success.
// So the caller gets `undefined` until the read answers (Install for me waits, disabled),
// and a read that failed says so with a way to ask again. Once the settings have answered,
// a project they carry no row for is on this host, which is the only place such a project
// can be.
// ─────────────────────────────────────────────────────────────────────────────

const HOST: Locus = { kind: "host" };

export interface ProjectLocus {
  /** The machine to install on, or undefined while it is not known. */
  readonly locus: Locus | undefined;
  /** The settings read failed, so the machine cannot be known until it is asked again. */
  readonly failed: boolean;
  readonly retry: () => void;
}

export function useProjectLocus(projectId: string | undefined): ProjectLocus {
  const { data, error } = useCommand("settings.get", {}, { enabled: projectId !== undefined });
  const retry = useRefreshCommand("settings.get");
  if (data === undefined) return { locus: undefined, failed: error !== undefined, retry };
  const row = data.projects?.find((candidate) => candidate.projectId === projectId);
  return { locus: row?.locus ?? HOST, failed: false, retry };
}

export { sourceOfLocus };

/**
 * Whether Git LFS answered on that locus, from the same probe Settings shows. `undefined`
 * when the probe has not been read, the engine did not probe it, or the locus is not known
 * yet: a caller that must decide treats that as available rather than inventing a missing
 * tool.
 */
export function useLfsAvailable(locus: Locus | undefined): boolean | undefined {
  const { data } = useCommand("forge.hosts", {});
  if (locus === undefined) return undefined;
  const host = data?.hosts.find((entry) => entry.source === sourceOfLocus(locus));
  if (host === undefined || !host.asked) return undefined;
  const lfs = host.sourceControl?.find((tool) => tool.id === "git-lfs");
  return lfs === undefined ? undefined : lfs.status === "available";
}
