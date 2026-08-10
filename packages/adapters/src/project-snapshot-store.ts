import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@rennet/protocol";
import type { BuiltSnapshot, ProjectSnapshotManifest, SymbolShard } from "@rennet/types";

/**
 * The app-owned, LOCAL-ONLY ProjectSnapshot store (R27/R55, #141).
 *
 * The derived snapshot lives in an app-owned local store keyed by REPO IDENTITY
 * (the RepoRecord `repoKey` = `realpath(git-common-dir)`, R19), never by
 * working-tree path — so all worktrees of a repo share one entry and the map
 * never travels across branches (it is pinned to the default-branch OID). The
 * store base directory is injected (the desktop app passes
 * `app.getPath("userData")/snapshots`), exactly like the sibling file stores.
 *
 * ⛔ This is NOT the in-repo `.rennet/snapshot/` path the issue text names — R55
 * (Rai, 2026-08-09) moved the DERIVED snapshot out of the mandatory-`.rennet/`
 * claim into this app-owned store. `.rennet/` keeps human-authored config plus,
 * optionally, a MIRRORED map; that opt-in mirror is a follow-on.
 *
 * Shards are content-addressed (`shards/<digest>.json`), so a write is
 * idempotent and safe to repeat. The manifest is advanced ATOMICALLY: all shards
 * are written first, then the manifest is written to a temp file and `rename`d
 * over `manifest.json` (atomic on a single filesystem). If the process dies
 * mid-write the old manifest still points at its own complete shards, so a
 * reader never sees a half-built snapshot.
 */
export class ProjectSnapshotStore {
  constructor(private readonly baseDir: string) {}

  /** The per-repo directory, keyed by a filesystem-safe hash of the RepoRecord key. */
  private repoDir(repoKey: string): string {
    return join(this.baseDir, sha256Hex(repoKey));
  }

  private manifestPath(repoKey: string): string {
    return join(this.repoDir(repoKey), "manifest.json");
  }

  private shardPath(repoKey: string, digest: string): string {
    return join(this.repoDir(repoKey), "shards", `${digest}.json`);
  }

  /**
   * The current stored manifest for a repo, or null when absent/unreadable/
   * malformed. FAIL-SAFE (Rule 75): a corrupt store degrades to "no snapshot
   * yet" (forcing a clean rebuild), never a throw and never a partial read.
   */
  loadManifest(repoKey: string): ProjectSnapshotManifest | null {
    try {
      const raw = readFileSync(this.manifestPath(repoKey), "utf8");
      const parsed = JSON.parse(raw) as ProjectSnapshotManifest;
      if (!parsed || typeof parsed.baseOid !== "string" || typeof parsed.fingerprint !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Load a shard's bytes by digest, or undefined if absent/unreadable. */
  loadShard(repoKey: string, digest: string): string | undefined {
    try {
      return readFileSync(this.shardPath(repoKey, digest), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * The per-file symbol shards a stored manifest references, parsed back into
   * {@link SymbolShard}s for incremental-reuse planning. A shard that is missing
   * or malformed is skipped (it will simply be re-extracted).
   */
  loadSymbolShards(manifest: ProjectSnapshotManifest): SymbolShard[] {
    const shards: SymbolShard[] = [];
    for (const [, digest] of manifest.symbols) {
      const bytes = this.loadShard(manifest.repoKey, digest);
      if (bytes === undefined) continue;
      // Integrity: only reuse a shard whose bytes actually hash to its digest.
      if (sha256Hex(bytes) !== digest) continue;
      try {
        const parsed = JSON.parse(bytes) as SymbolShard;
        if (parsed && typeof parsed.blobOid === "string" && Array.isArray(parsed.symbols)) {
          shards.push(parsed);
        }
      } catch {
        // skip malformed
      }
    }
    return shards;
  }

  /**
   * Advance the stored snapshot to `built`, atomically. Every referenced shard
   * is written first (content-addressed, idempotent), then the manifest is
   * written to a temp file and renamed over the live `manifest.json`. The old
   * snapshot is fully readable until the final rename.
   */
  advance(built: BuiltSnapshot): void {
    const repoKey = built.manifest.repoKey;
    const dir = this.repoDir(repoKey);
    mkdirSync(join(dir, "shards"), { recursive: true });

    for (const [digest, bytes] of built.shards) {
      const path = this.shardPath(repoKey, digest);
      // Idempotent: a content-addressed file that already exists holds the same
      // bytes by construction, so skip the rewrite.
      if (!existsSync(path)) writeFileSync(path, bytes);
    }

    // Canonical bytes (sorted keys, LF) so the stored manifest is itself
    // byte-reproducible for a given OID, matching the shard bytes.
    const manifestBytes = `${canonicalize(built.manifest)}\n`;
    const tmp = join(dir, `manifest.json.tmp-${process.pid}`);
    writeFileSync(tmp, manifestBytes);
    renameSync(tmp, this.manifestPath(repoKey));
  }
}
