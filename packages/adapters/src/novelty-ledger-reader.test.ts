import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchFile, Patchset, ProjectSnapshotManifest } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { NoveltyLedgerReader } from "./novelty-ledger-reader";
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

/** A minimal pnpm workspace repo with one scope, a source file with two exports, and a test. */
function workspaceRepo(): { root: string; storeDir: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-novelty-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-noveltystore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");

  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "biome.json", '{ "formatter": { "enabled": true } }\n');
  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/index.ts" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  write(root, "packages/a/src/index.test.ts", "import { a } from './index';\n");

  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  return { root, storeDir, oid };
}

async function generate(): Promise<{
  store: ProjectSnapshotStore;
  manifest: ProjectSnapshotManifest;
}> {
  const { root, storeDir, oid } = workspaceRepo();
  const store = new ProjectSnapshotStore(storeDir);
  const generator = new ProjectSnapshotGenerator({ store });
  const { manifest } = await generator.generate(root, { explicitBaseRef: oid });
  return { store, manifest };
}

function patchFile(over: Partial<PatchFile> & Pick<PatchFile, "path" | "status">): PatchFile {
  return { previousPath: undefined, additions: 1, deletions: 0, binary: false, patch: "", ...over };
}

/** A patchset pinned to `baseOid` (the snapshot-coupling contract). */
function patchset(baseOid: string, files: PatchFile[]): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: {
      id: "repo-1",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid,
      headOid: "oid-head",
    },
    files,
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

describe("NoveltyLedgerReader — over a real generated snapshot (dogfood)", () => {
  it("classifies novel / extends / conforms against the real base-branch snapshot", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));

    const result = reader.classify(
      manifest.repoKey,
      patchset(manifest.baseOid, [
        // modified existing file: extends, with a novel symbol and an extends symbol
        patchFile({
          path: "packages/a/src/index.ts",
          status: "modified",
          patch: ["+export function makeC() {}", "+export function makeA() {}"].join("\n"),
        }),
        // brand-new source file: novel
        patchFile({
          path: "packages/a/src/added.ts",
          status: "added",
          patch: "+export const brand = 1",
        }),
        // new test file: conforms to the established **/*.test.* convention
        patchFile({ path: "packages/a/src/added.test.ts", status: "added" }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { ledger } = result;
    expect(ledger.snapshotFingerprint).toBe(manifest.fingerprint);
    expect(ledger.baseOid).toBe(manifest.baseOid);

    const at = (path: string, kind: "file" | "symbol", symbol?: string) =>
      ledger.entries.find(
        (e) => e.unit.path === path && e.unit.kind === kind && e.unit.symbol === symbol,
      );

    expect(at("packages/a/src/index.ts", "file")?.classification).toBe("extends");
    expect(at("packages/a/src/index.ts", "symbol", "makeC")?.classification).toBe("novel");
    // makeA already exists in the real baseline shard → extends, citing the real symbol.
    const makeA = at("packages/a/src/index.ts", "symbol", "makeA");
    expect(makeA?.classification).toBe("extends");
    expect(makeA?.evidence.match.kind).toBe("symbol-present");

    expect(at("packages/a/src/added.ts", "file")?.classification).toBe("novel");
    expect(at("packages/a/src/added.ts", "symbol", "brand")?.classification).toBe("novel");

    const conforms = at("packages/a/src/added.test.ts", "file");
    expect(conforms?.classification).toBe("conforms");
    expect(conforms?.evidence.match).toEqual({
      kind: "test-convention",
      path: "packages/a/src/added.test.ts",
      matchedBy: "**/*.test.*",
      siblingTestCount: 1,
    });
  });
});

describe("NoveltyLedgerReader — the fail-closed gate (cannot classify)", () => {
  it("refuses when the snapshot is STALE (patchset pinned to a different base OID)", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));

    const result = reader.classify(
      manifest.repoKey,
      patchset("0000000000000000000000000000000000000000", [
        patchFile({ path: "packages/a/src/index.ts", status: "modified" }),
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("stale");
    if (result.failure.reason !== "stale") return;
    expect(result.failure.storedBaseOid).toBe(manifest.baseOid);
    expect(result.failure.requestedBaseOid).toBe("0000000000000000000000000000000000000000");
  });

  it("refuses when NO snapshot exists for the repo (absent)", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));

    const result = reader.classify(
      "/no/such/repo/.git",
      patchset(manifest.baseOid, [
        patchFile({ path: "packages/a/src/index.ts", status: "modified" }),
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("absent");
  });
});
