import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasOpsBackend,
  canvasOpsTool,
  type OpsEnvelope,
  type ToolOutcome,
} from "@rennet/core";
import type { NoveltyLedger, PatchFile, Patchset, ProjectSnapshotManifest } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noveltyBackend, type ResolvedNoveltyContext } from "./novelty-ledger-backend";
import { NoveltyLedgerReader } from "./novelty-ledger-reader";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ─────────────────────────────────────────────────────────────────────────────
// The FULL novelty-read path, end to end: a real generated ProjectSnapshot →
// ProjectContextReader (fail-closed gate) → NoveltyLedgerReader → noveltyBackend
// (the port slice) → the REGISTERED core `context.novelty` tool → the canvasOps@2
// envelope. This proves the registered tool returns a correct ledger through the
// gate over a real snapshot + patchset, and that a stale/absent snapshot surfaces
// as the right canvasOps freshness verdict — not a mock of the reader. A broken
// freshness reconciliation makes the stale/absent cases go RED.
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
  const root = mkdtempSync(join(tmpdir(), "rennet-novbe-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-novbe-store-"));
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
  write(root, "packages/a/src/index.test.ts", "import { a } from './index';\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  const store = new ProjectSnapshotStore(storeDir);
  const generator = new ProjectSnapshotGenerator({ store });
  const { manifest } = await generator.generate(root, { explicitBaseRef: oid });
  return { store, manifest };
}

function patchFile(over: Partial<PatchFile> & Pick<PatchFile, "path" | "status">): PatchFile {
  return { previousPath: undefined, additions: 1, deletions: 0, binary: false, patch: "", ...over };
}

/** A patchset pinned to `baseOid` (the snapshot-coupling contract), with a real change. */
function patchset(baseOid: string): Patchset {
  return {
    id: "patchset-be-1",
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: {
      id: "repo-1",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid,
      headOid: "oid-head",
    },
    files: [
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
    ],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

/**
 * The `context.novelty` tool only ever reaches `novelty()`; the rest of the
 * `CanvasOpsBackend` is not exercised, so a slice-plus-throwing-stub is an honest
 * full backend for this focused path (a wrong call throws loudly).
 */
function backendFor(
  reader: NoveltyLedgerReader,
  resolve: () => ResolvedNoveltyContext,
): CanvasOpsBackend {
  const slice = noveltyBackend(reader, resolve);
  const notUsed = () => {
    throw new Error("non-novelty backend accessor called in a novelty-only test");
  };
  return new Proxy(slice as Partial<CanvasOpsBackend>, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return notUsed;
    },
  }) as CanvasOpsBackend;
}

function okEnvelope<T>(outcome: ToolOutcome<T> | Promise<ToolOutcome<T>>): OpsEnvelope<T> {
  if (outcome instanceof Promise) throw new Error("expected a synchronous tool outcome");
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome.error)}`);
  return outcome.envelope;
}

describe("context.novelty through the real reader gate", () => {
  it("serves the deterministic ledger for the change at the pinned base OID as `current`", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));
    const ps = patchset(manifest.baseOid);
    const backend = backendFor(reader, () => ({ repoKey: manifest.repoKey, patchset: ps }));

    const env = okEnvelope(canvasOpsTool("context.novelty").handle({}, backend));
    const ledger = env.data as NoveltyLedger;
    expect(env.freshness).toBe("current");
    expect(ledger.baseOid).toBe(manifest.baseOid);
    expect(ledger.snapshotFingerprint).toBe(manifest.fingerprint);
    expect(ledger.patchsetId).toBe(ps.id);
    expect(env.evidence).toEqual([manifest.baseOid, manifest.fingerprint, ps.id]);

    const at = (path: string, kind: "file" | "symbol", symbol?: string) =>
      ledger.entries.find(
        (e) => e.unit.path === path && e.unit.kind === kind && e.unit.symbol === symbol,
      );
    expect(at("packages/a/src/index.ts", "file")?.classification).toBe("extends");
    expect(at("packages/a/src/index.ts", "symbol", "makeC")?.classification).toBe("novel");
    expect(at("packages/a/src/index.ts", "symbol", "makeA")?.classification).toBe("extends");
    expect(at("packages/a/src/added.ts", "file")?.classification).toBe("novel");
    expect(at("packages/a/src/added.test.ts", "file")?.classification).toBe("conforms");
  });

  it("rides a STALE snapshot back as freshness `stale`, never a served ledger (R30)", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));
    // The patchset pins a DIFFERENT base OID than the snapshot was built at.
    const ps = patchset("0000000000000000000000000000000000000000");
    const backend = backendFor(reader, () => ({ repoKey: manifest.repoKey, patchset: ps }));

    const env = okEnvelope(canvasOpsTool("context.novelty").handle({}, backend));
    expect(env.freshness).toBe("stale");
    const data = env.data as { unavailable: { reason: string; storedBaseOid?: string } };
    expect(data.unavailable.reason).toBe("stale");
    expect(data.unavailable.storedBaseOid).toBe(manifest.baseOid);
    // The distinguished refusal never masquerades as a served ledger.
    expect((env.data as { baseOid?: string }).baseOid).toBeUndefined();
    expect((env.data as { entries?: unknown }).entries).toBeUndefined();
  });

  it("maps an ABSENT snapshot (unknown repo) to freshness `failed`", async () => {
    const { store, manifest } = await generate();
    const reader = new NoveltyLedgerReader(new ProjectContextReader(store));
    const ps = patchset(manifest.baseOid);
    const backend = backendFor(reader, () => ({ repoKey: "/no/such/repo/.git", patchset: ps }));

    const env = okEnvelope(canvasOpsTool("context.novelty").handle({}, backend));
    expect(env.freshness).toBe("failed");
    expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("absent");
  });
});
