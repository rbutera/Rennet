import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotOverlay } from "@rennet/protocol";
import { SNAPSHOT_OVERLAY_SCHEMA_VERSION, sha256Hex } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function stores(): { base: ProjectSnapshotStore; overlays: SnapshotOverlayStore; repoKey: string } {
  const dir = mkdtempSync(join(tmpdir(), "rennet-ovstore-"));
  scratch.push(dir);
  const base = new ProjectSnapshotStore(dir);
  return { base, overlays: new SnapshotOverlayStore(base), repoKey: "-tmp-repo" };
}

function overlay(
  repoKey: string,
  targetBaseOid: string,
  over: Partial<SnapshotOverlay> = {},
): SnapshotOverlay {
  return {
    schemaVersion: SNAPSHOT_OVERLAY_SCHEMA_VERSION,
    repoKey,
    baseFingerprint: "base-fp",
    baseDefaultOid: "default-oid",
    targetBaseRef: `refs/${targetBaseOid}`,
    targetBaseRefResolution: "explicit-setting",
    targetBaseOid,
    targetFingerprint: `tf-${targetBaseOid}`,
    compositeId: `cid-${targetBaseOid}`,
    structuralDelta: {},
    symbolUpserts: [],
    symbolTombstones: [],
    referenceUpserts: [],
    referenceTombstones: [],
    importUpserts: [],
    importTombstones: [],
    ...over,
  };
}

describe("SnapshotOverlayStore — roundtrip + fail-safe", () => {
  it("writes and reads back an overlay + delta shard, with content-addressed shards", () => {
    const { overlays, repoKey } = stores();
    const bytes = `${JSON.stringify({ hi: 1 })}`;
    const digest = sha256Hex(bytes);
    const ov = overlay(repoKey, "oid1", { symbolUpserts: [["blobX", digest]] });

    overlays.write(ov, new Map([[digest, bytes]]));

    expect(overlays.read(repoKey, "oid1")).toEqual(ov);
    expect(overlays.loadShard(repoKey, "oid1", digest)).toBe(bytes);
    expect(overlays.list(repoKey)).toEqual(["oid1"]);
  });

  it("a missing overlay reads as null (fail-safe), never a throw", () => {
    const { overlays, repoKey } = stores();
    expect(overlays.read(repoKey, "nope")).toBeNull();
    expect(overlays.loadShard(repoKey, "nope", "d")).toBeUndefined();
    expect(overlays.list(repoKey)).toEqual([]);
  });

  it("remove deletes the overlay dir and its shards", () => {
    const { overlays, repoKey } = stores();
    overlays.write(overlay(repoKey, "oid1"), new Map());
    expect(overlays.read(repoKey, "oid1")).not.toBeNull();
    overlays.remove(repoKey, "oid1");
    expect(overlays.read(repoKey, "oid1")).toBeNull();
    expect(overlays.list(repoKey)).toEqual([]);
  });
});

describe("SnapshotOverlayStore — retention (LOCKED reaping)", () => {
  it("drops overlays whose target base OID is unreachable in git", () => {
    const { overlays, repoKey } = stores();
    overlays.write(overlay(repoKey, "reachable"), new Map());
    overlays.write(overlay(repoKey, "gone"), new Map());

    const result = overlays.reap(repoKey, {
      maxEntries: 100,
      isReachable: (oid) => oid !== "gone",
    });

    expect(result.droppedUnreachable).toEqual(["gone"]);
    expect(overlays.list(repoKey)).toEqual(["reachable"]);
  });

  it("LRU-evicts the oldest beyond maxEntries", () => {
    const { overlays, repoKey } = stores();
    for (const oid of ["a", "b", "c"]) overlays.write(overlay(repoKey, oid), new Map());
    // Control LRU order by explicit mtimes: a oldest, c newest.
    const at = (oid: string, secs: number) => {
      const t = new Date(secs * 1000);
      utimesSync(overlays.paths(repoKey, oid).overlayManifestPath, t, t);
    };
    at("a", 1000);
    at("b", 2000);
    at("c", 3000);

    const result = overlays.reap(repoKey, { maxEntries: 2 });

    expect(result.evictedLru).toEqual(["a"]);
    expect(overlays.list(repoKey)).toEqual(["b", "c"]);
  });

  it("reaps unreachable FIRST, then LRU-evicts what remains", () => {
    const { overlays, repoKey } = stores();
    for (const oid of ["a", "b", "c", "d"]) overlays.write(overlay(repoKey, oid), new Map());
    const at = (oid: string, secs: number) => {
      const t = new Date(secs * 1000);
      utimesSync(overlays.paths(repoKey, oid).overlayManifestPath, t, t);
    };
    at("a", 1000);
    at("b", 2000);
    at("c", 3000);
    at("d", 4000);

    const result = overlays.reap(repoKey, {
      maxEntries: 2,
      isReachable: (oid) => oid !== "d", // d dropped as unreachable
    });

    expect(result.droppedUnreachable).toEqual(["d"]);
    // a, b, c remain (3) > 2 ⇒ evict oldest (a).
    expect(result.evictedLru).toEqual(["a"]);
    expect(overlays.list(repoKey)).toEqual(["b", "c"]);
  });
});
