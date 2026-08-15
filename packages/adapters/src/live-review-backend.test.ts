import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewCanvases,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessPort,
  type HarnessSession,
  type ProjectMap,
} from "@rennet/core";
import { sha256Hex } from "@rennet/protocol";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type NoveltyLedger,
  type PatchFile,
  type Patchset,
  type Review,
} from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManifestStore } from "./context-manifest-store";
import { KnowledgeStore } from "./knowledge-store";
import {
  buildReviewContextManifest,
  createLiveCanvasOpsBackend,
  ensureReviewContextAssembly,
  projectHypothesisRepoContext,
  repoRecordOf,
} from "./live-review-backend";
import { NoveltyLifecycleRegistry } from "./novelty-lifecycle-registry";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// ─────────────────────────────────────────────────────────────────────────────
// The live end-to-end proof (issue #13): a production CanvasOpsBackend composed
// over a REAL git repo. The snapshot is generated on open at the review's pinned
// base OID, so context.map / context.file / context.novelty serve REAL
// snapshot-derived data. And the fail-closed contract: with no snapshot the repo
// map refuses (typed absent/stale) while the lenses (canvas/decomposition) render
// unaffected. Everything runs against a real temporary git repository — no fakes.
// ─────────────────────────────────────────────────────────────────────────────

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

/** A minimal pnpm workspace repo with two commits on `main` (oid1 then oid2). */
function workspaceRepo(): { root: string; commonDir: string; oid1: string; oid2: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-live-backend-"));
  scratch.push(root);
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
  write(
    root,
    "packages/a/project.json",
    JSON.stringify({ name: "t-a", sourceRoot: "packages/a/src", projectType: "library" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  const oid1 = git(root, "rev-parse", "HEAD");

  write(root, "packages/a/src/extra.ts", "export const extra = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "second");
  const oid2 = git(root, "rev-parse", "HEAD");

  return { root, commonDir: join(root, ".git"), oid1, oid2 };
}

/** A patchset pinned to `baseOid`, carrying a synthetic reviewable change. */
function patchsetAt(root: string, commonDir: string, baseOid: string): Patchset {
  const patch = `@@ -1,2 +1,4 @@
 export const a = 1;
+export const added = 3;
+export function moreA() {}
 export function makeA() {}`;
  const files: PatchFile[] = [
    {
      path: "packages/a/src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      binary: false,
      patch,
    },
  ];
  return {
    id: `ps-${baseOid.slice(0, 8)}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: { id: "repo", root, commonDir, baseRef: baseOid, baseOid, headOid: baseOid },
    files,
    rawDiff: patch,
    byteLength: patch.length,
    truncated: false,
  };
}

async function reviewAt(root: string, commonDir: string, baseOid: string) {
  const patchset = patchsetAt(root, commonDir, baseOid);
  const review: Review = {
    id: `review-${baseOid.slice(0, 8)}`,
    repositoryRoot: root,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
  const pipeline = await buildReviewCanvases({ reviewId: review.id, patchset, dispositions: [] });
  return { review, pipeline };
}

function freshStore(): ProjectSnapshotStore {
  const dir = mkdtempSync(join(tmpdir(), "rennet-live-store-"));
  scratch.push(dir);
  return new ProjectSnapshotStore(dir);
}

function askPort(body: unknown): HarnessPort {
  const events: HarnessEvent[] = [
    {
      seq: 1,
      harness: "claude-code",
      sessionId: "ask-session",
      turnId: null,
      receivedAt: 0,
      native: {},
      kind: "session.started",
      model: "claude-fake",
      cwd: "/repo",
      tools: [],
      apiKeySource: "none",
    },
    {
      seq: 2,
      harness: "claude-code",
      sessionId: "ask-session",
      turnId: "ask-turn",
      receivedAt: 0,
      native: {},
      kind: "session.ended",
      outcome: { status: "completed", finalText: "", structuredOutput: body },
    },
  ];
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health: (): Promise<HarnessHealth> => Promise.resolve({ state: "ready", version: "test" }),
    createSession: (): Promise<HarnessSession> =>
      Promise.resolve({
        id: "ask-session",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            yield* events;
          },
        },
        send: (): Promise<string> => Promise.resolve("ask-turn"),
        interrupt: (): Promise<void> => Promise.resolve(),
        close: (): Promise<void> => Promise.resolve(),
      }),
  };
}

async function seedAskKnowledge(
  repo: ReturnType<typeof workspaceRepo>,
  store: ProjectSnapshotStore,
): Promise<void> {
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(repo.root, {
    explicitBaseRef: repo.oid1,
  });
  new KnowledgeStore(store).save(manifest.repoKey, {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    repoKey: manifest.repoKey,
    baseOid: manifest.baseOid,
    snapshotFingerprint: manifest.fingerprint,
    generator: "knowledge-gen@1",
    statements: [
      {
        id: "k-live",
        subject: "@t/a",
        aspect: "purpose",
        claim: "scope a exports its review functions",
        evidence: [
          {
            path: "packages/a/src/index.ts",
            blobOid: git(repo.root, "rev-parse", `${repo.oid1}:packages/a/src/index.ts`),
          },
        ],
        confidence: "high",
        status: "hypothesis",
        provenance: { generator: "knowledge-gen@1", model: "test", apiKeySource: "none" },
        learnedAgainst: { baseOid: manifest.baseOid, snapshotFingerprint: manifest.fingerprint },
      },
    ],
  });
}

describe("createLiveCanvasOpsBackend — the live end-to-end review backend", () => {
  it("meters production context.ask on the shared review budget and appends run.ledger", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    await seedAskKnowledge(repo, store);
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const before = pipeline.invocationBudget.consumed;
    const { backend } = await createLiveCanvasOpsBackend(review, pipeline, {
      store,
      knowledgePort: askPort({
        answer: "scope a exports its review functions",
        confidence: "high",
        evidence: [{ evidenceId: "k-live:0", path: "packages/a/src/index.ts" }],
      }),
    });

    const result = await backend.ask({ question: "what does scope a export?" });
    expect(result.status).toBe("answered");
    expect(pipeline.invocationBudget.consumed).toBe(before + 1);
    expect(backend.runLedger()).toEqual([
      expect.objectContaining({
        purpose: "context-ask:quick:attempt-0",
        admitted: 1,
        rejected: 0,
        budgetSpent: 1,
      }),
    ]);
  });

  it("runs a no-headroom thorough production ask and reports overage in its ledger", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    await seedAskKnowledge(repo, store);
    const { review } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const patchset = review.patchsets[0];
    if (!patchset) throw new Error("expected an active patchset");
    const pipeline = await buildReviewCanvases({
      reviewId: review.id,
      patchset,
      dispositions: [],
      routePlanOptions: { maxHarnessInvocations: 0 },
    });
    const { backend } = await createLiveCanvasOpsBackend(review, pipeline, {
      store,
      knowledgePort: askPort({
        answer: "scope a exports its review functions",
        confidence: "high",
        evidence: [{ evidenceId: "k-live:0", path: "packages/a/src/index.ts" }],
      }),
    });

    const result = await backend.ask({
      question: "what does scope a export?",
      budgetHint: "thorough",
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") throw new Error("expected an answer");
    expect(result.answer.cost).toEqual(
      expect.objectContaining({ budgetGranted: false, overage: true, turns: 1 }),
    );
    expect(backend.runLedger()).toEqual([
      expect.objectContaining({
        purpose: "context-ask:thorough:attempt-0",
        tier: "heavy",
        admitted: 1,
        budgetSpent: 0,
        budgetRemaining: 0,
      }),
    ]);
  });

  it("serves gitlink advances through the public live novelty accessor", async () => {
    const repo = workspaceRepo();
    const childA = "1234567890123456789012345678901234567890";
    const childB = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    git(repo.root, "reset", "--hard", repo.oid1);
    git(repo.root, "update-index", "--add", "--cacheinfo", `160000,${childA},vendor/tool`);
    git(repo.root, "commit", "-q", "-m", "pin child A");
    const baseOid = git(repo.root, "rev-parse", "HEAD");
    git(repo.root, "update-index", "--cacheinfo", `160000,${childB},vendor/tool`);
    git(repo.root, "commit", "-q", "-m", "pin child B");
    const headOid = git(repo.root, "rev-parse", "HEAD");
    const opened = await reviewAt(repo.root, repo.commonDir, baseOid);
    const active = opened.review.patchsets[0];
    if (!active) throw new Error("expected active patchset");
    opened.review.patchsets = [
      {
        ...active,
        repository: { ...active.repository, headOid },
      },
    ];

    const { backend } = await createLiveCanvasOpsBackend(opened.review, opened.pipeline, {
      store: freshStore(),
    });
    const novelty = backend.novelty();
    expect(novelty.ok).toBe(true);
    if (!novelty.ok) throw new Error("expected live novelty ledger");
    expect(novelty.ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "extends",
          unit: expect.objectContaining({
            kind: "gitlink",
            path: "vendor/tool",
            oldOid: childA,
            newOid: childB,
          }),
        }),
      ]),
    );
  });

  it("reclassifies a live default-base review at the advanced default snapshot", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    const lifecycle = new NoveltyLifecycleRegistry();
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const opened = await createLiveCanvasOpsBackend(review, pipeline, {
      store,
      noveltyLifecycle: lifecycle,
    });
    expect(opened.snapshot.generated).toBe(true);
    expect(opened.contextManifest).toEqual(
      expect.objectContaining({
        repoRecordId: opened.snapshot.repoKey,
        projectSnapshotId: expect.any(String),
        freshness: { status: "current", staleMembers: [] },
      }),
    );

    git(repo.root, "reset", "--hard", repo.oid2);
    await new ProjectSnapshotGenerator({ store }).generate(repo.root, { explicitBaseRef: "main" });
    await lifecycle.advanceRepo(opened.snapshot.repoKey);

    expect(lifecycle.get(opened.snapshot.repoKey, review.id)?.ledger.baseOid).toBe(repo.oid2);
    const advance = lifecycle.getLastAdvance(opened.snapshot.repoKey, review.id);

    await createLiveCanvasOpsBackend(review, pipeline, { store, noveltyLifecycle: lifecycle });
    expect(lifecycle.get(opened.snapshot.repoKey, review.id)?.ledger.baseOid).toBe(repo.oid2);
    expect(lifecycle.getLastAdvance(opened.snapshot.repoKey, review.id)).toBe(advance);
  });

  it("persists the ContextManifest under the R55 entry and reloads it across a fresh session (#30)", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-ctxman-store-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);

    const opened = await createLiveCanvasOpsBackend(review, pipeline, { store });
    expect(opened.contextManifest).toBeDefined();
    const { repoKey, baseOid } = repoRecordOf(review);

    // A FRESH session: a brand-new store instance over the SAME on-disk entry
    // reloads the persisted manifest byte-for-byte (survives restart).
    const reloaded = new ContextManifestStore(new ProjectSnapshotStore(storeDir)).load(
      repoKey,
      baseOid,
    );
    expect(reloaded).toEqual(opened.contextManifest);
    expect(reloaded?.assembledPromptDigest).toBe(opened.contextManifest?.assembledPromptDigest);
  });

  it("records the assembled-context digest byte-identically and builds deterministically (#30)", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);

    // Open the backend (generates the snapshot + produces + persists the manifest).
    const opened = await createLiveCanvasOpsBackend(review, pipeline, { store });
    expect(opened.contextManifest).toBeDefined();

    // Rebuild directly to prove the deterministic producer's own byte identity.
    const built = await buildReviewContextManifest({ store, review });
    expect(built).toBeDefined();
    if (!built) throw new Error("expected a manifest");

    // Byte-identity: the recorded digest equals the digest over the assembled text.
    expect(built.manifest.assembledPromptDigest).toBe(built.assembly.digest);
    expect(built.manifest.assembledPromptDigest).toBe(sha256Hex(built.assembly.text));

    // Same inputs → same manifest. The separate desktop test proves production
    // consumers load the persisted artifact instead of relying on this recomputation.
    expect(built.manifest).toEqual(opened.contextManifest);
  });

  it("serves the persisted digest-verified assembly without re-reading mutable guidance", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    await new ProjectSnapshotGenerator({ store }).generate(repo.root, {
      explicitBaseRef: repo.oid1,
    });
    const { review } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const built = await buildReviewContextManifest({ store, review });
    if (!built) throw new Error("expected a context assembly");
    const { repoKey, baseOid } = repoRecordOf(review);
    const manifestStore = new ContextManifestStore(store);
    manifestStore.save(repoKey, baseOid, built.manifest);
    manifestStore.saveText(repoKey, baseOid, built.assembly.text);
    write(repo.root, "CLAUDE.md", "mutable guidance changed after capture\n");

    const ensured = await ensureReviewContextAssembly({ store, review });

    expect(ensured).toEqual({ manifest: built.manifest, text: built.assembly.text });
  });

  it("rebuilds and re-persists both artifacts when text is mismatched or missing", async () => {
    const repo = workspaceRepo();
    git(repo.root, "reset", "--hard", repo.oid1);
    const store = freshStore();
    await new ProjectSnapshotGenerator({ store }).generate(repo.root, {
      explicitBaseRef: repo.oid1,
    });
    const { review } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const original = await buildReviewContextManifest({ store, review });
    if (!original) throw new Error("expected a context assembly");
    const { repoKey, baseOid } = repoRecordOf(review);
    const manifestStore = new ContextManifestStore(store);
    manifestStore.save(repoKey, baseOid, original.manifest);
    manifestStore.saveText(repoKey, baseOid, "mismatched text");
    write(repo.root, "CLAUDE.md", "replacement guidance one\n");

    const fromMismatch = await ensureReviewContextAssembly({ store, review });
    expect(fromMismatch).toBeDefined();
    expect(manifestStore.loadVerified(repoKey, baseOid)).toEqual(fromMismatch);
    expect(fromMismatch?.manifest.assembledPromptDigest).not.toBe(
      original.manifest.assembledPromptDigest,
    );

    rmSync(join(store.paths(repoKey).projectDir, "context-manifests", `${baseOid}.context.txt`));
    write(repo.root, "CLAUDE.md", "replacement guidance two\n");
    const fromMissing = await ensureReviewContextAssembly({ store, review });
    expect(fromMissing).toBeDefined();
    expect(manifestStore.loadVerified(repoKey, baseOid)).toEqual(fromMissing);
    expect(fromMissing?.manifest.assembledPromptDigest).not.toBe(
      fromMismatch?.manifest.assembledPromptDigest,
    );
  });

  it("returns honest undefined without throwing when no snapshot can produce an assembly", async () => {
    const repo = workspaceRepo();
    const { review } = await reviewAt(repo.root, repo.commonDir, repo.oid1);

    await expect(
      ensureReviewContextAssembly({ store: freshStore(), review }),
    ).resolves.toBeUndefined();
  });

  it("serves REAL snapshot-derived data for context.map / context.file / context.novelty", async () => {
    const repo = workspaceRepo();
    git(repo.root, "update-ref", "refs/remotes/origin/main", repo.oid2);
    git(repo.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const store = freshStore();
    const { backend, snapshot, contextManifest } = await createLiveCanvasOpsBackend(
      review,
      pipeline,
      {
        store,
      },
    );

    // The snapshot was generated at the review's pinned base OID.
    expect(snapshot.generated).toBe(true);
    expect(snapshot.baseOid).toBe(repo.oid1);
    expect(contextManifest?.projectSnapshotId).toBeDefined();
    expect(contextManifest?.projectSnapshotId).not.toBe(
      store.loadManifest(snapshot.repoKey)?.fingerprint,
    );

    // context.map: a real structural map at exactly the pinned OID (never stale/absent).
    const mapResult = backend.projectMap();
    expect(mapResult.ok).toBe(true);
    if (!mapResult.ok) throw new Error("expected a served map");
    const map: ProjectMap = mapResult.map;
    expect(map.baseOid).toBe(repo.oid1);
    expect(map.scopes.map((s) => s.name)).toContain("@t/a");
    expect(map.files.some((f) => f.path === "packages/a/src/index.ts")).toBe(true);

    // context.file: real structural knowledge of one file at the pinned OID.
    const fileResult = backend.fileContext("packages/a/src/index.ts");
    expect(fileResult.ok).toBe(true);
    if (!fileResult.ok) throw new Error("expected a served file context");
    expect(fileResult.context.path).toBe("packages/a/src/index.ts");
    expect(fileResult.context.scope).toBe("@t/a");

    // context.novelty: a real ledger against the snapshot at the patchset's base OID.
    const noveltyResult = backend.novelty();
    expect(noveltyResult.ok).toBe(true);
    if (!noveltyResult.ok) throw new Error("expected a served novelty ledger");
    const ledger: NoveltyLedger = noveltyResult.ledger;
    expect(ledger.baseOid).toBe(repo.oid1);
    expect(ledger.entries.length).toBeGreaterThan(0);

    // Scoped context.map narrows to a subtree — proving the query threads through.
    const scoped = backend.projectMap({ path: "packages/a" });
    expect(scoped.ok).toBe(true);
  });

  it("projects the fresh context.map/file snapshot into compact hypothesis repo context", async () => {
    const repo = workspaceRepo();
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const store = freshStore();
    const live = await createLiveCanvasOpsBackend(review, pipeline, { store });
    const context = projectHypothesisRepoContext(
      new ProjectContextReader(store),
      { repoKey: live.snapshot.repoKey, baseOid: live.snapshot.baseOid },
      ["packages/a/src/index.ts"],
    );

    expect(context).toBeDefined();
    expect(context?.summary).toContain("@t/a");
    expect(context?.files).toEqual([
      expect.objectContaining({
        path: "packages/a/src/index.ts",
        summary: expect.stringContaining("makeA"),
      }),
    ]);
  });

  it("returns no hypothesis repo context on a typed snapshot refusal", () => {
    const store = freshStore();
    expect(
      projectHypothesisRepoContext(
        new ProjectContextReader(store),
        { repoKey: "missing", baseOid: "0".repeat(40) },
        ["src/missing.ts"],
      ),
    ).toBeUndefined();
  });

  it("fail-closed: no snapshot → context refuses (typed absent) while the lenses still render", async () => {
    const repo = workspaceRepo();
    const { review, pipeline } = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    // A zero file ceiling forces generation to be skipped (a big-repo stand-in).
    const { backend, snapshot } = await createLiveCanvasOpsBackend(review, pipeline, {
      store: freshStore(),
      maxSnapshotFiles: 0,
    });
    expect(snapshot.generated).toBe(false);
    expect(snapshot.degradedReason).toBeDefined();

    // The Repo-Map reads refuse with a TYPED gate failure — never a served/fake map.
    const map = backend.projectMap();
    expect(map.ok).toBe(false);
    if (!map.ok) expect(map.failure.reason).toBe("absent");
    const novelty = backend.novelty();
    expect(novelty.ok).toBe(false);
    if (!novelty.ok) expect(novelty.failure.reason).toBe("absent");
    const file = backend.fileContext("packages/a/src/index.ts");
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.reason).toBe("snapshot-unavailable");

    // The PRODUCER path is untouched: the lenses/canvases render from the diff,
    // with no dependency on the snapshot (the vital "lenses still render" contract).
    expect(backend.identity().reviewId).toBe(review.id);
    expect(backend.decomposition().hunks.length).toBeGreaterThan(0);
    expect(backend.canvas()).toBeDefined();
    expect(backend.angles().length).toBeGreaterThan(0);
  });

  it("refuses a snapshot at the WRONG OID as stale, never serving a mismatched map", async () => {
    const repo = workspaceRepo();
    const store = freshStore();

    // Open at oid1 → the store now holds a snapshot pinned to oid1.
    const first = await reviewAt(repo.root, repo.commonDir, repo.oid1);
    const opened = await createLiveCanvasOpsBackend(first.review, first.pipeline, { store });
    expect(opened.snapshot.generated).toBe(true);

    // Open a review pinned to oid2 WITHOUT regenerating (size-gated skip): the
    // store's oid1 snapshot is refused as stale rather than served for oid2.
    const second = await reviewAt(repo.root, repo.commonDir, repo.oid2);
    const { backend } = await createLiveCanvasOpsBackend(second.review, second.pipeline, {
      store,
      maxSnapshotFiles: 0,
    });
    const map = backend.projectMap();
    expect(map.ok).toBe(false);
    if (!map.ok) {
      expect(map.failure.reason).toBe("stale");
      if (map.failure.reason === "stale") {
        expect(map.failure.storedBaseOid).toBe(repo.oid1);
        expect(map.failure.requestedBaseOid).toBe(repo.oid2);
      }
    }
    const novelty = backend.novelty();
    expect(novelty.ok).toBe(false);
    if (!novelty.ok) expect(novelty.failure.reason).toBe("stale");
  });
});
