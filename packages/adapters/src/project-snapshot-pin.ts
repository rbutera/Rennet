import { realpathSync } from "node:fs";
import { escapePath } from "@rennet/core";
import { execaGit, type GitExec } from "./git-range-diff";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { type ResolvedBase, resolveBaseRef } from "./project-snapshot-source";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import {
  type MergedSnapshotSource,
  SnapshotOverlayGenerator,
  SnapshotOverlayReader,
} from "./snapshot-overlay-generator";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

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
    if (resolved?.ok) return resolved.projectSnapshotId;
    return store.loadManifestAt(repoKey, baseOid)?.fingerprint;
  };
}

/** Build any missing base/overlay material, then resolve the capture-time pin. */
export async function ensureProjectSnapshotPin(
  store: ProjectSnapshotStore,
  repoRoot: string,
  baseOid: string,
  git: GitExec = execaGit,
): Promise<string> {
  const repoKey = escapePath(realpathSync(repoRoot));
  const overlayStore = new SnapshotOverlayStore(store);
  const overlayReader = new SnapshotOverlayReader({ store, overlayStore });
  const resolvePin = projectSnapshotPinResolver(store, overlayReader);
  const present = resolvePin(repoRoot, baseOid);
  if (present) return present;

  let defaultBase: ResolvedBase;
  try {
    defaultBase = await resolveBaseRef(repoRoot, { git });
  } catch {
    defaultBase = await resolveBaseRef(repoRoot, { git, explicitBaseRef: baseOid });
  }
  if (!store.loadManifestAt(repoKey, defaultBase.baseOid)) {
    await new ProjectSnapshotGenerator({ store, git }).generate(repoRoot, {
      explicitBaseRef: defaultBase.baseOid,
    });
  }
  if (baseOid !== defaultBase.baseOid) {
    await new SnapshotOverlayGenerator({ store, overlayStore, git }).ensureOverlay(
      repoRoot,
      repoKey,
      baseOid,
    );
  }
  const resolved = resolvePin(repoRoot, baseOid);
  if (!resolved) throw new Error(`ProjectSnapshot pin unavailable at ${baseOid}`);
  return resolved;
}
