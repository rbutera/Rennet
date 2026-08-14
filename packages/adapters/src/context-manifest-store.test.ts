import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextManifest } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManifestStore } from "./context-manifest-store";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { store: ProjectSnapshotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rennet-ctxman-store-unit-"));
  scratch.push(dir);
  return { store: new ProjectSnapshotStore(dir), dir };
}

const REPO_KEY = "-repo";
const BASE_OID = "oid-abc";

const MANIFEST: ContextManifest = {
  repoRecordId: REPO_KEY,
  projectSnapshotId: "fp-1",
  compositionDigest: "comp-1",
  freshness: { status: "current", staleMembers: [] },
  members: [],
  documents: [
    {
      order: 0,
      source: "claude-md",
      sourcePath: "CLAUDE.md",
      contentHash: "a".repeat(64),
      originalBytes: 120,
      bytes: 120,
      state: "included",
    },
  ],
  totalBytes: 120,
  assembledPromptDigest: "b".repeat(64),
  exhaustive: false,
  unmanagedSources: ["harness ambient file reads"],
};

describe("ContextManifestStore (#30)", () => {
  it("persists a manifest and reloads it across a fresh store instance", () => {
    const { store, dir } = freshStore();
    new ContextManifestStore(store).save(REPO_KEY, BASE_OID, MANIFEST);
    // A brand-new store over the same dir (a fresh session) reloads it intact.
    const reloaded = new ContextManifestStore(new ProjectSnapshotStore(dir)).load(
      REPO_KEY,
      BASE_OID,
    );
    expect(reloaded).toEqual(MANIFEST);
  });

  it("returns an honest null (never a fabricated stand-in) when absent", () => {
    const { store } = freshStore();
    expect(new ContextManifestStore(store).load(REPO_KEY, BASE_OID)).toBeNull();
  });

  it("returns null for a malformed persisted manifest, never a partial served value", () => {
    const { store, dir } = freshStore();
    const projectDir = store.paths(REPO_KEY).projectDir;
    const path = join(projectDir, "context-manifests", `${BASE_OID}.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    // Missing the required `documents`/`assembledPromptDigest` — must read as absence.
    writeFileSync(path, JSON.stringify({ repoRecordId: REPO_KEY }));
    expect(
      new ContextManifestStore(new ProjectSnapshotStore(dir)).load(REPO_KEY, BASE_OID),
    ).toBeNull();
  });

  it("keys manifests by base OID so different bases persist independently", () => {
    const { store } = freshStore();
    const cms = new ContextManifestStore(store);
    cms.save(REPO_KEY, "oid-1", { ...MANIFEST, assembledPromptDigest: "1".repeat(64) });
    cms.save(REPO_KEY, "oid-2", { ...MANIFEST, assembledPromptDigest: "2".repeat(64) });
    expect(cms.load(REPO_KEY, "oid-1")?.assembledPromptDigest).toBe("1".repeat(64));
    expect(cms.load(REPO_KEY, "oid-2")?.assembledPromptDigest).toBe("2".repeat(64));
  });
});
