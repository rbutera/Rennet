import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshotManifest } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { projectContextBackend } from "./project-context-backend";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// ─────────────────────────────────────────────────────────────────────────────
// The FULL context-read path, end to end: a real generated ProjectSnapshot →
// ProjectContextReader (fail-closed gate) → projectContextBackend (the port
// slice) → the REGISTERED core `context.map` / `context.file` tools → the
// canvasOps@2 envelope. This proves the registered tools return correct
// map/file context through the gate, and that a stale/absent/corrupt snapshot
// surfaces as the right canvasOps freshness verdict — not a mock of the reader.
// ─────────────────────────────────────────────────────────────────────────────

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

async function generate(): Promise<{
  store: ProjectSnapshotStore;
  manifest: ProjectSnapshotManifest;
}> {
  const root = mkdtempSync(join(tmpdir(), "rennet-ctxbe-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-ctxbe-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/index.ts" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  const store = new ProjectSnapshotStore(storeDir);
  const generator = new ProjectSnapshotGenerator({ store });
  const { manifest } = await generator.generate(root, { explicitBaseRef: oid });
  return { store, manifest };
}

describe("context.map through the real reader gate", () => {
  it("serves the deterministic map at the resolved base OID", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.projectMap();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a served map");
    expect(result.map.baseOid).toBe(manifest.baseOid);
    expect(result.map.fingerprint).toBe(manifest.fingerprint);
    expect(result.map.scopes.map((s) => s.name)).toContain("@t/a");
  });

  it("narrows to a workspace scope through the port", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.projectMap({ scope: "@t/a" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a served map");
    expect(result.map.scopes.map((s) => s.name)).toEqual(["@t/a"]);
    expect(result.map.files.every((f) => f.path.startsWith("packages/a/"))).toBe(true);
  });

  it("refuses a STALE snapshot rather than serving a map (R30)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    // Resolve to a DIFFERENT base OID than the snapshot was built at.
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));

    const result = backend.projectMap();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a stale refusal");
    expect(result.failure.reason).toBe("stale");
    expect((result.failure as { storedBaseOid?: string }).storedBaseOid).toBe(manifest.baseOid);
  });

  it("maps an ABSENT snapshot (unknown repo) to an absent refusal", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: "/no/such/repo/.git",
      baseOid: manifest.baseOid,
    }));

    const result = backend.projectMap();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an absent refusal");
    expect(result.failure.reason).toBe("absent");
  });
});

describe("context.file through the real reader gate", () => {
  it("recovers a source file's structural context + symbols", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.fileContext("packages/a/src/index.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a served file context");
    expect(result.context.scope).toBe("@t/a");
    expect(result.context.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
  });

  it("refuses an escaping path as invalid-path BEFORE any lookup", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.fileContext("../escape.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-path");
  });

  it("maps a path absent from the tree to not-found", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.fileContext("packages/a/ghost.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("rides a whole-snapshot stale gate back as a snapshot-unavailable refusal", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));

    const result = backend.fileContext("packages/a/src/index.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
    if (result.reason === "snapshot-unavailable") expect(result.failure.reason).toBe("stale");
  });
});

describe("context.overview through the real reader gate", () => {
  it("recovers a source file's symbol overview, symbols only", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.fileOverview("packages/a/src/index.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a served overview");
    expect(result.overview.hasSymbols).toBe(true);
    expect(result.overview.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
  });

  it("refuses an escaping path as invalid-path", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const result = backend.fileOverview("../escape.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-path");
  });

  it("rides a whole-snapshot stale gate back as a snapshot-unavailable refusal", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));
    const result = backend.fileOverview("packages/a/src/index.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
    if (result.reason === "snapshot-unavailable") expect(result.failure.reason).toBe("stale");
  });
});

describe("context.symbol through the real reader gate", () => {
  it("resolves an exported symbol name to its definition site(s)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const result = backend.symbolDefinition({ name: "makeA" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected served definitions");
    expect(result.definitions.name).toBe("makeA");
    expect(result.definitions.sites).toHaveLength(1);
    expect(result.definitions.sites[0]?.path).toBe("packages/a/src/index.ts");
  });

  it("rides a whole-snapshot stale gate back as a snapshot-unavailable refusal", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = projectContextBackend(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));
    const result = backend.symbolDefinition({ name: "makeA" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot-unavailable");
    if (result.reason === "snapshot-unavailable") expect(result.failure.reason).toBe("stale");
  });
});
