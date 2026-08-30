import type { GenerateOptions, GenerateResult } from "@rennet/adapters";
import type {
  KnowledgeSet,
  KnowledgeStatement,
  ProjectProcessEvent,
  ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createProcessProject, type ProcessProjectDeps } from "./process-project";
import type { ProjectProcessJournal, ProjectProcessJournalRecord } from "./project-process-journal";

function project(overrides: Partial<import("@rennet/protocol").Project> = {}) {
  return {
    id: "p1",
    name: "orbital",
    path: "/orbital",
    kind: "repo" as const,
    repoCount: 1,
    branchCount: 3,
    primaryBranch: "trunk",
    openPath: "/orbital",
    addedAt: "2026-08-11T00:00:00.000Z",
    source: "local" as const,
    ...overrides,
  };
}

/** A generator stub that records the options it was called with and returns fixed totals. */
function fakeGenerator(perRepo: (repoRoot: string) => Partial<GenerateResult> | Error): {
  generate: ProcessProjectDeps["generate"];
  calls: { repoRoot: string; options: GenerateOptions }[];
} {
  const calls: { repoRoot: string; options: GenerateOptions }[] = [];
  const generate: ProcessProjectDeps["generate"] = async (repoRoot, options) => {
    calls.push({ repoRoot, options });
    const outcome = perRepo(repoRoot);
    if (outcome instanceof Error) throw outcome;
    return {
      manifest: { baseRef: options.explicitBaseRef ?? "main", baseOid: "oid-1" },
      reusedSymbolShards: 0,
      extractedSymbolShards: 0,
      reusedReferenceShards: 0,
      extractedReferenceShards: 0,
      fileCount: 0,
      scopeCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      ...outcome,
    } as GenerateResult;
  };
  return { generate, calls };
}

const QUESTIONNAIRE: ProjectScoutQuestionnaire = {
  repo: "orbital",
  detected: 2,
  guessed: 3,
  answers: [
    {
      key: "trackerKind",
      value: "github",
      provenance: "detected",
      source: ".github",
      hint: "referenced tickets feed review context",
      options: ["github", "none"],
    },
    {
      key: "defaultBranch",
      value: "trunk",
      provenance: "detected",
      source: "origin/HEAD",
      hint: "the structural map reads this branch",
    },
    {
      key: "worktreeBaseDir",
      value: "~/.rennet/worktrees",
      provenance: "guessed",
      source: "Rennet default",
      hint: "coding rounds create worktrees here",
    },
    {
      key: "gateCommand",
      value: "pnpm check",
      provenance: "guessed",
      source: "package scripts",
      hint: "coding rounds run this before handoff",
    },
    {
      key: "logoPath",
      value: "",
      provenance: "guessed",
      source: "no repository mark found",
      hint: "cosmetic only",
    },
  ],
};

function statement(id: string, status: KnowledgeStatement["status"]): KnowledgeStatement {
  return {
    id,
    subject: "orbital",
    aspect: "purpose",
    claim: `${id} claim`,
    evidence: [{ path: "src/index.ts", blobOid: "blob-1" }],
    confidence: "high",
    status,
    provenance: { generator: "test@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "oid-1", snapshotFingerprint: "fp-1" },
  };
}

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "/orbital",
  baseOid: "oid-1",
  snapshotFingerprint: "fp-1",
  generator: "test@1",
  statements: [statement("confirmed", "confirmed"), statement("rejected", "rejected")],
};

function journal(): {
  port: ProjectProcessJournal;
  records: Map<string, ProjectProcessJournalRecord>;
} {
  const records = new Map<string, ProjectProcessJournalRecord>();
  return {
    records,
    port: {
      load: (key) => records.get(key) ?? null,
      save: (key, record) => records.set(key, structuredClone(record)),
    },
  };
}

describe("createProcessProject — the initial context dump wiring", () => {
  it("builds each repo at the project's CONFIRMED primary branch, not the repo default", async () => {
    const gen = fakeGenerator(() => ({ fileCount: 10, symbolCount: 40, referenceCount: 90 }));
    const processProject = createProcessProject({
      generate: gen.generate,
      listProjects: () => [
        project({
          primaryBranch: "trunk",
          includedRepoPaths: ["/ws/a", "/ws/b"],
          kind: "workspace",
        }),
      ],
    });

    await processProject({ projectId: "p1" }, () => undefined);

    // Both repos were built with explicitBaseRef = the confirmed branch (regression
    // for: generate() previously received only onProgress, so it resolved the repo's
    // DEFAULT branch and ignored the configured one).
    expect(gen.calls.map((call) => call.repoRoot)).toEqual(["/ws/a", "/ws/b"]);
    for (const call of gen.calls) expect(call.options.explicitBaseRef).toBe("trunk");
  });

  it("reports the generator's REAL totals (files / symbols / references), not shard counts", async () => {
    const gen = fakeGenerator(() => ({
      fileCount: 412,
      symbolCount: 1804,
      referenceCount: 9001,
      reusedSymbolShards: 3,
      manifest: { baseRef: "trunk" } as GenerateResult["manifest"],
    }));
    const processProject = createProcessProject({
      generate: gen.generate,
      listProjects: () => [project()],
    });

    const events: ProjectProcessEvent[] = [];
    const { repos } = await processProject({ projectId: "p1" }, (event) => events.push(event));
    expect(repos).toEqual([
      {
        repo: "orbital",
        path: "/orbital",
        ok: true,
        files: 412,
        symbols: 1804,
        references: 9001,
        reusedSymbols: 3,
        baseRef: "trunk",
      },
    ]);
    expect(events.find((event) => event.kind === "repo-done")).toMatchObject({
      artifact: { kind: "project", projectId: "p1" },
    });
  });

  it("rebuilds a completed journal when recovery uses a new run identity", async () => {
    const durable = journal();
    const gen = fakeGenerator(() => ({ fileCount: 12, symbolCount: 8 }));
    const processProject = createProcessProject({
      journal: durable.port,
      generate: gen.generate,
      listProjects: () => [project()],
    });
    const firstId = "18cc8bc7-e6f6-45a7-87c2-6ec104731c7f";
    const rebuildId = "98c917b9-610c-47c6-baf0-d22e2bf2224d";

    const first = await processProject({ projectId: "p1", commandId: firstId }, () => undefined);
    const rebuilt = await processProject(
      { projectId: "p1", commandId: rebuildId },
      () => undefined,
    );

    expect(first.run.id).toBe(firstId);
    expect(rebuilt.run.id).toBe(rebuildId);
    expect(gen.calls).toHaveLength(2);
    expect(durable.records.get("/orbital")?.runId).toBe(rebuildId);
  });

  it("carries a per-repo failure softly and keeps building the rest of the workspace", async () => {
    const gen = fakeGenerator((repoRoot) =>
      repoRoot === "/ws/bad" ? new Error("not a git repository") : { fileCount: 5, symbolCount: 2 },
    );
    const events: ProjectProcessEvent[] = [];
    const processProject = createProcessProject({
      generate: gen.generate,
      listProjects: () => [
        project({ kind: "workspace", includedRepoPaths: ["/ws/good", "/ws/bad"] }),
      ],
    });

    const { repos } = await processProject({ projectId: "p1" }, (event) => events.push(event));

    // The bad repo did not abort the good one; both are represented.
    expect(repos.map((repo) => [repo.repo, repo.ok])).toEqual([
      ["good", true],
      ["bad", false],
    ]);
    expect(repos[1]?.error).toBe("not a git repository");
    expect(events.some((event) => event.kind === "repo-error")).toBe(true);
    // A soft failure never throws — the promise resolved above with both summaries.
  });

  it("resolves empty for an unknown project (fail-safe, mirrors the project store)", async () => {
    const gen = fakeGenerator(() => ({}));
    const processProject = createProcessProject({ generate: gen.generate, listProjects: () => [] });
    const { repos } = await processProject({ projectId: "missing" }, () => undefined);
    expect(repos).toEqual([]);
    expect(gen.calls).toHaveLength(0);
  });

  it("runs scout before map, waits for verified knowledge, and reports the real ready totals", async () => {
    const order: string[] = [];
    const gen = fakeGenerator(() => {
      order.push("map");
      return { fileCount: 12, scopeCount: 4 };
    });
    const processProject = createProcessProject({
      generate: gen.generate,
      listProjects: () => [project()],
      runScout: async () => {
        order.push("scout");
        return QUESTIONNAIRE;
      },
      runKnowledge: async () => {
        order.push("knowledge");
        return { status: "skipped", reason: "current set" };
      },
      loadKnowledge: () => KNOWLEDGE,
    });

    const result = await processProject(
      { projectId: "p1", commandId: "8ab93adb-12a7-49c5-94c4-52190bf35948" },
      () => undefined,
    );

    expect(order).toEqual(["scout", "map", "knowledge"]);
    expect(result.run).toMatchObject({
      status: "done",
      phase: "complete",
      scout: QUESTIONNAIRE,
      totals: { repos: 1, files: 12, scopes: 4, confirmed: 1, rejected: 1 },
    });
  });

  it("persists an initial scout exception as a failed run that the same identity can retry", async () => {
    const durable = journal();
    const commandId = "52a7ad55-7fb2-4f5f-930c-3692405513dc";
    let scoutCalls = 0;
    const processProject = createProcessProject({
      journal: durable.port,
      generate: fakeGenerator(() => ({ fileCount: 12 })).generate,
      listProjects: () => [project()],
      runScout: async () => {
        scoutCalls += 1;
        if (scoutCalls === 1) throw new Error("scout harness exited before returning facts");
        return QUESTIONNAIRE;
      },
    });

    const failed = await processProject({ projectId: "p1", commandId }, () => undefined);

    expect(failed.run).toMatchObject({
      id: commandId,
      status: "failed",
      phase: "scout",
      reason: "orbital: scout harness exited before returning facts",
    });
    expect(durable.records.get("/orbital")).toMatchObject({
      runId: commandId,
      status: "failed",
      phase: "scout",
    });

    const retried = await processProject({ projectId: "p1", commandId }, () => undefined);

    expect(scoutCalls).toBe(2);
    expect(retried.run).toMatchObject({ id: commandId, status: "done", phase: "complete" });
  });

  it("reattaches after a daemon restart at the first incomplete checkpoint without duplicate steps", async () => {
    const durable = journal();
    const commandId = "260265b1-3e18-4d91-9645-a13a37634f49";
    let scoutCalls = 0;
    let mapCalls = 0;
    let knowledgeCalls = 0;
    const first = createProcessProject({
      journal: durable.port,
      generate: async (_repoRoot, options) => {
        mapCalls += 1;
        options.onProgress?.({ stage: "tree", note: "Scanning", detail: "12 files" });
        return {
          manifest: { baseRef: "trunk", baseOid: "oid-1" },
          reusedSymbolShards: 0,
          extractedSymbolShards: 0,
          reusedReferenceShards: 0,
          extractedReferenceShards: 0,
          fileCount: 12,
          scopeCount: 4,
          symbolCount: 8,
          referenceCount: 9,
        } as GenerateResult;
      },
      listProjects: () => [project()],
      runScout: async (input) => {
        scoutCalls += 1;
        input.narrate({
          kind: "step",
          runId: input.runId,
          repo: "orbital",
          phase: "scout",
          step: "returned",
          status: "done",
          note: "Scout returned",
          detail: "2 detected, 3 guessed",
        });
        return QUESTIONNAIRE;
      },
      runKnowledge: async (input) => {
        knowledgeCalls += 1;
        input.narrate({
          kind: "step",
          runId: input.runId,
          repo: "orbital",
          phase: "knowledge",
          step: "verify",
          status: "running",
          note: "Verifying hypotheses",
        });
        throw new Error("daemon stopped");
      },
    });
    await expect(first({ projectId: "p1", commandId }, () => undefined)).resolves.toMatchObject({
      run: {
        id: commandId,
        status: "failed",
        phase: "knowledge",
        reason: "orbital: daemon stopped",
      },
    });

    const resumedEvents: ProjectProcessEvent[] = [];
    const resumed = createProcessProject({
      journal: durable.port,
      generate: async () => {
        throw new Error("the completed map must not rerun");
      },
      listProjects: () => [project()],
      runScout: async () => {
        throw new Error("the completed scout must not rerun");
      },
      runKnowledge: async (input) => {
        knowledgeCalls += 1;
        input.narrate({
          kind: "step",
          runId: input.runId,
          repo: "orbital",
          phase: "knowledge",
          step: "verify",
          status: "done",
          note: "Verified hypotheses",
          detail: "1 confirmed, 1 rejected",
        });
        return { status: "skipped", reason: "current set" };
      },
      loadKnowledge: () => KNOWLEDGE,
    });
    const result = await resumed({ projectId: "p1", commandId }, (event) =>
      resumedEvents.push(event),
    );

    expect({ scoutCalls, mapCalls, knowledgeCalls }).toEqual({
      scoutCalls: 1,
      mapCalls: 1,
      knowledgeCalls: 2,
    });
    expect(result.run).toMatchObject({
      status: "done",
      totals: { files: 12, scopes: 4, confirmed: 1, rejected: 1 },
    });
    expect(
      resumedEvents
        .filter((event) => event.kind === "run-state")
        .map((event) => [event.status, event.phase]),
    ).toEqual([
      ["failed", "knowledge"],
      ["running", "knowledge"],
      ["done", "complete"],
    ]);
    const stored = durable.records.get("/orbital");
    expect(
      stored?.events.filter(
        (event) => event.kind === "step" && event.phase === "knowledge" && event.step === "verify",
      ),
    ).toHaveLength(1);
  });
});
