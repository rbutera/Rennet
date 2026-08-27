import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvocationBudget,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessPort,
  type HarnessSession,
} from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  createKnowledgeRunTurn,
  enrichKnowledgeForRepo,
  runKnowledgeDeltaForRepo,
} from "./knowledge-enrichment";
import { KnowledgeStore } from "./knowledge-store";
import { changedPathsBetween, snapshotContextFromLoaded } from "./knowledge-swarm";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { createMetricsCollector } from "./turn-metrics";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

// ── A scripted fake harness that emits a knowledge body ──────────────────────
function fakePort(body: unknown, usage?: Record<string, unknown>): HarnessPort {
  const started: HarnessEvent = {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: null,
    receivedAt: 0,
    native: {},
    kind: "session.started",
    model: "claude-fake",
    cwd: "/repo",
    tools: [],
    apiKeySource: "none",
  };
  const ended: HarnessEvent = {
    seq: 2,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: usage ? { usage } : {},
    kind: "session.ended",
    outcome: { status: "completed", finalText: "", structuredOutput: body },
  };
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health: (): Promise<HarnessHealth> => Promise.resolve({ state: "ready", version: "2.1.0" }),
    createSession: (): Promise<HarnessSession> =>
      Promise.resolve({
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            yield started;
            yield ended;
          },
        },
        send: (): Promise<string> => Promise.resolve("t1"),
        interrupt: (): Promise<void> => Promise.resolve(),
        close: (): Promise<void> => Promise.resolve(),
      }),
  };
}

async function seedSnapshot() {
  const root = mkdtempSync(join(tmpdir(), "rennet-ke-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-kestore-"));
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
  return { root, store, generator, reader, knowledgeStore, manifest, oid };
}

const KNOWLEDGE_BODY = {
  statements: [
    {
      subject: "@t/a",
      aspect: "purpose",
      claim: "scope a exports a constant",
      confidence: "high",
      evidence: [{ path: "packages/a/src/index.ts" }],
    },
  ],
};

describe("snapshotContextFromLoaded", () => {
  it("projects a loaded snapshot into the enrichment context", async () => {
    const { reader, manifest } = await seedSnapshot();
    const gated = reader.loadFresh(manifest.repoKey, manifest.baseOid);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    const ctx = snapshotContextFromLoaded(gated.snapshot);
    expect(ctx.repoKey).toBe(manifest.repoKey);
    expect(ctx.baseOid).toBe(manifest.baseOid);
    expect(ctx.files.some((f) => f.path === "packages/a/src/index.ts")).toBe(true);
    expect(ctx.scopes.map((s) => s.name)).toContain("@t/a");
  });
});

describe("createKnowledgeRunTurn", () => {
  it("maps a completed session to an emitted body and records a cost metric", async () => {
    const collector = createMetricsCollector();
    const runTurn = createKnowledgeRunTurn(
      fakePort(KNOWLEDGE_BODY, {
        input_tokens: 2,
        output_tokens: 40,
        cache_creation_input_tokens: 5000,
      }),
      { cwd: "/repo" },
      collector,
      "knowledge.initial",
    );
    const result = await runTurn("prompt", 0);
    expect(result.status).toBe("emitted");
    expect(collector.metrics).toHaveLength(1);
    const m = collector.metrics[0];
    expect(m?.label).toBe("knowledge.initial");
    expect(m?.model).toBe("claude-fake");
    expect(m?.apiKeySource).toBe("none");
    expect(m?.usage?.totalTokens).toBe(5042);
  });
});

describe("enrichKnowledgeForRepo", () => {
  it("runs the model turn and persists the enriched set", async () => {
    const { reader, knowledgeStore, manifest, root } = await seedSnapshot();
    const outcome = await enrichKnowledgeForRepo({
      reader,
      knowledgeStore,
      port: fakePort(KNOWLEDGE_BODY),
      repoKey: manifest.repoKey,
      repoRoot: root,
      baseOid: manifest.baseOid,
      budget: createInvocationBudget(2),
    });
    expect(outcome.status).toBe("ok");
    const saved = knowledgeStore.loadLocal(manifest.repoKey);
    expect(saved?.statements).toHaveLength(1);
    expect(saved?.statements[0]?.status).toBe("hypothesis");
    // The anchor was stamped with the authoritative blobOid from the snapshot.
    expect(saved?.statements[0]?.evidence[0]?.path).toBe("packages/a/src/index.ts");
  });

  it("is snapshot-unavailable (never a fabricated set) when the snapshot is stale", async () => {
    const { reader, knowledgeStore, manifest, root } = await seedSnapshot();
    const outcome = await enrichKnowledgeForRepo({
      reader,
      knowledgeStore,
      port: fakePort(KNOWLEDGE_BODY),
      repoKey: manifest.repoKey,
      repoRoot: root,
      baseOid: "0".repeat(40),
      budget: createInvocationBudget(2),
    });
    expect(outcome.status).toBe("snapshot-unavailable");
    expect(knowledgeStore.loadLocal(manifest.repoKey)).toBeNull();
  });
});

describe("changedPathsBetween", () => {
  it("returns the changed-path closure between two commits", async () => {
    const { root, oid } = await seedSnapshot();
    write(root, "packages/a/src/index.ts", "export const a = 2;\n");
    write(root, "packages/a/src/new.ts", "export const n = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");
    const head = git(root, "rev-parse", "HEAD");
    const changed = await changedPathsBetween(execaGit, root, oid, head);
    expect(changed.sort()).toEqual(["packages/a/src/index.ts", "packages/a/src/new.ts"]);
  });

  it("is empty when from == to", async () => {
    const { root, oid } = await seedSnapshot();
    expect(await changedPathsBetween(execaGit, root, oid, oid)).toEqual([]);
  });
});

describe("runKnowledgeDeltaForRepo", () => {
  it("requires a prior set", async () => {
    const { reader, knowledgeStore, manifest, root, oid } = await seedSnapshot();
    const outcome = await runKnowledgeDeltaForRepo({
      reader,
      knowledgeStore,
      port: fakePort(KNOWLEDGE_BODY),
      repoKey: manifest.repoKey,
      repoRoot: root,
      baseOid: manifest.baseOid,
      fromOid: oid,
      budget: createInvocationBudget(2),
    });
    expect(outcome.status).toBe("no-prior-set");
  });

  it("advances the set on a real baseline move, carrying survivors + re-adjudicating changes", async () => {
    const { reader, knowledgeStore, generator, manifest, root, oid } = await seedSnapshot();
    // Initial enrichment against the base.
    await enrichKnowledgeForRepo({
      reader,
      knowledgeStore,
      port: fakePort(KNOWLEDGE_BODY),
      repoKey: manifest.repoKey,
      repoRoot: root,
      baseOid: manifest.baseOid,
      budget: createInvocationBudget(2),
    });

    // Advance the branch: change the cited file, add a new one, regenerate the snapshot.
    write(root, "packages/a/src/index.ts", "export const a = 99;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change a");
    const head = git(root, "rev-parse", "HEAD");
    await generator.generate(root, { explicitBaseRef: head });

    const outcome = await runKnowledgeDeltaForRepo({
      reader,
      knowledgeStore,
      port: fakePort({
        statements: [
          {
            subject: "@t/a",
            aspect: "purpose",
            claim: "scope a now exports 99",
            confidence: "high",
            evidence: [{ path: "packages/a/src/index.ts" }],
          },
        ],
      }),
      repoKey: manifest.repoKey,
      repoRoot: root,
      baseOid: head,
      fromOid: oid,
      budget: createInvocationBudget(2),
    });
    expect(outcome.status).toBe("ok");
    const saved = knowledgeStore.loadLocal(manifest.repoKey);
    expect(saved?.baseOid).toBe(head);
    expect(saved?.statements.some((s) => s.claim === "scope a now exports 99")).toBe(true);
  });
});
