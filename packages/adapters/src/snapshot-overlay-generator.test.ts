import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeManifest } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { SnapshotOverlayGenerator, SnapshotOverlayReader } from "./snapshot-overlay-generator";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A repo with `main` (the default base) and a `feature` branch that ADDS one
 * source file, MODIFIES one, and DELETES one — the three cases an overlay must
 * capture (overlay-wins per shard key + a tombstone for the deletion).
 */
function repo(): { root: string; storeDir: string; mainOid: string; featureOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-ov-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-ovstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");

  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  write(root, "packages/a/src/doomed.ts", "export const doomed = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main one");
  const mainOid = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "feature");
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport const extra = 2;\n");
  write(root, "packages/a/src/added.ts", "export const added = true;\n");
  git(root, "rm", "-q", "packages/a/src/doomed.ts");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature diverges");
  const featureOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");

  return { root, storeDir, mainOid, featureOid };
}

/** Build (and store) the default-branch base map at `oid`; returns the store + repoKey. */
async function buildBase(store: ProjectSnapshotStore, root: string, oid: string): Promise<string> {
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: oid,
  });
  return manifest.repoKey;
}

/** A clean full build at an OID, the byte-equivalence oracle. */
async function fullAt(root: string, oid: string) {
  return new ProjectSnapshotGenerator().generate(root, {
    explicitBaseRef: oid,
    previousSymbols: [],
  });
}

describe("SnapshotOverlayGenerator — base + overlay over a real git repo", () => {
  it("the merged view is BYTE-EQUIVALENT to a clean full build at the non-default base OID", async () => {
    const { root, storeDir, mainOid, featureOid } = repo();
    const store = new ProjectSnapshotStore(storeDir);
    const repoKey = await buildBase(store, root, mainOid);
    const overlayStore = new SnapshotOverlayStore(store);

    const ensured = await new SnapshotOverlayGenerator({ store, overlayStore }).ensureOverlay(
      root,
      repoKey,
      featureOid,
    );
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.derived).toBe(true);
    // The delta captured the file-set change (overlay-wins) and inherited unchanged slots.
    expect(Object.keys(ensured.overlay.structuralDelta)).toContain("files");

    const merged = new SnapshotOverlayReader({ store, overlayStore }).resolveMerged(
      repoKey,
      featureOid,
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;

    expect(merged.snapshot.manifest.baseOid).toBe(featureOid);
    expect(merged.projectSnapshotId).toBe(ensured.overlay.compositeId);

    const full = await fullAt(root, featureOid);
    expect(serializeManifest(merged.snapshot.manifest)).toBe(serializeManifest(full.manifest));
    expect(merged.snapshot.manifest.fingerprint).toBe(full.manifest.fingerprint);
  }, 60000);

  it("a path deleted on the non-default base is omitted from the merged read (tombstone)", async () => {
    const { root, storeDir, mainOid, featureOid } = repo();
    const store = new ProjectSnapshotStore(storeDir);
    const repoKey = await buildBase(store, root, mainOid);
    const overlayStore = new SnapshotOverlayStore(store);

    const ensured = await new SnapshotOverlayGenerator({ store, overlayStore }).ensureOverlay(
      root,
      repoKey,
      featureOid,
    );
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    // The deleted .ts had a unique blob ⇒ its symbol shard is tombstoned.
    expect(ensured.overlay.symbolTombstones.length).toBeGreaterThan(0);

    const merged = new SnapshotOverlayReader({ store, overlayStore }).resolveMerged(
      repoKey,
      featureOid,
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const paths = merged.snapshot.files.map((f) => f.path);
    expect(paths).not.toContain("packages/a/src/doomed.ts"); // deleted → omitted
    expect(paths).toContain("packages/a/src/added.ts"); // added → present
    expect(paths).toContain("packages/a/src/index.ts"); // modified → present
  }, 60000);

  it("the overlay re-derives when the default base advances (freshness on the pair)", async () => {
    const { root, storeDir, mainOid, featureOid } = repo();
    const store = new ProjectSnapshotStore(storeDir);
    const repoKey = await buildBase(store, root, mainOid);
    const overlayStore = new SnapshotOverlayStore(store);
    const gen = new SnapshotOverlayGenerator({ store, overlayStore });
    const reader = new SnapshotOverlayReader({ store, overlayStore });

    const first = await gen.ensureOverlay(root, repoKey, featureOid);
    expect(first.ok && first.derived).toBe(true);
    const beforeId = first.ok ? first.overlay.compositeId : "";
    expect(reader.resolveMerged(repoKey, featureOid).ok).toBe(true);

    // Advance main and regenerate the base map at the new OID (same store).
    write(root, "packages/a/src/mainonly.ts", "export const mainOnly = 9;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main two");
    const mainOid2 = git(root, "rev-parse", "HEAD");
    await buildBase(store, root, mainOid2);

    // The stored overlay is now STALE against the advanced base — a read fails closed.
    const staleRead = reader.resolveMerged(repoKey, featureOid);
    expect(staleRead.ok).toBe(false);
    if (staleRead.ok) return;
    expect(staleRead.failure.reason).toBe("stale");

    // Re-derive against the new base: fresh again, a NEW composite id, still byte-equivalent.
    const second = await gen.ensureOverlay(root, repoKey, featureOid);
    expect(second.ok && second.derived).toBe(true);
    const afterId = second.ok ? second.overlay.compositeId : "";
    expect(afterId).not.toBe(beforeId);

    const merged = reader.resolveMerged(repoKey, featureOid);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const full = await fullAt(root, featureOid);
    expect(serializeManifest(merged.snapshot.manifest)).toBe(serializeManifest(full.manifest));
  }, 90000);

  it("a fresh overlay is reused verbatim (not re-derived)", async () => {
    const { root, storeDir, mainOid, featureOid } = repo();
    const store = new ProjectSnapshotStore(storeDir);
    const repoKey = await buildBase(store, root, mainOid);
    const overlayStore = new SnapshotOverlayStore(store);
    const gen = new SnapshotOverlayGenerator({ store, overlayStore });

    const first = await gen.ensureOverlay(root, repoKey, featureOid);
    expect(first.ok && first.derived).toBe(true);
    const second = await gen.ensureOverlay(root, repoKey, featureOid);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.derived).toBe(false); // reused, no rebuild
  }, 60000);

  it("an ANCESTOR of the default base works as an overlay target (historical-PR review)", async () => {
    // A merged PR's base OID is an older commit on the default branch itself. The
    // versioned-repo-map property is that the overlay reconstructs the snapshot at
    // that historical OID byte-identically — the review reads the repo as it was,
    // not as it is today.
    const { root, storeDir, mainOid } = repo();
    // Advance main past the historical point so `mainOid` becomes an ancestor.
    write(root, "packages/a/src/newer.ts", "export const newer = true;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main moves on");
    const headOid = git(root, "rev-parse", "HEAD");

    const store = new ProjectSnapshotStore(storeDir);
    const repoKey = await buildBase(store, root, headOid);
    const overlayStore = new SnapshotOverlayStore(store);
    const gen = new SnapshotOverlayGenerator({ store, overlayStore });

    const ensured = await gen.ensureOverlay(root, repoKey, mainOid);
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;

    const merged = new SnapshotOverlayReader({ store, overlayStore }).resolveMerged(
      repoKey,
      mainOid,
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.snapshot.manifest.baseOid).toBe(mainOid);
    // The file added after the historical point is absent from the merged view.
    const full = await fullAt(root, mainOid);
    expect(serializeManifest(merged.snapshot.manifest)).toBe(serializeManifest(full.manifest));
    expect(merged.snapshot.manifest.fingerprint).toBe(full.manifest.fingerprint);
  }, 90000);
});
