import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectLocus, escapePath, type Locus, resolveLocus } from "@rennet/core";
import type { ClientSettings, Project, ProjectVisibility } from "@rennet/protocol";
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
    source: "local",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SettingsCompositionDeps> = {}): {
  deps: SettingsCompositionDeps;
  calls: {
    loadConfigState: string[];
    applyVisibility: { repoKey: string; repoRoot: string; target: ProjectVisibility }[];
    applyLocus: { repoKey: string; locus: Locus | null }[];
    clearRepoValue: { repoKey: string; field: "visibility" | "locus" }[];
    discoverWorkspaceRepos: number;
    updateGlobal: number;
  };
} {
  const calls = {
    loadConfigState: [] as string[],
    applyVisibility: [] as { repoKey: string; repoRoot: string; target: ProjectVisibility }[],
    applyLocus: [] as { repoKey: string; locus: Locus | null }[],
    clearRepoValue: [] as { repoKey: string; field: "visibility" | "locus" }[],
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
    clearRepoValue: ({ repoKey, field }) => {
      calls.clearRepoValue.push({ repoKey, field });
    },
    ...overrides,
  };
  return { deps, calls };
}

/**
 * A composition over a MUTABLE fake config store: writes (applyVisibility,
 * applyLocus, clearRepoValue) mutate the backing config, so a post-write
 * re-resolution reads the state the write left behind — the honest path reset/pin
 * take (they re-resolve the row from the live store after writing).
 */
function statefulDeps(
  initial: { visibility?: ProjectVisibility; promoted?: boolean; locus?: Locus } = {},
  opts: { malformed?: boolean; project?: Project } = {},
): {
  deps: SettingsCompositionDeps;
  store: { visibility?: ProjectVisibility; promoted?: boolean; locus?: Locus };
  calls: {
    applyVisibility: ProjectVisibility[];
    applyLocus: (Locus | null)[];
    clearRepoValue: ("visibility" | "locus")[];
    saved: number;
  };
} {
  const store: { visibility?: ProjectVisibility; promoted?: boolean; locus?: Locus } = {
    ...initial,
  };
  const calls = {
    applyVisibility: [] as ProjectVisibility[],
    applyLocus: [] as (Locus | null)[],
    clearRepoValue: [] as ("visibility" | "locus")[],
    saved: 0,
  };
  const deps: SettingsCompositionDeps = {
    listProjects: () => [opts.project ?? project()],
    loadConfigState: () =>
      opts.malformed
        ? { status: "malformed", config: null }
        : { status: "ok", config: { ...store } },
    readGlobalState: () => ({ status: "ok", config: { version: 1 } }),
    updateGlobal: (update) => update({ version: 1 }),
    gitTopLevel: async (workingPath) => workingPath,
    discoverWorkspaceRepos: async () => [],
    loadGuidance: () => ({ dropped: 0, reason: "absent" }),
    applyVisibility: async ({ repoRoot, target }) => {
      calls.applyVisibility.push(target);
      store.visibility = target;
      calls.saved += 1;
      return { changed: true, gitignorePath: `${repoRoot}/.rennet/.gitignore` };
    },
    applyLocus: ({ locus }) => {
      calls.applyLocus.push(locus);
      if (locus === null) delete store.locus;
      else store.locus = locus;
      calls.saved += 1;
    },
    clearRepoValue: ({ field }) => {
      calls.clearRepoValue.push(field);
      delete store[field];
      calls.saved += 1;
    },
  };
  return { deps, store, calls };
}

describe("createSettingsComposition — locus through the ladder (#28)", () => {
  it("get() carries locusProvenance naming `detected` when auto-detected, suppressed offer present", async () => {
    const { deps } = makeDeps();
    const view = await createSettingsComposition(deps).get();
    const row = view.projects[0];
    expect(row?.locusProvenance.layer).toBe("detected");
    expect(row?.locusOverridden).toBe(false);
    // The detected offer is present as a contribution (host, alongside the builtin).
    expect(row?.locusProvenance.contributions.map((c) => c.layer)).toContain("detected");
  });

  it("get() names `repo` when a persisted override wins, keeping the suppressed detected offer", async () => {
    const { deps } = makeDeps({
      loadConfigState: () => ({
        status: "ok",
        config: { locus: { kind: "wsl", distro: "Debian" } },
      }),
    });
    const row = (await createSettingsComposition(deps).get()).projects[0];
    expect(row?.locusProvenance.layer).toBe("repo");
    expect(row?.locusOverridden).toBe(true);
    expect(row?.locusProvenance.contributions.find((c) => c.layer === "detected")?.effective).toBe(
      false,
    );
  });

  it("keeps live execution and the settings surface on core's resolved locus", async () => {
    const repoPath = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo";
    const repoValue = { kind: "wsl" as const, distro: "Debian" };
    const expected = resolveLocus(detectLocus(repoPath), repoValue).value;
    const { deps } = makeDeps({
      listProjects: () => [project({ path: repoPath, openPath: repoPath })],
      gitTopLevel: async () => repoPath,
      loadConfigState: () => ({ status: "ok", config: { locus: repoValue } }),
    });

    expect((await createSettingsComposition(deps).get()).projects[0]?.locus).toEqual(expected);

    const executionSource = readFileSync(
      fileURLToPath(new URL("./create-server.ts", import.meta.url)),
      "utf8",
    );
    expect(executionSource).toMatch(
      /resolveLocus\(\s*detectLocus\(repoRoot\),\s*liveSnapshotStore\.loadConfig\(key\)\?\.locus,?\s*\)\.value/,
    );
  });
});

describe("createSettingsComposition — reset / pin (#28)", () => {
  it("resetRepoValue(visibility) clears the repo key AND drives the switch toward the newly effective value", async () => {
    const { deps, store, calls } = statefulDeps({ visibility: "git-visible" });
    const outcome = await createSettingsComposition(deps).resetRepoValue({
      projectId: "p1",
      repoPath: "/orbital",
      key: "visibility",
    });
    expect(outcome.status).toBe("applied");
    // The switch ran toward the effective (builtin) `local`, so `.gitignore` matches.
    expect(calls.applyVisibility).toEqual(["local"]);
    // The repo-layer entry is removed — the row now inherits.
    expect(calls.clearRepoValue).toEqual(["visibility"]);
    expect(store.visibility).toBeUndefined();
    expect(outcome.project?.visibility).toBe("local");
    expect(outcome.project?.visibilityProvenance.layer).toBe("builtin");
  });

  it("resetRepoValue(locus) clears the override back to auto-detection (setRepoLocus(null) behaviour)", async () => {
    const { deps, store } = statefulDeps({ locus: { kind: "wsl", distro: "Debian" } });
    const outcome = await createSettingsComposition(deps).resetRepoValue({
      projectId: "p1",
      repoPath: "/orbital",
      key: "locus",
    });
    expect(outcome.status).toBe("applied");
    expect(store.locus).toBeUndefined();
    // `/orbital` is a host path, so detection wins after the reset.
    expect(outcome.project?.locus).toEqual({ kind: "host" });
    expect(outcome.project?.locusOverridden).toBe(false);
    expect(outcome.project?.locusProvenance.layer).toBe("detected");
  });

  it("pinRepoValue(locus) writes the currently detected locus at the repo layer and the row flips to `repo`", async () => {
    const { deps, store, calls } = statefulDeps(
      {},
      {
        project: project({
          path: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
          openPath: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        }),
      },
    );
    const outcome = await createSettingsComposition(deps).pinRepoValue({
      projectId: "p1",
      repoPath: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
      key: "locus",
    });
    expect(outcome.status).toBe("applied");
    expect(calls.applyLocus).toEqual([{ kind: "wsl", distro: "Ubuntu" }]);
    expect(store.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(outcome.project?.locusOverridden).toBe(true);
    expect(outcome.project?.locusProvenance.layer).toBe("repo");
  });

  it("reset/pin return `unresolved` for a repoPath not in the project, writing nothing", async () => {
    const { deps, calls } = statefulDeps({ visibility: "git-visible" });
    const composition = createSettingsComposition(deps);
    const reset = await composition.resetRepoValue({
      projectId: "p1",
      repoPath: "/not/this/repo",
      key: "visibility",
    });
    const pin = await composition.pinRepoValue({
      projectId: "p1",
      repoPath: "/not/this/repo",
      key: "locus",
    });
    expect(reset.status).toBe("unresolved");
    expect(reset.project).toBeNull();
    expect(pin.status).toBe("unresolved");
    expect(calls.saved).toBe(0);
  });

  it("reset/pin REFUSE a malformed config (Rule 75), writing nothing", async () => {
    const { deps, calls } = statefulDeps({}, { malformed: true });
    const composition = createSettingsComposition(deps);
    const reset = await composition.resetRepoValue({
      projectId: "p1",
      repoPath: "/orbital",
      key: "visibility",
    });
    const pin = await composition.pinRepoValue({
      projectId: "p1",
      repoPath: "/orbital",
      key: "locus",
    });
    expect(reset.status).toBe("malformed");
    expect(reset.project).toBeNull();
    expect(pin.status).toBe("malformed");
    expect(calls.saved).toBe(0);
  });
});

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

  it("setKeybinding persists a set, an unbind, and a reset — survival re-read (#44)", async () => {
    // A STATEFUL fake store so a write is re-readable (the restart criterion).
    let stored: ClientSettings = { version: 1 };
    const { deps } = makeDeps({
      readGlobalState: () => ({ status: "ok", config: stored }),
      updateGlobal: (update) => {
        stored = update(stored);
        return stored;
      },
    });
    const composition = createSettingsComposition(deps);

    // A string SETS the override; it re-reads from the store (survives restart).
    composition.setKeybinding({ id: "nav.back", keybinding: "mod+e" });
    expect((await composition.get()).keybindings).toEqual({ "nav.back": "mod+e" });

    // A null UNBINDS explicitly (stored as null, distinct from reset).
    composition.setKeybinding({ id: "zoom.in", keybinding: null });
    expect((await composition.get()).keybindings).toEqual({ "nav.back": "mod+e", "zoom.in": null });

    // Omitted keybinding RESETS: the entry is deleted (back to the catalogue default).
    const afterReset = composition.setKeybinding({ id: "nav.back" });
    expect(afterReset).toEqual({ "zoom.in": null });
    expect((await composition.get()).keybindings).toEqual({ "zoom.in": null });
  });

  it("setKeybinding REFUSES a malformed config (Rule 75), writing nothing (#44)", () => {
    const { deps } = makeDeps({
      updateGlobal: () => {
        throw new Error("refused: malformed global config");
      },
    });
    expect(() =>
      createSettingsComposition(deps).setKeybinding({ id: "nav.back", keybinding: "mod+e" }),
    ).toThrow(/malformed/i);
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
    const { deps, calls } = statefulDeps();
    const outcome = await createSettingsComposition(deps).setRepoLocus({
      projectId: "p1",
      repoPath: "/orbital",
      locus: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.locus).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(outcome.locusOverridden).toBe(true);
    expect(calls.applyLocus).toEqual([{ kind: "wsl", distro: "Ubuntu" }]);
    expect(outcome).toMatchObject({
      project: {
        locus: { kind: "wsl", distro: "Ubuntu" },
        locusOverridden: true,
        locusProvenance: { layer: "repo" },
      },
    });
  });

  it("setRepoLocus with null clears the override (back to auto-detect)", async () => {
    const { deps, calls } = statefulDeps({ locus: { kind: "wsl", distro: "Debian" } });
    const outcome = await createSettingsComposition(deps).setRepoLocus({
      projectId: "p1",
      repoPath: "/orbital",
      locus: null,
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.locusOverridden).toBe(false);
    expect(calls.applyLocus).toEqual([null]);
    expect(outcome).toMatchObject({
      project: {
        locus: { kind: "host" },
        locusOverridden: false,
        locusProvenance: { layer: "detected" },
      },
    });
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
