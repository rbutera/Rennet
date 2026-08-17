import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeSet, KnowledgeStatement } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { knowledgeBackend } from "./knowledge-backend";
import { KnowledgeStore } from "./knowledge-store";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

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

async function seededRepo() {
  const root = mkdtempSync(join(tmpdir(), "rennet-kb-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-kbstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "r@e.test");
  git(root, "config", "user.name", "R");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");

  const store = new ProjectSnapshotStore(storeDir);
  const generator = new ProjectSnapshotGenerator({ store });
  const { manifest } = await generator.generate(root, { explicitBaseRef: oid });
  const reader = new ProjectContextReader(store);
  const knowledgeStore = new KnowledgeStore(store);
  // Recover the real blobOid the index file was committed as.
  const gated = reader.loadFresh(manifest.repoKey, manifest.baseOid);
  if (!gated.ok) throw new Error("fixture snapshot not fresh");
  const indexBlob = gated.snapshot.files.find((f) => f.path === "packages/a/src/index.ts")?.blobOid;
  if (!indexBlob) throw new Error("fixture file missing");
  return { reader, knowledgeStore, manifest, root, indexBlob };
}

function statement(blobOid: string): KnowledgeStatement {
  return {
    id: "k1",
    subject: "@t/a",
    aspect: "purpose",
    claim: "scope a exports a constant",
    evidence: [{ path: "packages/a/src/index.ts", blobOid }],
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: "g@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "x", snapshotFingerprint: "y" },
  };
}

describe("knowledgeBackend — gated read of the enriched set", () => {
  it("returns an honest empty view (ok) when no set exists yet", async () => {
    const { reader, knowledgeStore, manifest } = await seededRepo();
    const backend = knowledgeBackend(reader, knowledgeStore, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const result = backend.knowledge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.knowledge.generator).toBeNull();
    expect(result.knowledge.statements).toEqual([]);
  });

  it("serves a set whose anchors resolve as current, verbatim + labelled", async () => {
    const { reader, knowledgeStore, manifest, indexBlob } = await seededRepo();
    const set: KnowledgeSet = {
      schemaVersion: 1,
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
      snapshotFingerprint: manifest.fingerprint,
      generator: "g@1",
      statements: [statement(indexBlob)],
    };
    knowledgeStore.save(manifest.repoKey, set);
    const backend = knowledgeBackend(reader, knowledgeStore, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const result = backend.knowledge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.knowledge.statements).toHaveLength(1);
    expect(result.knowledge.statements[0]?.status).toBe("hypothesis");
    expect(result.knowledge.invalidatedPending).toEqual([]);
  });

  it("discloses a statement whose cited bytes no longer resolve as invalidated-pending", async () => {
    const { reader, knowledgeStore, manifest } = await seededRepo();
    const set: KnowledgeSet = {
      schemaVersion: 1,
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
      snapshotFingerprint: manifest.fingerprint,
      generator: "g@1",
      statements: [statement("stale-blob-oid")],
    };
    knowledgeStore.save(manifest.repoKey, set);
    const backend = knowledgeBackend(reader, knowledgeStore, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const result = backend.knowledge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.knowledge.statements).toEqual([]);
    expect(result.knowledge.invalidatedPending.map((s) => s.id)).toEqual(["k1"]);
  });

  it("fails closed when the snapshot is stale (a wrong base OID), never a served view", async () => {
    const { reader, knowledgeStore, manifest, indexBlob } = await seededRepo();
    knowledgeStore.save(manifest.repoKey, {
      schemaVersion: 1,
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
      snapshotFingerprint: manifest.fingerprint,
      generator: "g@1",
      statements: [statement(indexBlob)],
    });
    const backend = knowledgeBackend(reader, knowledgeStore, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));
    const result = backend.knowledge();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
  });
});
