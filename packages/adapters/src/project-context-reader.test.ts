import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshotManifest } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

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

/**
 * Corrupt the manifest the gate actually reads (#246). `loadFresh` reads the per-OID
 * manifest `map/manifests/<baseOid>.json` and falls back to the current pointer
 * `map/manifest.json`; a malformed-store test must corrupt BOTH, or the gate serves the
 * copy that stayed valid.
 */
function corruptBothManifests(
  storeDir: string,
  manifest: ProjectSnapshotManifest,
  malformed: unknown,
): void {
  const bytes = JSON.stringify(malformed);
  writeFileSync(join(storeDir, manifest.repoKey, "map", "manifest.json"), bytes);
  writeFileSync(
    join(storeDir, manifest.repoKey, "map", "manifests", `${manifest.baseOid}.json`),
    bytes,
  );
}

/** A minimal pnpm workspace repo with two scopes and one commit on `main`. */
function workspaceRepo(): { root: string; storeDir: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-ctx-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-ctxstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");

  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "biome.json", '{ "formatter": { "enabled": true } }\n');
  write(root, "CODEOWNERS", "* @team/maintainers\npackages/a/** @team/a-owners\n");

  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/index.ts" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  write(root, "packages/a/src/index.test.ts", "import { a } from './index';\n");

  write(
    root,
    "packages/b/package.json",
    JSON.stringify({
      name: "@t/b",
      private: true,
      main: "./src/index.ts",
      dependencies: { "@t/a": "workspace:*" },
    }),
  );
  write(root, "packages/b/src/index.ts", "export function useB() {}\n");

  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  return { root, storeDir, oid };
}

async function generate(): Promise<{
  store: ProjectSnapshotStore;
  manifest: ProjectSnapshotManifest;
  storeDir: string;
}> {
  const { root, storeDir, oid } = workspaceRepo();
  const store = new ProjectSnapshotStore(storeDir);
  const generator = new ProjectSnapshotGenerator({ store });
  const { manifest } = await generator.generate(root, { explicitBaseRef: oid });
  return { store, manifest, storeDir };
}

describe("ProjectContextReader — context.map over a real generated snapshot", () => {
  it("serves the deterministic structural map at the pinned base OID", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);

    const result = reader.readProjectMap(manifest.repoKey, manifest.baseOid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const map = result.map;
    expect(map.baseOid).toBe(manifest.baseOid);
    expect(map.fingerprint).toBe(manifest.fingerprint);
    expect(map.scopes.map((s) => s.name).sort()).toEqual(["@t/a", "@t/b"]);
    expect(map.files.some((f) => f.path === "packages/a/src/index.ts")).toBe(true);
    // The manifest-declared dependency @t/b → @t/a is present as an edge.
    expect(map.edges).toContainEqual({ from: "@t/b", to: "@t/a", kind: "manifest" });
  });

  it("scopes the map to a named workspace scope", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);

    const result = reader.readProjectMap(manifest.repoKey, manifest.baseOid, { scope: "@t/a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.map.scopes.map((s) => s.name)).toEqual(["@t/a"]);
    expect(result.map.files.every((f) => f.path.startsWith("packages/a/"))).toBe(true);
  });
});

describe("ProjectContextReader — context.file over a real generated snapshot", () => {
  it("recovers a source file's symbols through the gate", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);

    const result = reader.readFileContext(
      manifest.repoKey,
      manifest.baseOid,
      "packages/a/src/index.ts",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.scope).toBe("@t/a");
    expect(result.context.hasSymbols).toBe(true);
    expect(result.context.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
  });

  it("refuses an unsafe path before any lookup", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readFileContext(manifest.repoKey, manifest.baseOid, "../escape.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-path");
  });
});

describe("ProjectContextReader — context.overview over a real generated snapshot", () => {
  it("recovers a file's symbol overview through the gate (symbols only)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readFileOverview(
      manifest.repoKey,
      manifest.baseOid,
      "packages/a/src/index.ts",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overview.hasSymbols).toBe(true);
    expect(result.overview.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
  });

  it("surfaces a whole-snapshot gate failure as snapshot-unavailable (stale pin)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readFileOverview(
      manifest.repoKey,
      "0000000000000000000000000000000000000000",
      "packages/a/src/index.ts",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
    if (result.reason !== "snapshot-unavailable") return;
    expect(result.failure.reason).toBe("stale");
  });
});

describe("ProjectContextReader — context.symbol over a real generated snapshot", () => {
  it("resolves an exported symbol name to its definition site through the gate", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    // The fixture exports `makeA` (a function) from packages/a/src/index.ts.
    const result = reader.readSymbolDefinition(manifest.repoKey, manifest.baseOid, {
      name: "makeA",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definitions.sites).toHaveLength(1);
    expect(result.definitions.sites[0]?.path).toBe("packages/a/src/index.ts");
    expect(result.definitions.sites[0]?.kind).toBe("function");
    expect(result.definitions.sites[0]?.scope).toBe("@t/a");
  });

  it("returns an empty site set for a name absent from the index", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readSymbolDefinition(manifest.repoKey, manifest.baseOid, {
      name: "noSuchSymbol",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definitions.sites).toEqual([]);
  });

  it("surfaces a stale pin as snapshot-unavailable, never served sites", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readSymbolDefinition(
      manifest.repoKey,
      "0000000000000000000000000000000000000000",
      { name: "makeA" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
  });
});

describe("ProjectContextReader — context.references over a real generated snapshot", () => {
  it("resolves an identifier's occurrence sites through the gate, ranked by (path, line)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    // `a` is declared in packages/a/src/index.ts (line 1) and imported in its test.
    const result = reader.readReferences(manifest.repoKey, manifest.baseOid, { name: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.references.sites.map((s) => s.path);
    expect(paths).toContain("packages/a/src/index.ts");
    expect(paths).toContain("packages/a/src/index.test.ts");
    // Ranked deterministically: paths sorted, so the test file (…index.test.ts)
    // precedes the source file it imports from is NOT assumed — assert monotonic order.
    const sorted = [...result.references.sites].sort((l, r) =>
      l.path === r.path ? l.line - r.line : l.path < r.path ? -1 : 1,
    );
    expect(result.references.sites).toEqual(sorted);
  });

  it("returns an empty site set for a name absent from the index", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readReferences(manifest.repoKey, manifest.baseOid, {
      name: "noSuchIdentifier",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.sites).toEqual([]);
  });

  it("narrows to a workspace scope", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readReferences(manifest.repoKey, manifest.baseOid, {
      name: "a",
      scope: "@t/b",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `a` occurs only in @t/a's files, so narrowing to @t/b yields nothing.
    expect(result.references.sites).toEqual([]);
  });

  it("surfaces a stale pin as snapshot-unavailable, never served sites", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readReferences(
      manifest.repoKey,
      "0000000000000000000000000000000000000000",
      { name: "a" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
  });
});

describe("ProjectContextReader — the fail-closed staleness/integrity gate", () => {
  it("refuses an ABSENT snapshot (no map served)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readProjectMap("/no/such/repo/.git", manifest.baseOid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("absent");
  });

  it("refuses a STALE snapshot: a request pinned to a different OID is not served", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readProjectMap(
      manifest.repoKey,
      "0000000000000000000000000000000000000000",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
    if (result.failure.reason !== "stale") return;
    expect(result.failure.storedBaseOid).toBe(manifest.baseOid);
  });

  it("surfaces a stale gate as a snapshot-unavailable file result", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const result = reader.readFileContext(
      manifest.repoKey,
      "0000000000000000000000000000000000000000",
      "packages/a/src/index.ts",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
  });

  it("refuses a CORRUPT snapshot: a tampered shard on disk fails the integrity gate", async () => {
    const { store, manifest, storeDir } = await generate();
    const reader = new ProjectContextReader(store);

    // Sanity: it reads cleanly before tampering.
    expect(reader.readProjectMap(manifest.repoKey, manifest.baseOid).ok).toBe(true);

    // Overwrite the `files` structural shard on disk with bytes that no longer
    // hash to its digest. The store lays shards at <escaped-path>/map/shards/<digest>.json.
    const shardPath = join(
      storeDir,
      manifest.repoKey,
      "map",
      "shards",
      `${manifest.shards.files.digest}.json`,
    );
    writeFileSync(shardPath, '{"slot":"files","version":1,"entries":[]}');

    const result = reader.readProjectMap(manifest.repoKey, manifest.baseOid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("corrupt");
    if (result.failure.reason !== "corrupt") return;
    expect(result.failure.mismatched).toContain(manifest.shards.files.digest);
  });

  it("refuses a MALFORMED manifest (null shards) with a typed failure, never a throw", async () => {
    const { store, manifest, storeDir } = await generate();
    const reader = new ProjectContextReader(store);

    // Overwrite the manifest with parseable-but-malformed JSON: the real baseOid
    // and schemaVersion (so it passes the freshness check), but `shards` nulled
    // out. Without the loadManifest shape-guard the gate would reach
    // `Object.keys(manifest.shards)` and THROW instead of returning a typed
    // reason — violating its own "never a throw" contract (Rule 75).
    corruptBothManifests(storeDir, manifest, { ...manifest, shards: null });

    expect(() => reader.readProjectMap(manifest.repoKey, manifest.baseOid)).not.toThrow();
    const result = reader.readProjectMap(manifest.repoKey, manifest.baseOid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A store that cannot produce a well-formed manifest degrades to "no snapshot".
    expect(result.failure.reason).toBe("absent");
  });

  it("refuses a NESTED-malformed manifest (null shard value / non-tuple symbols) with a typed failure, never a throw", async () => {
    const { store, manifest, storeDir } = await generate();
    const reader = new ProjectContextReader(store);

    // These pass the container-only shape check (`shards` is a non-null object,
    // `symbols` is an array) but the INNER values are malformed. Without the
    // deep-shape guard the gate reaches `manifest.shards[slot].digest` /
    // `for (const [, digest] of manifest.symbols)` and THROWS — violating its own
    // "never a throw" contract (Rule 75). Both must degrade to a typed refusal.
    corruptBothManifests(storeDir, manifest, {
      ...manifest,
      shards: { ...manifest.shards, files: null },
    });
    expect(() => reader.readProjectMap(manifest.repoKey, manifest.baseOid)).not.toThrow();
    const r1 = reader.readProjectMap(manifest.repoKey, manifest.baseOid);
    expect(r1.ok).toBe(false);

    corruptBothManifests(storeDir, manifest, { ...manifest, symbols: [null] });
    expect(() =>
      reader.readFileContext(manifest.repoKey, manifest.baseOid, "packages/a/src/index.ts"),
    ).not.toThrow();
    const r2 = reader.readProjectMap(manifest.repoKey, manifest.baseOid);
    expect(r2.ok).toBe(false);
  });
});
