import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SnapshotOverlay } from "@rennet/protocol";
import { canonicalize, SNAPSHOT_OVERLAY_SCHEMA_VERSION, sha256Hex } from "@rennet/protocol";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The app-owned store for base+overlay deltas (#143, design §3), living under the
 * reserved `<escaped-path>/overlays/<non-default-base-oid>/` home the wave-1 store
 * already carved out. One directory per non-default base OID:
 *
 *   overlays/<oid>/overlay.json    ← the delta manifest ({@link SnapshotOverlay})
 *   overlays/<oid>/shards/<d>.json ← ONLY the shard bytes new-or-changed vs the base
 *
 * Genuine delta storage: a shard whose digest already lives in the base map's
 * content-addressed `map/shards/` is never re-written here, so an overlay holds
 * only what the non-default base actually changed. The merged reader resolves a
 * shard from the overlay dir first, then falls back to the base store.
 *
 * Every read is FAIL-SAFE (Rule 75): a missing/unreadable/malformed overlay reads
 * as "absent" (forcing a re-derive), never a throw. Writes are atomic (temp +
 * rename), mirroring the base store, so a crash mid-write never leaves a half
 * overlay a reader could serve.
 */

/** The resolved on-disk paths for one overlay entry. */
export interface OverlayPaths {
  /** `overlays/<oid>/`. */
  readonly overlayDir: string;
  /** `overlays/<oid>/overlay.json`. */
  readonly overlayManifestPath: string;
  /** `overlays/<oid>/shards/`. */
  readonly overlayShardsDir: string;
}

/** The default bound on retained overlays per project (LRU beyond this). */
export const DEFAULT_OVERLAY_MAX_ENTRIES = 32;

/**
 * The reaping policy (LOCKED retention, design §8.4): LRU beyond `maxEntries`, plus
 * drop-when-the-target-base-OID-is-unreachable. `isReachable` is injected (a git
 * `cat-file -e` probe in production) so the store stays testable and node-only.
 */
export interface OverlayRetentionPolicy {
  readonly maxEntries: number;
  /** Whether a target base OID is still reachable in git; unreachable ⇒ reaped. */
  readonly isReachable?: (targetBaseOid: string) => boolean;
}

/** What a reap pass removed, for observability. */
export interface OverlayReapResult {
  /** Target OIDs dropped because they are no longer reachable in git. */
  readonly droppedUnreachable: readonly string[];
  /** Target OIDs evicted as the least-recently-used beyond `maxEntries`. */
  readonly evictedLru: readonly string[];
}

export class SnapshotOverlayStore {
  private tmpSeq = 0;

  constructor(private readonly store: ProjectSnapshotStore) {}

  /** The resolved paths for one overlay. `targetBaseOid` is used directly as the dir name. */
  paths(repoKey: string, targetBaseOid: string): OverlayPaths {
    const overlayDir = join(this.store.paths(repoKey).overlaysDir, targetBaseOid);
    return {
      overlayDir,
      overlayManifestPath: join(overlayDir, "overlay.json"),
      overlayShardsDir: join(overlayDir, "shards"),
    };
  }

  /**
   * The stored overlay for `(repoKey, targetBaseOid)`, or null when absent/
   * unreadable/malformed. FAIL-SAFE: a corrupt overlay reads as "no overlay yet",
   * forcing a re-derive, never a throw and never a partial read.
   */
  read(repoKey: string, targetBaseOid: string): SnapshotOverlay | null {
    try {
      const raw = readFileSync(this.paths(repoKey, targetBaseOid).overlayManifestPath, "utf8");
      const parsed = JSON.parse(raw) as SnapshotOverlay;
      if (!isWellFormedOverlay(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Load an overlay shard's bytes by digest, or undefined if absent/unreadable. */
  loadShard(repoKey: string, targetBaseOid: string, digest: string): string | undefined {
    try {
      return readFileSync(
        join(this.paths(repoKey, targetBaseOid).overlayShardsDir, `${digest}.json`),
        "utf8",
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Write an overlay + its delta shard bytes atomically. Shards are written first
   * (content-addressed, idempotent), then the overlay manifest is renamed into
   * place, so a reader never sees a manifest pointing at a shard that is not yet on
   * disk. `shardBytes` should contain ONLY the digests the overlay's delta
   * references that are not already in the base store.
   */
  write(overlay: SnapshotOverlay, shardBytes: ReadonlyMap<string, string>): void {
    const { overlayShardsDir, overlayManifestPath } = this.paths(
      overlay.repoKey,
      overlay.targetBaseOid,
    );
    mkdirSync(overlayShardsDir, { recursive: true });
    for (const [digest, bytes] of shardBytes) {
      const path = join(overlayShardsDir, `${digest}.json`);
      if (!shardIsIntact(path, digest)) this.writeAtomic(path, bytes);
    }
    this.writeAtomic(overlayManifestPath, `${canonicalize(overlay)}\n`);
  }

  /** The target base OIDs that currently have a stored overlay for this repo. */
  list(repoKey: string): string[] {
    try {
      return readdirSync(this.store.paths(repoKey).overlaysDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Remove one overlay entry (its dir and all shards). Idempotent. */
  remove(repoKey: string, targetBaseOid: string): void {
    rmSync(this.paths(repoKey, targetBaseOid).overlayDir, { recursive: true, force: true });
  }

  /** Mark an overlay as recently used (bumps its manifest mtime for LRU ordering). */
  touch(repoKey: string, targetBaseOid: string): void {
    try {
      const now = new Date();
      utimesSync(this.paths(repoKey, targetBaseOid).overlayManifestPath, now, now);
    } catch {
      // a missing overlay cannot be touched; nothing to do.
    }
  }

  /**
   * Reap overlays (LOCKED retention): first drop every overlay whose target base
   * OID is no longer reachable in git, then evict the least-recently-used until at
   * most `maxEntries` remain. Fail-safe: an unreadable mtime sorts oldest (reaped
   * first), so a corrupt entry never pins the store.
   */
  reap(repoKey: string, policy: OverlayRetentionPolicy): OverlayReapResult {
    const droppedUnreachable: string[] = [];
    let present = this.list(repoKey);

    if (policy.isReachable) {
      for (const oid of present) {
        if (!policy.isReachable(oid)) {
          this.remove(repoKey, oid);
          droppedUnreachable.push(oid);
        }
      }
      present = present.filter((oid) => !droppedUnreachable.includes(oid));
    }

    const evictedLru: string[] = [];
    if (present.length > policy.maxEntries) {
      const byAge = present
        .map((oid) => ({ oid, mtime: this.mtimeMs(repoKey, oid) }))
        .sort((l, r) => l.mtime - r.mtime);
      const toEvict = byAge.slice(0, present.length - policy.maxEntries);
      for (const { oid } of toEvict) {
        this.remove(repoKey, oid);
        evictedLru.push(oid);
      }
    }

    return { droppedUnreachable, evictedLru };
  }

  private mtimeMs(repoKey: string, targetBaseOid: string): number {
    try {
      return statSync(this.paths(repoKey, targetBaseOid).overlayManifestPath).mtimeMs;
    } catch {
      return 0; // unreadable ⇒ oldest ⇒ reaped first.
    }
  }

  private writeAtomic(path: string, bytes: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
}

/** Whether an on-disk shard file exists AND its bytes hash back to `digest`. */
function shardIsIntact(path: string, digest: string): boolean {
  try {
    return sha256Hex(readFileSync(path, "utf8")) === digest;
  } catch {
    return false;
  }
}

/**
 * Deep-validate the read shape so a malformed overlay degrades to "absent".
 *
 * EVERY shard-delta array a v3 overlay declares is checked, imports included: a
 * v3-STAMPED but truncated overlay (schema version present, `importUpserts`
 * missing) would otherwise pass this guard and then THROW inside `applyShardDelta`
 * when the merge iterates it — turning "degrade to absent" into a crash on the read
 * path.
 */
function isWellFormedOverlay(value: unknown): value is SnapshotOverlay {
  if (!value || typeof value !== "object") return false;
  const o = value as Partial<SnapshotOverlay>;
  return (
    o.schemaVersion === SNAPSHOT_OVERLAY_SCHEMA_VERSION &&
    typeof o.repoKey === "string" &&
    typeof o.baseFingerprint === "string" &&
    typeof o.baseDefaultOid === "string" &&
    typeof o.targetBaseRef === "string" &&
    typeof o.targetBaseRefResolution === "string" &&
    typeof o.targetBaseOid === "string" &&
    typeof o.targetFingerprint === "string" &&
    typeof o.compositeId === "string" &&
    !!o.structuralDelta &&
    typeof o.structuralDelta === "object" &&
    Array.isArray(o.symbolUpserts) &&
    Array.isArray(o.symbolTombstones) &&
    Array.isArray(o.referenceUpserts) &&
    Array.isArray(o.referenceTombstones) &&
    Array.isArray(o.importUpserts) &&
    Array.isArray(o.importTombstones)
  );
}
