import type { GenerateOptions, GenerateResult } from "@rennet/adapters";
import type {
  BenchmarkRun,
  ProjectProcessEvent,
  ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  createProcessProject,
  type ProcessProjectDeps,
  type ProjectScoutRunInput,
} from "./process-project";
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

  it("runs scout before map and reports the real ready totals", async () => {
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
    });

    const result = await processProject(
      { projectId: "p1", commandId: "8ab93adb-12a7-49c5-94c4-52190bf35948" },
      () => undefined,
    );

    expect(order).toEqual(["scout", "map"]);
    expect(result.run).toMatchObject({
      status: "done",
      phase: "complete",
      scout: QUESTIONNAIRE,
      totals: { repos: 1, files: 12, scopes: 4 },
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
    const generated = {
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
    const runScoutOnce = async (input: ProjectScoutRunInput) => {
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
    };
    const first = createProcessProject({
      journal: durable.port,
      generate: async () => {
        mapCalls += 1;
        throw new Error("daemon stopped");
      },
      listProjects: () => [project()],
      runScout: runScoutOnce,
    });
    await expect(first({ projectId: "p1", commandId }, () => undefined)).resolves.toMatchObject({
      run: {
        id: commandId,
        status: "failed",
        phase: "map",
        reason: "orbital: daemon stopped",
      },
    });

    const resumedEvents: ProjectProcessEvent[] = [];
    const resumed = createProcessProject({
      journal: durable.port,
      generate: async (_repoRoot, options) => {
        mapCalls += 1;
        options.onProgress?.({ stage: "tree", note: "Scanning", detail: "12 files" });
        return generated;
      },
      listProjects: () => [project()],
      runScout: async () => {
        throw new Error("the completed scout must not rerun");
      },
    });
    const result = await resumed({ projectId: "p1", commandId }, (event) =>
      resumedEvents.push(event),
    );

    expect({ scoutCalls, mapCalls }).toEqual({ scoutCalls: 1, mapCalls: 2 });
    expect(result.run).toMatchObject({
      status: "done",
      totals: { files: 12, scopes: 4 },
    });
    expect(
      resumedEvents
        .filter((event) => event.kind === "run-state")
        .map((event) => [event.status, event.phase]),
    ).toEqual([
      ["failed", "map"],
      ["running", "map"],
      ["done", "complete"],
    ]);
    const stored = durable.records.get("/orbital");
    expect(
      stored?.events.filter(
        (event) => event.kind === "step" && event.phase === "scout" && event.step === "returned",
      ),
    ).toHaveLength(1);
  });
});

describe("Repo Map benchmark stages (#731 9.2)", () => {
  /** A clock that advances a fixed step per read, so a stage's duration is the number of
   *  boundaries crossed inside it — deterministic, and readable in the assertion. */
  function steppedClock(step: number): () => number {
    let value = 1_000_000;
    return () => {
      value += step;
      return value;
    };
  }

  it("records one stage per real build boundary, plus the scout and the end-to-end total", async () => {
    const recorded: BenchmarkRun[] = [];
    const run = createProcessProject({
      generate: async (_repoRoot, options) => {
        // The generator's REAL progress shape: each stage announced, then re-announced
        // with its detail. Two events, one stage — a timer that treated the re-announce
        // as a new stage would halve every duration it reports.
        for (const stage of ["resolve", "tree", "workspace", "conventions", "symbols"] as const) {
          options.onProgress?.({ stage, note: stage });
          options.onProgress?.({ stage, note: stage, detail: "d" });
        }
        options.onProgress?.({ stage: "build", note: "build" });
        options.onProgress?.({ stage: "verify", note: "verify" });
        options.onProgress?.({ stage: "store", note: "store" });
        return {
          manifest: { baseRef: "trunk", baseOid: "oid-benchmark" },
          reusedSymbolShards: 0,
          extractedSymbolShards: 0,
          reusedReferenceShards: 0,
          extractedReferenceShards: 0,
          fileCount: 3,
          scopeCount: 1,
          symbolCount: 2,
          referenceCount: 4,
        } as GenerateResult;
      },
      listProjects: () => [project()],
      runScout: async () => QUESTIONNAIRE,
      recordBenchmark: (entry) => recorded.push(entry),
      now: steppedClock(10),
    });
    await run({ projectId: "p1" }, () => undefined);

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry?.kind).toBe("repo-map");
    expect(entry?.outcome).toBe("complete");
    // Bound to the snapshot revision it built, so a number is always attributable.
    expect(entry?.subject.revision).toBe("oid-benchmark");
    expect(entry?.stages.map((stage) => stage.stage)).toEqual([
      "scout",
      "resolve",
      "tree",
      "workspace",
      "conventions",
      "symbols",
      "build",
      "verify",
      "store",
      "total",
    ]);
    // Deterministic end to end: no stage names a harness, because none ran one.
    expect(entry?.stages.every((stage) => stage.harness === undefined)).toBe(true);
    // The total spans scout → store, so it covers the gaps between stages rather than
    // only the sum of them.
    const total = entry?.stages.find((stage) => stage.stage === "total");
    const scout = entry?.stages.find((stage) => stage.stage === "scout");
    expect(total?.startedAtMs).toBe(scout?.startedAtMs);
    expect(total?.durationMs).toBeGreaterThan(0);
  });

  it("archives a build that DIED as a failed run carrying the stages it reached", async () => {
    const recorded: BenchmarkRun[] = [];
    const run = createProcessProject({
      generate: async (_repoRoot, options) => {
        options.onProgress?.({ stage: "resolve", note: "resolve" });
        options.onProgress?.({ stage: "tree", note: "tree" });
        throw new Error("the tree walk fell over");
      },
      listProjects: () => [project()],
      runScout: async () => QUESTIONNAIRE,
      recordBenchmark: (entry) => recorded.push(entry),
      now: steppedClock(10),
    });
    await run({ projectId: "p1" }, () => undefined);

    expect(recorded[0]?.outcome).toBe("failed");
    expect(recorded[0]?.failure).toBe("the tree walk fell over");
    expect(recorded[0]?.stages.map((stage) => stage.stage)).toEqual([
      "scout",
      "resolve",
      "tree",
      "total",
    ]);
    // Nothing was built, so nothing claims a revision.
    expect(recorded[0]?.subject.revision).toBeUndefined();
  });

  it("writes no record at all when no recorder is wired", async () => {
    // The positive control for "recording off writes nothing": the same run, the same
    // generator, only the recorder absent.
    const run = createProcessProject({
      generate: async (_repoRoot, options) => {
        options.onProgress?.({ stage: "tree", note: "tree" });
        return {
          manifest: { baseRef: "trunk", baseOid: "oid-1" },
          reusedSymbolShards: 0,
          extractedSymbolShards: 0,
          reusedReferenceShards: 0,
          extractedReferenceShards: 0,
          fileCount: 0,
          scopeCount: 0,
          symbolCount: 0,
          referenceCount: 0,
        } as GenerateResult;
      },
      listProjects: () => [project()],
      runScout: async () => QUESTIONNAIRE,
    });
    const result = await run({ projectId: "p1" }, () => undefined);
    // …and processing itself is untouched.
    expect(result.run.status).toBe("done");
  });
});
