import type { KnowledgeSnapshotContext } from "../knowledge-generation";

/**
 * Partitioning is invisible plumbing (#460): slices exist only for the duration
 * of a swarm run — no partition-shaped artifact survives it. Every file in the
 * snapshot inventory lands in EXACTLY one slice, by construction:
 *
 * - one slice per workspace scope, a file belonging to the DEEPEST scope root
 *   that prefixes it (nested scopes never double-claim);
 * - a scope over the cap subtree-splits by directory prefix walk until under it
 *   (a flat directory that cannot split further stays oversized — the cap is a
 *   target, not a hard bound);
 * - files outside every scope (or a snapshot with no scopes at all) fall back
 *   to top-level-directory slices, cap-split the same way.
 *
 * Pure and deterministic: same snapshot → same slices in the same order.
 */

/** Target per-worker slice size (#460: "~120-file per-worker cap"). */
export const DEFAULT_PARTITION_CAP = 120;

/** One worker's slice of the inventory. */
export interface PartitionSlice {
  /** Deterministic id: the scope name, `<id>/<dir>` per subtree split, `<id>/.` for direct files; `dir:<top-level>` / `dir:.` for the no-scope fallback. */
  readonly id: string;
  readonly files: readonly { readonly path: string; readonly blobOid: string }[];
}

type FileEntry = { readonly path: string; readonly blobOid: string };

function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Subtree-split one group by directory prefix walk until each piece is under the cap. */
function splitGroup(
  id: string,
  prefix: string,
  files: readonly FileEntry[],
  cap: number,
  out: PartitionSlice[],
): void {
  if (files.length <= cap) {
    out.push({ id, files });
    return;
  }
  const direct: FileEntry[] = [];
  const byDir = new Map<string, FileEntry[]>();
  for (const file of files) {
    const rest = prefix === "" ? file.path : file.path.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      direct.push(file);
    } else {
      const dir = rest.slice(0, slash);
      const group = byDir.get(dir);
      if (group === undefined) byDir.set(dir, [file]);
      else group.push(file);
    }
  }
  if (byDir.size === 0) {
    // A flat directory over the cap cannot split further; it stays oversized.
    out.push({ id, files });
    return;
  }
  if (direct.length > 0) out.push({ id: `${id}/.`, files: direct });
  for (const dir of [...byDir.keys()].sort()) {
    const group = byDir.get(dir) as FileEntry[];
    const childPrefix = prefix === "" ? dir : `${prefix}/${dir}`;
    splitGroup(`${id}/${dir}`, childPrefix, group, cap, out);
  }
}

/** Partition the snapshot inventory into worker slices. See the module doc for the guarantees. */
export function buildPartitions(
  snapshot: Pick<KnowledgeSnapshotContext, "files" | "scopes">,
  cap: number = DEFAULT_PARTITION_CAP,
): readonly PartitionSlice[] {
  // Deepest-root-first, so the first prefix match IS the most specific scope.
  const scopes = [...snapshot.scopes].sort(
    (a, b) => b.root.length - a.root.length || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0),
  );
  const byScope = new Map<string, FileEntry[]>();
  const unscoped: FileEntry[] = [];
  const sortedFiles = [...snapshot.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const file of sortedFiles) {
    const owner = scopes.find((scope) => underPrefix(file.path, scope.root));
    if (owner === undefined) {
      unscoped.push(file);
      continue;
    }
    const group = byScope.get(owner.name);
    if (group === undefined) byScope.set(owner.name, [file]);
    else group.push(file);
  }

  const out: PartitionSlice[] = [];
  for (const scope of [...scopes].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const group = byScope.get(scope.name);
    if (group === undefined || group.length === 0) continue;
    splitGroup(scope.name, scope.root, group, cap, out);
  }
  if (unscoped.length > 0) {
    const byTop = new Map<string, FileEntry[]>();
    const rootFiles: FileEntry[] = [];
    for (const file of unscoped) {
      const slash = file.path.indexOf("/");
      if (slash < 0) {
        rootFiles.push(file);
        continue;
      }
      const top = file.path.slice(0, slash);
      const group = byTop.get(top);
      if (group === undefined) byTop.set(top, [file]);
      else group.push(file);
    }
    if (rootFiles.length > 0) out.push({ id: "dir:.", files: rootFiles });
    for (const top of [...byTop.keys()].sort()) {
      splitGroup(`dir:${top}`, top, byTop.get(top) as FileEntry[], cap, out);
    }
  }
  return out;
}
