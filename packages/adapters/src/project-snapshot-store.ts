import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

  /** Monotonic suffix for temp files, so concurrent writes never collide. */
  private tmpSeq = 0;

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

  // NOTE (#3, deferred): a single composed fail-closed `loadCurrent(repoKey,
  // requestedBaseOid)` gate — one call that loads the manifest, checks freshness
  // (`isSnapshotFresh`) AND integrity (`verifySnapshotIntegrity` over the store's
  // shard loader) before handing any snapshot to a consumer — is intentionally
  // NOT built here yet: the context.map / context.file / context.knowledge
  // consumers that would call it do not exist. The pieces it would compose
  // (`loadManifest`, `loadShard`, `isSnapshotFresh`, `verifySnapshotIntegrity`)
  // are all present and individually tested; wire the gate when the first
  // consumer lands so it is covered by a real caller.

  /**
   * The current stored manifest for a repo, or null when absent/unreadable/
   * malformed. FAIL-SAFE (Rule 75): a corrupt store degrades to "no snapshot
   * yet" (forcing a clean rebuild), never a throw and never a partial read.
   */
  loadManifest(repoKey: string): ProjectSnapshotManifest | null {
    try {
      const raw = readFileSync(this.manifestPath(repoKey), "utf8");
      const parsed = JSON.parse(raw) as ProjectSnapshotManifest;
      // A manifest that parses as JSON but is malformed in `shards` (missing/null/
      // non-object) or `symbols` (non-array) must degrade to "no snapshot" here,
      // NOT slip through to throw later: the downstream gate does
      // `Object.keys(manifest.shards)` and `for (…of manifest.symbols)`, which
      // throw on null/non-iterable. Validating the full read shape keeps
      // loadManifest's contract literal — "malformed → null, never a throw"
      // (Rule 75, fail-safe on the vital "never serve/never crash on a corrupt
      // store" circuit).
      if (
        !parsed ||
        typeof parsed.baseOid !== "string" ||
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.shards !== "object" ||
        parsed.shards === null ||
        !Array.isArray(parsed.symbols)
      ) {
        return null;
      }
      // Deep-validate the INNER shapes too, not just the top-level containers.
      // The downstream gate does `manifest.shards[slot].digest` and destructures
      // `for (const [, digest] of manifest.symbols)` — both THROW on a null shard
      // value or a non-iterable symbol entry (e.g. `shards.files = null`,
      // `symbols: [null]`), shapes the container-only check above still admits.
      // A store that produced such a manifest is corrupt; degrade to "no
      // snapshot" HERE so the contract stays literal ("malformed → null, never a
      // throw", Rule 75) instead of throwing inside a later "never a throw" gate.
      for (const ref of Object.values(parsed.shards)) {
        if (!ref || typeof ref !== "object" || typeof (ref as { digest?: unknown }).digest !== "string") {
          return null;
        }
      }
      for (const entry of parsed.symbols) {
        if (!Array.isArray(entry) || entry.length < 2 || typeof entry[1] !== "string") {
          return null;
        }
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
   * is written first (content-addressed), then the manifest is written to a temp
   * file and renamed over the live `manifest.json`. The old snapshot is fully
   * readable until the final rename.
   */
  advance(built: BuiltSnapshot): void {
    const repoKey = built.manifest.repoKey;
    const dir = this.repoDir(repoKey);
    mkdirSync(join(dir, "shards"), { recursive: true });

    for (const [digest, bytes] of built.shards) {
      const path = this.shardPath(repoKey, digest);
      // A pre-existing content-addressed shard is trustworthy ONLY if its
      // on-disk bytes actually hash back to the digest. `existsSync` alone is not
      // enough: an earlier non-atomic write truncated by a crash leaves a file
      // that EXISTS but is corrupt, and publishing a fresh manifest that points
      // at it would serve a truncated shard (#2). So verify the bytes, and
      // (re)write the known-good bytes on any absence or mismatch. The write is
      // atomic (temp + rename in the same dir), so a crash mid-rewrite cannot
      // itself leave a truncated shard behind.
      if (!this.shardIsIntact(path, digest)) this.writeAtomic(path, bytes);
    }

    // Canonical bytes (sorted keys, LF) so the stored manifest is itself
    // byte-reproducible for a given OID, matching the shard bytes.
    const manifestBytes = `${canonicalize(built.manifest)}\n`;
    this.writeAtomic(this.manifestPath(repoKey), manifestBytes);
  }

  /** Whether an on-disk shard file exists AND its bytes hash back to `digest`. */
  private shardIsIntact(path: string, digest: string): boolean {
    try {
      return sha256Hex(readFileSync(path, "utf8")) === digest;
    } catch {
      return false;
    }
  }

  /**
   * Write `bytes` to `path` atomically: to a sibling temp file, then `rename`
   * over the target (atomic on a single filesystem). A reader never sees a
   * partial file, and a crash mid-write leaves the target untouched.
   */
  private writeAtomic(path: string, bytes: string): void {
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
}
