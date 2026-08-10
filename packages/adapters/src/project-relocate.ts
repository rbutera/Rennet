import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * Relocation & aliases (#141, design §1.5 — "the only concession path-keying
 * needs"). Because the store is keyed by the escaped absolute PATH, moving a repo
 * on disk changes its key. Rather than force a rebuild, `relocateProject` RENAMES
 * the project directory to the new escaped key and records the move; `addAlias`
 * lets an alternative escaped path resolve to the same project without copying.
 * Adopted from codeindexer.dev's model.
 */

/** The outcome of a relocation attempt. */
export interface RelocateResult {
  readonly relocated: boolean;
  /** Why the move did not happen. */
  readonly reason?: "source-missing" | "target-exists";
}

/**
 * Move a project's store directory from `oldRepoKey` to `newRepoKey` WITHOUT
 * reindexing (the map bytes are carried, not rebuilt), and record `relocatedFrom`
 * in the new location's `config.json`. Fails safe: a missing source or an already-
 * occupied target is a no-op with a typed reason, never an overwrite.
 */
export function relocateProject(
  store: ProjectSnapshotStore,
  oldRepoKey: string,
  newRepoKey: string,
  options: { newPath?: string } = {},
): RelocateResult {
  if (oldRepoKey === newRepoKey) return { relocated: true };
  const from = store.paths(oldRepoKey).projectDir;
  const to = store.paths(newRepoKey).projectDir;
  if (!existsSync(from)) return { relocated: false, reason: "source-missing" };
  if (existsSync(to)) return { relocated: false, reason: "target-exists" };

  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
  store.updateConfig(newRepoKey, (current) => ({
    ...current,
    relocatedFrom: oldRepoKey,
    path: options.newPath ?? current.path,
  }));
  return { relocated: true };
}

/**
 * Record that `aliasRepoKey` is an alternative escaped path for the project keyed
 * at `canonicalRepoKey`. Idempotent — an alias already present is not duplicated.
 */
export function addAlias(
  store: ProjectSnapshotStore,
  canonicalRepoKey: string,
  aliasRepoKey: string,
): void {
  store.updateConfig(canonicalRepoKey, (current) => {
    const aliases = new Set(current.aliases ?? []);
    aliases.add(aliasRepoKey);
    return { ...current, aliases: [...aliases].sort() };
  });
}

/**
 * Resolve an escaped path to the project it belongs to. If a project directory
 * exists at `repoKey`, that IS the project. Otherwise scan the store for a project
 * whose `config.aliases` lists `repoKey`, and return its canonical key. Returns
 * `repoKey` unchanged when nothing resolves (a fresh project keys itself).
 */
export function resolveProjectKey(store: ProjectSnapshotStore, repoKey: string): string {
  if (existsSync(store.paths(repoKey).projectDir)) return repoKey;

  // The store base dir is the parent of any project dir; scan siblings for an alias.
  const baseDir = join(store.paths(repoKey).projectDir, "..");
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return repoKey;
  }
  for (const entry of entries) {
    if (entry === repoKey) continue;
    const config = store.loadConfig(entry);
    if (config?.aliases?.includes(repoKey)) return entry;
  }
  return repoKey;
}
