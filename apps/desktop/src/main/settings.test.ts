import { escapePath, type Locus } from "@rennet/core";
import type { Project, ProjectVisibility } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createSettingsComposition, type SettingsCompositionDeps } from "./settings";

// A project factory with sane defaults; override per test.
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "orbital",
    path: "/orbital",
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: "/orbital",
    addedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SettingsCompositionDeps> = {}): {
  deps: SettingsCompositionDeps;
  calls: {
    loadConfigState: string[];
    applyVisibility: { repoKey: string; repoRoot: string; target: ProjectVisibility }[];
    applyLocus: { repoKey: string; locus: Locus | null }[];
    discoverWorkspaceRepos: number;
    updateGlobal: number;
  };
} {
  const calls = {
    loadConfigState: [] as string[],
    applyVisibility: [] as { repoKey: string; repoRoot: string; target: ProjectVisibility }[],
    applyLocus: [] as { repoKey: string; locus: Locus | null }[],
    discoverWorkspaceRepos: 0,
    updateGlobal: 0,
  };
  const deps: SettingsCompositionDeps = {
    listProjects: () => [project()],
    loadConfigState: (repoKey) => {
      calls.loadConfigState.push(repoKey);
      return { status: "absent", config: null };
    },
    readGlobalState: () => ({ status: "ok", config: { version: 1 } }),
    updateGlobal: (update) => {
      calls.updateGlobal += 1;
      return update({ version: 1 });
    },
    // Default: the working path IS its own top level (identity).
    gitTopLevel: async (workingPath) => workingPath,
    discoverWorkspaceRepos: async () => {
      calls.discoverWorkspaceRepos += 1;
      return [];
    },
    loadGuidance: () => ({ dropped: 0, reason: "absent" }),
    applyVisibility: async ({ repoKey, repoRoot, target }) => {
      calls.applyVisibility.push({ repoKey, repoRoot, target });
      return { changed: true, gitignorePath: `${repoRoot}/.rennet/.gitignore` };
    },
    applyLocus: ({ repoKey, locus }) => {
      calls.applyLocus.push({ repoKey, locus });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("createSettingsComposition — repo identity (git top level)", () => {
  it("keys a nested subdir on its git TOP LEVEL, not the raw open path", async () => {
    const { deps, calls } = makeDeps({
      listProjects: () => [project({ openPath: "/orbital/packages/api" })],
      // The subdir resolves UP to the repo top level.
      gitTopLevel: async (workingPath) =>
        workingPath === "/orbital/packages/api" ? "/orbital" : workingPath,
    });
    const view = await createSettingsComposition(deps).get();
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]?.repoPath).toBe("/orbital");
    // The store was read with the ESCAPED top level, never the subdir.
    expect(calls.loadConfigState).toEqual([escapePath("/orbital")]);
  });

  it("omits a row for a working path that is not a git tree (a since-removed checkout)", async () => {
    const { deps } = makeDeps({ gitTopLevel: async () => null });
    const view = await createSettingsComposition(deps).get();
    expect(view.projects).toEqual([]);
  });
});

describe("createSettingsComposition — workspace expansion", () => {
  it("expands a LEGACY workspace (no includedRepoPaths) into one row PER discovered repo", async () => {
    let discovered = 0;
    const { deps } = makeDeps({
      listProjects: () => [project({ kind: "workspace", name: "focused", openPath: "/focused/a" })],
      discoverWorkspaceRepos: async () => {
        discovered += 1;
        return ["/focused/a", "/focused/b"];
      },
      gitTopLevel: async (workingPath) => workingPath,
    });
    const view = await createSettingsComposition(deps).get();
    expect(discovered).toBe(1);
    expect(view.projects.map((p) => p.repoPath)).toEqual(["/focused/a", "/focused/b"]);
    // Multiple repos ⇒ names are disambiguated by the repo basename.
    expect(view.projects.map((p) => p.name)).toEqual(["focused · a", "focused · b"]);
  });

  it("uses the persisted inclusion set for a NEW workspace, without rediscovering", async () => {
    let discovered = 0;
    const { deps } = makeDeps({
      listProjects: () => [
        project({
          kind: "workspace",
          name: "focused",
          includedRepoPaths: ["/focused/a", "/focused/b"],
        }),
      ],
      discoverWorkspaceRepos: async () => {
        discovered += 1;
        return [];
      },
      gitTopLevel: async (workingPath) => workingPath,
    });
    const view = await createSettingsComposition(deps).get();
    expect(discovered).toBe(0);
    expect(view.projects.map((p) => p.repoPath)).toEqual(["/focused/a", "/focused/b"]);
  });
});

describe("createSettingsComposition — malformed config (Rule 75)", () => {
  it("marks a malformed row, shows builtin defaults, and REFUSES the write without touching the switch", async () => {
    const { deps, calls } = makeDeps({
      loadConfigState: () => ({ status: "malformed", config: null }),
    });
    const composition = createSettingsComposition(deps);
    const view = await composition.get();
    expect(view.projects[0]?.configMalformed).toBe(true);
    // Builtin defaults, not leaked garbage.
    expect(view.projects[0]?.visibility).toBe("local");

    const outcome = await composition.setRepoVisibility({
      projectId: "p1",
      repoPath: "/orbital",
      visibility: "git-visible",
    });
    expect(outcome.status).toBe("malformed");
    expect(outcome.changed).toBe(false);
    // The real switch was NEVER invoked — nothing could have been written.
    expect(calls.applyVisibility).toEqual([]);
  });
});

describe("createSettingsComposition — write outcomes + provenance", () => {
  it("applies a real switch for a resolvable repo and reports `applied`", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await createSettingsComposition(deps).setRepoVisibility({
      projectId: "p1",
      repoPath: "/orbital",
      visibility: "git-visible",
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.gitignorePath).toContain(".gitignore");
    expect(calls.applyVisibility).toEqual([
      { repoKey: escapePath("/orbital"), repoRoot: "/orbital", target: "git-visible" },
    ]);
  });

  it("returns `unresolved` for a repoPath not belonging to the project (never a false success)", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await createSettingsComposition(deps).setRepoVisibility({
      projectId: "p1",
      repoPath: "/not/this/repo",
      visibility: "git-visible",
    });
    expect(outcome.status).toBe("unresolved");
    expect(calls.applyVisibility).toEqual([]);
  });

  it("carries visibility + promotion provenance from the resolver", async () => {
    const { deps } = makeDeps({
      loadConfigState: () => ({
        status: "ok",
        config: { visibility: "git-visible", promoted: true },
      }),
    });
    const view = await createSettingsComposition(deps).get();
    const row = view.projects[0];
    expect(row?.visibility).toBe("git-visible");
    expect(row?.visibilityProvenance.layer).toBe("repo");
    expect(row?.promoted).toBe(true);
    expect(row?.promotedProvenance.layer).toBe("repo");
  });

  it("setAppearance writes through updateGlobal", () => {
    const { deps, calls } = makeDeps();
    const scheme = createSettingsComposition(deps).setAppearance("light");
    expect(scheme).toBe("light");
    expect(calls.updateGlobal).toBe(1);
  });

  it("auto-detects a WSL-UNC project's locus, unset override", async () => {
    const { deps } = makeDeps({
      listProjects: () => [
        project({
          path: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
          openPath: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        }),
      ],
      gitTopLevel: async (p) => p,
    });
    const view = await createSettingsComposition(deps).get();
    const row = view.projects[0];
    expect(row?.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(row?.locusOverridden).toBe(false);
  });

  it("a host project auto-detects the host locus", async () => {
    const { deps } = makeDeps();
    const view = await createSettingsComposition(deps).get();
    expect(view.projects[0]?.locus).toEqual({ kind: "host" });
    expect(view.projects[0]?.locusOverridden).toBe(false);
  });

  it("surfaces a persisted locus override with locusOverridden true", async () => {
    const { deps } = makeDeps({
      loadConfigState: () => ({
        status: "ok",
        config: { locus: { kind: "wsl", distro: "Debian" } },
      }),
    });
    const view = await createSettingsComposition(deps).get();
    expect(view.projects[0]?.locus).toEqual({ kind: "wsl", distro: "Debian" });
    expect(view.projects[0]?.locusOverridden).toBe(true);
  });

  it("setRepoLocus writes the override through applyLocus", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await createSettingsComposition(deps).setRepoLocus({
      projectId: "p1",
      repoPath: "/orbital",
      locus: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(outcome.locusOverridden).toBe(true);
    expect(calls.applyLocus).toEqual([
      { repoKey: escapePath("/orbital"), locus: { kind: "wsl", distro: "Ubuntu" } },
    ]);
  });

  it("setRepoLocus with null clears the override (back to auto-detect)", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await createSettingsComposition(deps).setRepoLocus({
      projectId: "p1",
      repoPath: "/orbital",
      locus: null,
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.locusOverridden).toBe(false);
    expect(calls.applyLocus).toEqual([{ repoKey: escapePath("/orbital"), locus: null }]);
  });

  it("setRepoLocus refuses a malformed config (Rule 75)", async () => {
    const { deps, calls } = makeDeps({
      loadConfigState: () => ({ status: "malformed", config: null }),
    });
    const outcome = await createSettingsComposition(deps).setRepoLocus({
      projectId: "p1",
      repoPath: "/orbital",
      locus: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(outcome.status).toBe("malformed");
    expect(calls.applyLocus).toEqual([]);
  });
});
