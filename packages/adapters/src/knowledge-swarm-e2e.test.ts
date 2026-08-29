import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessPort, HarnessSession, LoadedSnapshot } from "@rennet/core";
import {
  buildPartitions,
  KNOWLEDGE_SWARM_GENERATOR_ID,
  PARTITION_WORKER_OUTPUT_SCHEMA,
  partitionsFromSnapshot,
} from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JournalTarget, KnowledgeJournal } from "./knowledge-journal";
import { KNOWLEDGE_FILE, KnowledgeStore } from "./knowledge-store";
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

/** The journal target a run at this snapshot writes and reads under. */
function targetOf(snapshot: LoadedSnapshot): JournalTarget {
  return {
    baseOid: snapshot.manifest.baseOid,
    snapshotFingerprint: snapshot.manifest.fingerprint,
    generator: KNOWLEDGE_SWARM_GENERATOR_ID,
  };
}

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

/**
 * Slice paths as listed in a worker prompt ("- <path>" lines under YOUR SLICE).
 *
 * Bounded at the IMPORTS heading: since W3 the packet's later sections use the same
 * `- ` bullet for edges and neighbours, and reading to the end of the prompt would
 * hand this helper `src/a.ts -> src/b.ts` as if it were a file in the slice.
 */
function slicePathsFrom(prompt: string): string[] {
  const start = prompt.indexOf("YOUR SLICE");
  const end = prompt.indexOf("IMPORTS WITHIN THIS SLICE");
  const sliceBlock = prompt.slice(start, end < 0 ? undefined : end);
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

    // The packet is SKELETON-FED from the real snapshot, not a bare path list: the
    // TypeScript file shows its declared symbol with a line, and the `.md` — which
    // the v5 shard family indexes and finds nothing in — says so instead of showing
    // an empty structure that could be read as "this file declares nothing useful".
    const tsPacket = run1Prompts.find((prompt) => prompt.includes("packages/a/src/index.ts")) ?? "";
    expect(tsPacket).toMatch(/^ {4}a \(const\) L1$/m);
    const mdPacket = run1Prompts.find((prompt) => prompt.includes("README.md")) ?? "";
    expect(mdPacket).toContain("README.md\n    (indexed; declares no top-level symbols)");

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
    const storePath = join(store.paths(repoKey).knowledgeDir, KNOWLEDGE_FILE);
    const before = readFileSync(storePath, "utf8");
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
    // All-or-keep-prior: the store still serves run 2's set, untouched — asserted on
    // the BYTES, so a rewrite that happened to reproduce an equal set would still show.
    expect(readFileSync(storePath, "utf8")).toBe(before);
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
    const modulePacket =
      run1Prompts.find((prompt) => prompt.includes("packages/a/src/two.ts")) ?? "";
    expect(modulePacket).not.toBe("");
    // …and its packet carries the batch's OWN resolved edges, from the real import
    // shard — the deterministic front half reaching the worker.
    expect(modulePacket).toContain("packages/a/src/index.ts -> packages/a/src/one.ts");
    expect(modulePacket).toContain("packages/a/src/one.ts -> packages/a/src/two.ts");

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

  // ── The journal lifecycle (#581), against a real store on disk ─────────────

  it("journals completed batches through a failure, reuses them on the re-run, and promotes once", async () => {
    const { root, storeDir, oid1 } = workspaceRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const built = await generator.generate(root, { explicitBaseRef: oid1 });
    const reader = new ProjectContextReader(store);
    const knowledgeStore = new KnowledgeStore(store);
    const repoKey = built.manifest.repoKey;
    const journalDir = knowledgeStore.journalDir(repoKey);
    const storePath = join(store.paths(repoKey).knowledgeDir, KNOWLEDGE_FILE);

    // Every entry under every TARGET directory — the journal is partitioned per
    // target now, so a flat read of the root would count zero and pass vacuously.
    const journalEntries = (): string[] => {
      try {
        return readdirSync(journalDir, { recursive: true, encoding: "utf8" }).filter((name) =>
          name.endsWith(".json"),
        );
      } catch {
        return [];
      }
    };
    const storeBytes = (): string | null => {
      try {
        return readFileSync(storePath, "utf8");
      } catch {
        return null;
      }
    };

    // ── Attempt 1: one worker always fails ──────────────────────────────────
    expect(storeBytes()).toBeNull();
    const failedPrompts: string[] = [];
    const failed = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(failedPrompts, "packages/a/src/index.ts"),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid1,
    });
    expect(failed.status).toBe("failed");
    if (failed.status !== "failed") return;
    expect(failed.failedSlices?.length).toBe(1);

    // THE P1 INVARIANT: a partial set never presents as complete. The live store
    // was not written at all — not a partial set, not an empty one.
    expect(storeBytes()).toBeNull();
    expect(knowledgeStore.loadLocal(repoKey)).toBeNull();

    // …and the batches that DID complete are on disk, outside the store.
    const gated = reader.loadFresh(repoKey, oid1);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    const totalSlices = partitionsFromSnapshot(gated.snapshot).length;
    expect(totalSlices).toBeGreaterThan(1);
    const journaled = journalEntries();
    expect(journaled).toHaveLength(totalSlices - 1);
    expect(failed.journaled).toBe(journaled.length);
    // Every non-failing batch really ran (they were not abandoned behind the failure).
    expect(failedPrompts.filter((p) => p.includes("packages/b/src/index.ts"))).toHaveLength(1);

    // ── Attempt 2: the same target, nothing failing ─────────────────────────
    const retryPrompts: string[] = [];
    const promoted = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort(retryPrompts),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid1,
    });
    expect(promoted.status).toBe("ok");
    if (promoted.status !== "ok") return;

    // Only the batch that failed re-ran; the journaled ones cost no turn.
    expect(retryPrompts).toHaveLength(1);
    expect(retryPrompts[0]).toContain("packages/a/src/index.ts");
    expect(promoted.reusedPartitions).toBe(journaled.length);
    expect(promoted.ranPartitions).toBe(journaled.length + 1);

    // The whole set reached the store, and it carries the REUSED batches' claims —
    // reuse is real work recovered, not a skipped batch quietly dropped.
    const stored = knowledgeStore.loadLocal(repoKey);
    expect(stored).not.toBeNull();
    expect(stored?.statements.length).toBe(promoted.set.statements.length);
    const paths = stored?.statements.flatMap((s) => s.evidence.map((a) => a.path)) ?? [];
    expect(paths.some((path) => path.startsWith("packages/b/"))).toBe(true);

    // Promoted ⇒ the journal has nothing left to protect.
    expect(journalEntries()).toHaveLength(0);
  });

  it("refuses a journal entry from a DIFFERENT baseline", async () => {
    // Reuse is keyed on baseOid + slice id + membership, and `read` re-checks the
    // baseline recorded INSIDE the file. Without both, an advance would be served a
    // batch produced at the baseline before it: a slice whose own files did not
    // change still had a different packet, because its neighbour map did.
    //
    // What this test proves and what it does not: removing EITHER guard alone still
    // passes, because the other catches it. It reddens when both go. So it pins the
    // property, not the mechanism — the key alone is not shown to be load-bearing
    // here, and a future edit that drops it will not be caught by this test.
    const { root, storeDir, oid1, oid2 } = workspaceRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const built = await generator.generate(root, { explicitBaseRef: oid1 });
    const reader = new ProjectContextReader(store);
    const knowledgeStore = new KnowledgeStore(store);
    const repoKey = built.manifest.repoKey;

    const first = await runKnowledgeSwarmForRepo({
      reader,
      knowledgeStore,
      claudePort: stubPort([], "packages/a/src/index.ts"),
      codexExecutor: null,
      repoKey,
      repoRoot: root,
      baseOid: oid1,
    });
    expect(first.status).toBe("failed");
    const journalDir = knowledgeStore.journalDir(repoKey);
    expect(readdirSync(journalDir).length).toBeGreaterThan(0);

    // Advance the baseline. The journal still holds oid1's entries.
    await generator.generate(root, { explicitBaseRef: oid2 });
    const journal = new KnowledgeJournal(journalDir);
    const atOid2 = reader.loadFresh(repoKey, oid2);
    expect(atOid2.ok).toBe(true);
    if (!atOid2.ok) return;
    for (const slice of partitionsFromSnapshot(atOid2.snapshot)) {
      expect(journal.read(targetOf(atOid2.snapshot), slice)).toBeNull();
    }
    // The control: at the baseline they were written FOR, the same entries resolve.
    const atOid1 = reader.loadFresh(repoKey, oid1);
    expect(atOid1.ok).toBe(true);
    if (!atOid1.ok) return;
    const resolved = partitionsFromSnapshot(atOid1.snapshot).filter(
      (slice) => journal.read(targetOf(atOid1.snapshot), slice) !== null,
    );
    expect(resolved.length).toBeGreaterThan(0);

    // ── And the same refusal for the OTHER two thirds of the target ──────────
    //
    // The baseline is one of three things a journal entry is keyed on. A prompt
    // rework or a re-extraction at an UNCHANGED baseline changes what the worker was
    // asked, so its old answer is an answer to a different question — and unlike the
    // baseline case there is nothing else to catch it.
    const live = targetOf(atOid1.snapshot);
    const reusable = partitionsFromSnapshot(atOid1.snapshot).filter(
      (slice) => journal.read(live, slice) !== null,
    );
    expect(reusable.length).toBeGreaterThan(0);
    for (const slice of reusable) {
      expect(journal.read({ ...live, generator: "knowledge-swarm@1" }, slice)).toBeNull();
      expect(journal.read({ ...live, snapshotFingerprint: "re-extracted" }, slice)).toBeNull();
    }
  });
});
