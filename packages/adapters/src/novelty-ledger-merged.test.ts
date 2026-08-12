import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchFile, Patchset, ProjectSnapshotManifest } from "@rennet/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoveltyLedgerReader } from "./novelty-ledger-reader";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { SnapshotOverlayGenerator, SnapshotOverlayReader } from "./snapshot-overlay-generator";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

// Each case does real git (init + commits + snapshot build + overlay derive), which
// is slow under concurrent load; give the file generous headroom over the 5s default.
vi.setConfig({ testTimeout: 60000 });

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** main (default) + a feature branch that modifies a source file. */
function repo(): { root: string; storeDir: string; mainOid: string; featureOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-nov-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-novstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main one");
  const mainOid = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "feature");
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport const extra = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature diverges");
  const featureOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  return { root, storeDir, mainOid, featureOid };
}

function patchFile(over: Partial<PatchFile> & Pick<PatchFile, "path" | "status">): PatchFile {
  return { previousPath: undefined, additions: 1, deletions: 0, binary: false, patch: "", ...over };
}

function patchset(
  root: string,
  baseRef: string,
  baseOid: string,
  projectSnapshotId?: string,
): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: { id: "r", root, commonDir: join(root, ".git"), baseRef, baseOid, headOid: "head" },
    files: [
      patchFile({
        path: "packages/a/src/index.ts",
        status: "modified",
        patch: "+export const fresh = 3",
      }),
    ],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
    projectSnapshotId,
  };
}

async function setup(): Promise<{
  reader: ProjectContextReader;
  overlayReader: SnapshotOverlayReader;
  repoKey: string;
  base: ProjectSnapshotManifest;
  root: string;
  mainOid: string;
  featureOid: string;
  compositeId: string;
  store: ProjectSnapshotStore;
}> {
  const { root, storeDir, mainOid, featureOid } = repo();
  const store = new ProjectSnapshotStore(storeDir);
  const { manifest: base } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: mainOid,
  });
  const overlayStore = new SnapshotOverlayStore(store);
  const ensured = await new SnapshotOverlayGenerator({ store, overlayStore }).ensureOverlay(
    root,
    base.repoKey,
    featureOid,
  );
  if (!ensured.ok) throw new Error("overlay derivation failed");
  return {
    reader: new ProjectContextReader(store),
    overlayReader: new SnapshotOverlayReader({ store, overlayStore }),
    repoKey: base.repoKey,
    base,
    root,
    mainOid,
    featureOid,
    compositeId: ensured.overlay.compositeId,
    store,
  };
}

describe("NoveltyLedgerReader — projectSnapshotId pin + merged effective base", () => {
  it("a NON-DEFAULT-base review classifies against the MERGED base+overlay view", async () => {
    const s = await setup();
    const ledgerReader = new NoveltyLedgerReader(s.reader, s.overlayReader);

    const result = ledgerReader.classify(
      s.repoKey,
      patchset(s.root, "feature", s.featureOid, s.compositeId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Classified against the merged snapshot at the feature OID, not the default base.
    expect(result.ledger.baseOid).toBe(s.featureOid);
    expect(result.ledger.projectSnapshotId).toBe(s.compositeId);
  });

  it("a non-default base with the WRONG projectSnapshotId is refused as stale", async () => {
    const s = await setup();
    const ledgerReader = new NoveltyLedgerReader(s.reader, s.overlayReader);

    const result = ledgerReader.classify(
      s.repoKey,
      patchset(s.root, "feature", s.featureOid, "not-the-composite-id"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
  });

  it("a non-default base WITHOUT a merged source surfaces the base gate's stale refusal (wave-1)", async () => {
    const s = await setup();
    const ledgerReader = new NoveltyLedgerReader(s.reader); // no merged source

    const result = ledgerReader.classify(s.repoKey, patchset(s.root, "feature", s.featureOid));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
    if (result.failure.reason !== "stale") return;
    expect(result.failure.requestedBaseOid).toBe(s.featureOid);
  });

  it("a DEFAULT-base review with a matching projectSnapshotId classifies against the base map", async () => {
    const s = await setup();
    const ledgerReader = new NoveltyLedgerReader(s.reader, s.overlayReader);

    const result = ledgerReader.classify(
      s.repoKey,
      patchset(s.root, "main", s.mainOid, s.base.fingerprint),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.baseOid).toBe(s.mainOid);
    expect(result.ledger.snapshotFingerprint).toBe(s.base.fingerprint);
    expect(result.ledger.projectSnapshotId).toBe(s.base.fingerprint);
  });

  it("serves map, file, overview, symbol, and references from the same merged view", async () => {
    const s = await setup();
    const reader = new ProjectContextReader(s.store, s.overlayReader);
    const result = reader.loadFresh(s.repoKey, s.featureOid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.manifest.baseOid).toBe(s.featureOid);
    expect(result.snapshot.files.some((file) => file.path === "packages/a/src/index.ts")).toBe(true);
    expect(reader.readProjectMap(s.repoKey, s.featureOid).ok).toBe(true);
    expect(reader.readFileContext(s.repoKey, s.featureOid, "packages/a/src/index.ts").ok).toBe(true);
    expect(reader.readFileOverview(s.repoKey, s.featureOid, "packages/a/src/index.ts").ok).toBe(
      true,
    );
    expect(reader.readSymbolDefinition(s.repoKey, s.featureOid, { name: "extra" }).ok).toBe(true);
    expect(reader.readReferences(s.repoKey, s.featureOid, { name: "extra" }).ok).toBe(true);
  });

  it("a default base with a MISMATCHED projectSnapshotId is refused as stale", async () => {
    const s = await setup();
    const ledgerReader = new NoveltyLedgerReader(s.reader, s.overlayReader);

    const result = ledgerReader.classify(
      s.repoKey,
      patchset(s.root, "main", s.mainOid, "wrong-base-fingerprint"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
  });
});
