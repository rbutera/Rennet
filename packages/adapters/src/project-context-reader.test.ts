import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@rennet/protocol";
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
    // hash to its digest. The store lays shards at <sha256(repoKey)>/shards/<digest>.json.
    const shardPath = join(
      storeDir,
      sha256Hex(manifest.repoKey),
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
});
