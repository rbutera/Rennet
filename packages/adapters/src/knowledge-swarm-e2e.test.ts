import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessPort, HarnessSession } from "@rennet/core";
import { buildPartitions, PARTITION_WORKER_OUTPUT_SCHEMA } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeStore } from "./knowledge-store";
import { runKnowledgeSwarmForRepo, snapshotContextFromLoaded } from "./knowledge-swarm";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// ─────────────────────────────────────────────────────────────────────────────
// The PACKET E2E (task 7.2, amendment 23): the PRODUCTION orchestration —
// `runKnowledgeSwarmForRepo` over a real git repo, real generator snapshots,
// and the real on-disk knowledge store — with stub turns (no live model).
// Proves: exactly-once coverage from the real scope graph, resolving anchors,
// an advance re-running ONLY the owning partition with byte-identical carry,
// and all-or-keep-prior under injected partial failure.
// ─────────────────────────────────────────────────────────────────────────────

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

/** A two-scope workspace repo; commit 2 changes exactly ONE file in `b`. */
function workspaceRepo(): { root: string; storeDir: string; oid1: string; oid2: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-swarm-e2e-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-swarm-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  write(root, "packages/b/package.json", JSON.stringify({ name: "@t/b", private: true }));
  write(root, "packages/b/src/index.ts", "export const b = 1;\n");
  write(root, "README.md", "# t\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const oid1 = git(root, "rev-parse", "HEAD");
  write(root, "packages/b/src/index.ts", "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  const oid2 = git(root, "rev-parse", "HEAD");
  return { root, storeDir, oid1, oid2 };
}

/** Slice paths as listed in a worker prompt ("- <path>" lines under YOUR SLICE). */
function slicePathsFrom(prompt: string): string[] {
  const sliceBlock = prompt.slice(prompt.indexOf("YOUR SLICE"));
  return sliceBlock
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

/**
 * A stub Claude port running BOTH seats: a worker turn (recognized by its output
 * schema) answers one statement citing its slice's first file; the verify turn
 * answers no verdicts and no cross-cutting statements. `failFor` makes the
 * worker owning that path throw instead (the partial-failure arm).
 */
function stubPort(workerPrompts: string[], failFor?: string): HarnessPort {
  return {
    createSession: async (options: { outputSchema?: unknown }): Promise<HarnessSession> => {
      const isWorker = options.outputSchema === PARTITION_WORKER_OUTPUT_SCHEMA;
      let prompt = "";
      const session = {
        send: async (input: { prompt: string }) => {
          prompt = input.prompt;
          if (isWorker) workerPrompts.push(input.prompt);
        },
        close: async () => undefined,
        get events() {
          return (async function* () {
            if (isWorker && failFor !== undefined && prompt.includes(failFor)) {
              yield {
                kind: "error",
                error: new Error("injected worker failure"),
              };
              return;
            }
            const paths = slicePathsFrom(prompt);
            const body = isWorker
              ? {
                  statements: [
                    {
                      subject: paths[0] ?? "unknown",
                      aspect: "purpose",
                      claim: `stub knowledge about ${paths[0]}`,
                      confidence: "high",
                      evidence: [{ path: paths[0] }],
                    },
                  ],
                }
              : { verdicts: [], crossCutting: [] };
            yield {
              kind: "session.ended",
              native: {},
              outcome: { status: "completed", structuredOutput: body },
            };
          })();
        },
      };
      return session as unknown as HarnessSession;
    },
  } as unknown as HarnessPort;
}

describe("knowledge swarm — packet e2e over a real repo (stub turns, production orchestration)", () => {
  it("full run → coverage + anchors; advance → owning partition only + byte-identical carry; partial failure → prior kept", async () => {
    const { root, storeDir, oid1, oid2 } = workspaceRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const built = await generator.generate(root, { explicitBaseRef: oid1 });
    const reader = new ProjectContextReader(store);
    const knowledgeStore = new KnowledgeStore(store);
    const repoKey = built.manifest.repoKey;

    // ── Run 1: full swarm at OID1 ───────────────────────────────────────────
    const run1Prompts: string[] = [];
    const run1 = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(run1Prompts),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid1,
    });
    expect(run1.status).toBe("ok");
    if (run1.status !== "ok") return;
    expect(run1.ranPartitions).toBe(run1.totalPartitions);

    // Exactly-once coverage over the REAL snapshot's scope graph: the union of
    // the production partitions equals the inventory, pairwise disjoint.
    const gated = reader.loadFresh(repoKey, oid1);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    const snapshot = snapshotContextFromLoaded(gated.snapshot);
    const partitions = buildPartitions(snapshot);
    const seen = new Map<string, number>();
    for (const slice of partitions)
      for (const file of slice.files) seen.set(file.path, (seen.get(file.path) ?? 0) + 1);
    expect([...seen.keys()].sort()).toEqual(snapshot.files.map((f) => f.path).sort());
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    // One worker turn per partition.
    expect(run1Prompts).toHaveLength(partitions.length);

    // Every emitted statement's anchors RESOLVE against the snapshot inventory
    // (the mint stamped the authoritative blobOid).
    const inventory = new Map(snapshot.files.map((f) => [f.path, f.blobOid]));
    expect(run1.set.statements.length).toBeGreaterThan(0);
    for (const statement of run1.set.statements)
      for (const anchor of statement.evidence)
        expect(anchor.blobOid).toBe(inventory.get(anchor.path));

    // ── Run 2: baseline advance at OID2 (one changed file in packages/b) ────
    await generator.generate(root, { explicitBaseRef: oid2 });
    const run2Prompts: string[] = [];
    const run2 = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(run2Prompts),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid2,
    });
    expect(run2.status).toBe("ok");
    if (run2.status !== "ok") return;
    // ONLY the partition owning the changed path re-ran.
    expect(run2Prompts).toHaveLength(1);
    expect(run2Prompts[0]).toContain("packages/b/src/index.ts");
    expect(run2Prompts[0]).not.toContain("packages/a/src/index.ts");
    expect(run2.ranPartitions).toBe(1);
    expect(run2.carried).toBeGreaterThan(0);
    // Carry is BYTE-IDENTICAL for statements OUTSIDE the re-run partition (a
    // re-run worker may legitimately re-mint an identical claim fresh, which
    // wins the id-collision dedup with a new learnedAgainst stamp).
    const run2ById = new Map(run2.set.statements.map((s) => [s.id, s]));
    let carriedChecked = 0;
    for (const statement of run1.set.statements) {
      if (statement.evidence.some((a) => a.path.startsWith("packages/b/"))) continue;
      expect(run2ById.get(statement.id)).toEqual(statement);
      carriedChecked += 1;
    }
    expect(carriedChecked).toBeGreaterThan(0);

    // ── Run 3: injected partial failure keeps the prior store ───────────────
    write(root, "packages/a/src/index.ts", "export const a = 3;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "three");
    const oid3 = git(root, "rev-parse", "HEAD");
    await generator.generate(root, { explicitBaseRef: oid3 });
    const run3 = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort([], "packages/a/src/index.ts"),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid3,
    });
    expect(run3.status).toBe("failed");
    if (run3.status === "failed") expect(run3.reason).toContain("partition workers failed");
    // All-or-keep-prior: the store still serves run 2's set, untouched.
    expect(knowledgeStore.loadLocal(repoKey)).toEqual(run2.set);
  });

  // ── Cross-tier delta routing, through the LIVE caller ─────────────────────
  //
  // The regression this pins: the swarm rebuilds PRIOR ownership with the
  // hierarchical `buildPartitions` ids while the CURRENT set is module batches
  // (`mod:<path>#<hash>`). Routing an orphaned (deleted) path by id family alone
  // can never match a module batch, so a deleted connected file used to route
  // ZERO module workers — the neighbourhood around the deletion was never
  // re-examined. `routeDelta`'s nearest-surviving-directory rule is what fixes it.
  it("a DELETED connected file re-runs the module batch holding its surviving neighbours", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-swarm-orphan-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-swarm-orphan-store-"));
    scratch.push(root, storeDir);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
    write(
      root,
      "packages/a/src/index.ts",
      'import { one } from "./one";\nexport const idx = one;\n',
    );
    write(root, "packages/a/src/one.ts", 'import { two } from "./two";\nexport const one = two;\n');
    write(root, "packages/a/src/two.ts", "export const two = 2;\n");
    write(root, "packages/b/package.json", JSON.stringify({ name: "@t/b", private: true }));
    write(root, "packages/b/src/index.ts", "export const b = 1;\n");
    write(root, "README.md", "# t\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const oid1 = git(root, "rev-parse", "HEAD");

    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const built = await generator.generate(root, { explicitBaseRef: oid1 });
    const reader = new ProjectContextReader(store);
    const knowledgeStore = new KnowledgeStore(store);
    const repoKey = built.manifest.repoKey;

    const run1Prompts: string[] = [];
    const run1 = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(run1Prompts),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid1,
    });
    expect(run1.status).toBe("ok");
    // The three connected sources really did batch as a module (not the fallback).
    expect(run1Prompts.some((prompt) => prompt.includes("packages/a/src/two.ts"))).toBe(true);

    // Delete ONE connected file and leave its importer's now-dangling specifier
    // alone, so the ONLY changed path is the deleted one — which isolates the
    // orphan-routing rule from ordinary "the changed file's own slice re-runs".
    rmSync(join(root, "packages/a/src/two.ts"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "delete two");
    const oid2 = git(root, "rev-parse", "HEAD");
    await generator.generate(root, { explicitBaseRef: oid2 });

    const run2Prompts: string[] = [];
    const run2 = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(run2Prompts),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid2,
    });
    expect(run2.status).toBe("ok");
    // The neighbourhood the deletion sat in re-runs: the module batch holding the
    // surviving files of `packages/a/src`.
    expect(run2Prompts.some((prompt) => prompt.includes("packages/a/src/one.ts"))).toBe(true);
    // …and the unrelated package does NOT.
    expect(run2Prompts.some((prompt) => prompt.includes("packages/b/src/index.ts"))).toBe(false);
  });
});
