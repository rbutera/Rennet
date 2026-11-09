import type { Locus } from "@rennet/protocol";
import { useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// WHERE a session's git runs, for Install for me. A missing `git-lfs` is missing on the
// machine that checks the repository out — this Mac, or a WSL distro — so the install has
// to go there. The project's settings row names its locus; a project the read does not
// carry (yet) is on this host, which is the only place a project without a row can be.
// ─────────────────────────────────────────────────────────────────────────────

const HOST: Locus = { kind: "host" };

export function useProjectLocus(projectId: string | undefined): Locus {
  const { data } = useCommand("settings.get", {}, { enabled: projectId !== undefined });
  const row = data?.projects?.find((candidate) => candidate.projectId === projectId);
  return row?.locus ?? HOST;
}

/** The `forge.hosts` source key a locus answers under. */
export function sourceOfLocus(locus: Locus): string {
  return locus.kind === "host" ? "local" : `wsl:${locus.distro}`;
}

/**
 * Whether Git LFS answered on that locus, from the same probe Settings shows. `undefined`
 * when the probe has not been read or the engine did not probe it: a caller that must
 * decide treats that as available rather than inventing a missing tool.
 */
export function useLfsAvailable(locus: Locus): boolean | undefined {
  const { data } = useCommand("forge.hosts", {});
  const host = data?.hosts.find((entry) => entry.source === sourceOfLocus(locus));
  if (host === undefined || !host.asked) return undefined;
  const lfs = host.sourceControl?.find((tool) => tool.id === "git-lfs");
  return lfs === undefined ? undefined : lfs.status === "available";
}
