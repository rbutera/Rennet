import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeCoverage, KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { committedKnowledgeDir, KNOWLEDGE_FILE, KnowledgeStore } from "./knowledge-store";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const REPO_KEY = "-Users-x-proj";

function fresh(): { store: KnowledgeStore; base: ProjectSnapshotStore; repoRoot: string } {
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-kstore-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "rennet-krepo-"));
  scratch.push(storeDir, repoRoot);
  const base = new ProjectSnapshotStore(storeDir);
  return { store: new KnowledgeStore(base), base, repoRoot };
}

function statement(id: string): KnowledgeStatement {
  return {
    id,
    subject: "@t/a",
    aspect: "purpose",
    claim: `claim ${id}`,
    evidence: [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }],
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: "g@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "oid-1", snapshotFingerprint: "fp-1" },
  };
}

function coverage(): KnowledgeCoverage {
  return {
    schemaVersion: 1,
    catalogueDigest: "catalogue-digest",
    selector: {
      kind: "council",
      cap: 64,
      generator: "map-scope@1",
      harness: "codex",
      assignedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      apiKeySource: null,
    },
    groups: [
      {
        kind: "mapped",
        sliceId: "module:packages/a",
        files: [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }],
      },
      {
        kind: "excluded",
        source: "scope",
        sliceId: "fallback:docs",
        reason: "Reference material",
        files: [{ path: "docs/reference.md", blobOid: "blob-docs" }],
      },
      {
        kind: "excluded",
        source: "mechanical",
        reason: "lockfile",
        files: [{ path: "pnpm-lock.yaml", blobOid: "blob-lock" }],
      },
    ],
  };
}

function set(
  repoKey: string,
  statements: KnowledgeStatement[],
  exactCoverage?: KnowledgeCoverage,
): KnowledgeSet {
  return {
    schemaVersion: 1,
    repoKey,
    baseOid: "oid-1",
    snapshotFingerprint: "fp-1",
    generator: "g@1",
    ...(exactCoverage === undefined ? {} : { coverage: exactCoverage }),
    statements,
  };
}

describe("KnowledgeStore local", () => {
  it("round-trips a saved set", () => {
    const { store } = fresh();
    expect(store.loadLocal(REPO_KEY)).toBeNull();
    store.save(REPO_KEY, set(REPO_KEY, [statement("a")]));
    expect(store.loadLocal(REPO_KEY)?.statements.map((s) => s.id)).toEqual(["a"]);
  });

  it("round-trips exact coverage through local save/load without byte drift", () => {
    const { store, base } = fresh();
    const expected = set(REPO_KEY, [statement("a")], coverage());
    const path = join(base.paths(REPO_KEY).knowledgeDir, KNOWLEDGE_FILE);

    store.save(REPO_KEY, expected);
    const firstBytes = readFileSync(path, "utf8");
    const loaded = store.loadLocal(REPO_KEY);
    expect(loaded).toEqual(expected);
    if (loaded === null) throw new Error("saved knowledge did not load");

    store.save(REPO_KEY, loaded);
    expect(readFileSync(path, "utf8")).toBe(firstBytes);
  });

  it("reads a malformed local file as absent (fail-safe), never a throw", () => {
    const { store, base } = fresh();
    const path = join(base.paths(REPO_KEY).knowledgeDir, KNOWLEDGE_FILE);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not valid json");
    expect(store.loadLocal(REPO_KEY)).toBeNull();
  });

  it("rejects malformed present coverage whole while legacy absence remains readable", () => {
    const { store, base } = fresh();
    const path = join(base.paths(REPO_KEY).knowledgeDir, KNOWLEDGE_FILE);
    const legacy = set(REPO_KEY, [statement("legacy")]);
    const exactCoverage = coverage();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ...legacy,
        coverage: {
          ...exactCoverage,
          groups: [
            ...exactCoverage.groups,
            {
              kind: "mapped",
              sliceId: "duplicate-path",
              files: [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }],
            },
          ],
        },
      }),
    );
    expect(store.loadLocal(REPO_KEY)).toBeNull();

    writeFileSync(path, JSON.stringify(legacy));
    expect(store.loadLocal(REPO_KEY)).toEqual(legacy);
  });
});

describe("KnowledgeStore promotion + discovery", () => {
  it("promotes a valid local set into <repo>/.rennet/knowledge and flips config.promoted", () => {
    const { store, base, repoRoot } = fresh();
    store.save(REPO_KEY, set(REPO_KEY, [statement("a")]));
    const result = store.promote(REPO_KEY, repoRoot);
    expect(result.promoted).toBe(true);
    expect(result.committedKnowledgeDir).toBe(committedKnowledgeDir(repoRoot));
    expect(base.loadConfig(REPO_KEY)?.promoted).toBe(true);
    expect(store.loadCommitted(repoRoot)?.statements).toHaveLength(1);
  });

  it("preserves exact coverage bytes through promotion and committed discovery", () => {
    const { store, base, repoRoot } = fresh();
    const expected = set(REPO_KEY, [statement("a")], coverage());
    const localPath = join(base.paths(REPO_KEY).knowledgeDir, KNOWLEDGE_FILE);
    store.save(REPO_KEY, expected);
    const localBytes = readFileSync(localPath, "utf8");

    expect(store.promote(REPO_KEY, repoRoot).promoted).toBe(true);
    const committedPath = join(committedKnowledgeDir(repoRoot), KNOWLEDGE_FILE);
    expect(readFileSync(committedPath, "utf8")).toBe(localBytes);

    const discoveredStoreDir = mkdtempSync(join(tmpdir(), "rennet-kstore-discovered-"));
    scratch.push(discoveredStoreDir);
    const discoveredBase = new ProjectSnapshotStore(discoveredStoreDir);
    const discoveredStore = new KnowledgeStore(discoveredBase);
    expect(discoveredStore.discoverCommitted(REPO_KEY, repoRoot)).toEqual({
      found: true,
      valid: true,
      seeded: true,
    });
    expect(discoveredStore.loadLocal(REPO_KEY)).toEqual(expected);
    expect(
      readFileSync(join(discoveredBase.paths(REPO_KEY).knowledgeDir, KNOWLEDGE_FILE), "utf8"),
    ).toBe(localBytes);
  });

  it("refuses to promote when there is no local set", () => {
    const { store, repoRoot } = fresh();
    expect(store.promote(REPO_KEY, repoRoot)).toEqual({
      promoted: false,
      reason: "no-local-knowledge",
    });
  });

  it("discovers + seeds a committed set into the local store, re-keyed to this checkout", () => {
    const { store, repoRoot } = fresh();
    // A committed set carrying the PROMOTER's key.
    const committed = committedKnowledgeDir(repoRoot);
    mkdirSync(committed, { recursive: true });
    writeFileSync(
      join(committed, KNOWLEDGE_FILE),
      JSON.stringify(set("-other-promoter-key", [statement("a")])),
    );

    const outcome = store.discoverCommitted(REPO_KEY, repoRoot);
    expect(outcome).toEqual({ found: true, valid: true, seeded: true });
    const local = store.loadLocal(REPO_KEY);
    expect(local?.repoKey).toBe(REPO_KEY); // re-keyed to this checkout
    expect(local?.statements.map((s) => s.id)).toEqual(["a"]);
  });

  it("never seeds a malformed committed set (found, not valid)", () => {
    const { store, repoRoot } = fresh();
    const committed = committedKnowledgeDir(repoRoot);
    mkdirSync(committed, { recursive: true });
    writeFileSync(join(committed, KNOWLEDGE_FILE), "{ broken");
    expect(store.discoverCommitted(REPO_KEY, repoRoot)).toEqual({
      found: true,
      valid: false,
      seeded: false,
    });
    expect(store.loadLocal(REPO_KEY)).toBeNull();
  });

  it("does not clobber an existing local set on discovery (local wins)", () => {
    const { store, repoRoot } = fresh();
    store.save(REPO_KEY, set(REPO_KEY, [statement("local")]));
    const committed = committedKnowledgeDir(repoRoot);
    mkdirSync(committed, { recursive: true });
    writeFileSync(
      join(committed, KNOWLEDGE_FILE),
      JSON.stringify(set(REPO_KEY, [statement("committed")])),
    );

    const outcome = store.discoverCommitted(REPO_KEY, repoRoot);
    expect(outcome.seeded).toBe(false);
    expect(store.loadLocal(REPO_KEY)?.statements.map((s) => s.id)).toEqual(["local"]);
  });

  it("resolve: local first, then committed", () => {
    const { store, repoRoot } = fresh();
    const committed = committedKnowledgeDir(repoRoot);
    mkdirSync(committed, { recursive: true });
    writeFileSync(
      join(committed, KNOWLEDGE_FILE),
      JSON.stringify(set(REPO_KEY, [statement("committed")])),
    );
    expect(store.resolve(REPO_KEY, repoRoot)?.statements.map((s) => s.id)).toEqual(["committed"]);

    store.save(REPO_KEY, set(REPO_KEY, [statement("local")]));
    expect(store.resolve(REPO_KEY, repoRoot)?.statements.map((s) => s.id)).toEqual(["local"]);
  });
});
