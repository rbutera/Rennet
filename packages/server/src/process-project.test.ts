import type { GenerateOptions, GenerateResult } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createProcessProject, type ProcessProjectDeps } from "./process-project";

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
      manifest: { baseRef: options.explicitBaseRef ?? "main" },
      reusedSymbolShards: 0,
      extractedSymbolShards: 0,
      reusedReferenceShards: 0,
      extractedReferenceShards: 0,
      fileCount: 0,
      symbolCount: 0,
      referenceCount: 0,
      ...outcome,
    } as GenerateResult;
  };
  return { generate, calls };
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
});
