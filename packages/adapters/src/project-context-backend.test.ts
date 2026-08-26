import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasOpsBackend,
  canvasOpsTool,
  type OpsEnvelope,
  type ProjectMap,
  type ToolOutcome,
} from "@rennet/core";
import type { ProjectSnapshotManifest } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { projectContextBackend, type ResolvedRepoContext } from "./project-context-backend";
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

/**
 * The context tools only ever reach `projectMap` / `fileContext`; the rest of the
 * `CanvasOpsBackend` is not exercised, so a slice-plus-throwing-stub is an honest
 * full backend for this focused path (a wrong call throws loudly rather than
 * silently passing).
 */
function backendFor(
  reader: ProjectContextReader,
  resolve: () => ResolvedRepoContext,
): CanvasOpsBackend {
  const slice = projectContextBackend(reader, resolve);
  const notUsed = () => {
    throw new Error("non-context backend accessor called in a context-only test");
  };
  return new Proxy(slice as Partial<CanvasOpsBackend>, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return notUsed;
    },
  }) as CanvasOpsBackend;
}

/** Narrow a (now possibly-async) tool handle result: these context reads are all sync. */
function sync<T>(outcome: ToolOutcome<T> | Promise<ToolOutcome<T>>): ToolOutcome<T> {
  if (outcome instanceof Promise) throw new Error("expected a synchronous tool outcome");
  return outcome;
}

function okEnvelope<T>(outcome: ToolOutcome<T> | Promise<ToolOutcome<T>>): OpsEnvelope<T> {
  const settled = sync(outcome);
  if (!settled.ok) throw new Error(`expected ok, got ${JSON.stringify(settled.error)}`);
  return settled.envelope;
}

describe("context.map through the real reader gate", () => {
  it("serves the deterministic map at the resolved base OID as `current`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(canvasOpsTool("context.map").handle({}, backend));
    const map = env.data as ProjectMap;
    expect(env.freshness).toBe("current");
    expect(map.baseOid).toBe(manifest.baseOid);
    expect(map.fingerprint).toBe(manifest.fingerprint);
    expect(map.scopes.map((s) => s.name)).toContain("@t/a");
    expect(env.evidence).toEqual([manifest.baseOid, manifest.fingerprint]);
  });

  it("narrows to a workspace scope through the port", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(canvasOpsTool("context.map").handle({ scope: "@t/a" }, backend));
    const map = env.data as ProjectMap;
    expect(map.scopes.map((s) => s.name)).toEqual(["@t/a"]);
    expect(map.files.every((f) => f.path.startsWith("packages/a/"))).toBe(true);
  });

  it("rides a STALE snapshot back as freshness `stale`, never a served map (R30)", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    // Resolve to a DIFFERENT base OID than the snapshot was built at.
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));

    const env = okEnvelope(canvasOpsTool("context.map").handle({}, backend));
    expect(env.freshness).toBe("stale");
    const data = env.data as { unavailable: { reason: string; storedBaseOid?: string } };
    expect(data.unavailable.reason).toBe("stale");
    expect(data.unavailable.storedBaseOid).toBe(manifest.baseOid);
    expect((env.data as { baseOid?: string }).baseOid).toBeUndefined();
  });

  it("maps an ABSENT snapshot (unknown repo) to freshness `failed`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: "/no/such/repo/.git",
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(canvasOpsTool("context.map").handle({}, backend));
    expect(env.freshness).toBe("failed");
    expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("absent");
  });
});

describe("context.file through the real reader gate", () => {
  it("recovers a source file's structural context + symbols as `current`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(
      canvasOpsTool("context.file").handle({ path: "packages/a/src/index.ts" }, backend),
    );
    expect(env.freshness).toBe("current");
    const ctx = env.data as { scope: string | null; symbols: Array<{ name: string }> };
    expect(ctx.scope).toBe("@t/a");
    expect(ctx.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
  });

  it("refuses an escaping path as invalid-input BEFORE any lookup", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const outcome = sync(canvasOpsTool("context.file").handle({ path: "../escape.ts" }, backend));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid-input");
  });

  it("maps a path absent from the tree to not-found", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const outcome = sync(
      canvasOpsTool("context.file").handle({ path: "packages/a/ghost.ts" }, backend),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");
  });

  it("rides a whole-snapshot stale gate back as freshness `stale`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));

    const env = okEnvelope(
      canvasOpsTool("context.file").handle({ path: "packages/a/src/index.ts" }, backend),
    );
    expect(env.freshness).toBe("stale");
    expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
  });
});

describe("context.overview through the real reader gate", () => {
  it("recovers a source file's symbol overview as `current`, symbols only", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(
      canvasOpsTool("context.overview").handle({ path: "packages/a/src/index.ts" }, backend),
    );
    expect(env.freshness).toBe("current");
    const data = env.data as { hasSymbols: boolean; symbols: Array<{ name: string }> };
    expect(data.hasSymbols).toBe(true);
    expect(data.symbols.map((s) => s.name).sort()).toEqual(["a", "makeA"]);
    // The evidence is the blob identity the symbols were recovered from.
    expect(env.evidence).toHaveLength(1);
  });

  it("refuses an escaping path as invalid-input", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const outcome = sync(
      canvasOpsTool("context.overview").handle({ path: "../escape.ts" }, backend),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid-input");
  });

  it("rides a whole-snapshot stale gate back as freshness `stale`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));
    const env = okEnvelope(
      canvasOpsTool("context.overview").handle({ path: "packages/a/src/index.ts" }, backend),
    );
    expect(env.freshness).toBe("stale");
    expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
  });
});

describe("context.symbol through the real reader gate", () => {
  it("resolves an exported symbol name to its definition site(s) as `current`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));

    const env = okEnvelope(canvasOpsTool("context.symbol").handle({ name: "makeA" }, backend));
    expect(env.freshness).toBe("current");
    const data = env.data as { name: string; sites: Array<{ path: string; line: number }> };
    expect(data.name).toBe("makeA");
    expect(data.sites).toHaveLength(1);
    expect(data.sites[0]?.path).toBe("packages/a/src/index.ts");
    expect(env.evidence).toEqual(["packages/a/src/index.ts:2"]);
  });

  it("refuses a missing name arg as invalid-input", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: manifest.baseOid,
    }));
    const outcome = sync(canvasOpsTool("context.symbol").handle({}, backend));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid-input");
  });

  it("rides a whole-snapshot stale gate back as freshness `stale`", async () => {
    const { store, manifest } = await generate();
    const reader = new ProjectContextReader(store);
    const backend = backendFor(reader, () => ({
      repoKey: manifest.repoKey,
      baseOid: "0000000000000000000000000000000000000000",
    }));
    const env = okEnvelope(canvasOpsTool("context.symbol").handle({ name: "makeA" }, backend));
    expect(env.freshness).toBe("stale");
    expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
  });
});
