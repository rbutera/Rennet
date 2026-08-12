import { realpathSync } from "node:fs";
import { escapePath } from "@rennet/core";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import type { MergedSnapshotSource } from "./snapshot-overlay-generator";

/** Resolve the effective map identity stamped onto a diff captured at `baseOid`. */
export function projectSnapshotPinResolver(
  store: ProjectSnapshotStore,
  merged?: MergedSnapshotSource,
): (repoRoot: string, baseOid: string) => string | undefined {
  return (repoRoot, baseOid) => {
    const repoKey = escapePath(realpathSync(repoRoot));
    const manifest = store.loadManifest(repoKey);
    if (!manifest) return undefined;
    if (manifest.baseOid === baseOid) return manifest.fingerprint;
    const resolved = merged?.resolveMerged(repoKey, baseOid);
    return resolved?.ok ? resolved.projectSnapshotId : undefined;
  };
}
