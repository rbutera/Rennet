import { escapePath } from "@rennet/core";
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
    clearRepoValue: { repoKey: string; field: "visibility" }[];
    discoverWorkspaceRepos: number;
    updateGlobal: number;
  };
} {
  const calls = {
    loadConfigState: [] as string[],
    applyVisibility: [] as { repoKey: string; repoRoot: string; target: ProjectVisibility }[],
    clearRepoValue: [] as { repoKey: string; field: "visibility" }[],
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
    readDaemonSettings: () => ({ version: 1 }),
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
    clearRepoValue: ({ repoKey, field }) => {
      calls.clearRepoValue.push({ repoKey, field });
    },
    ...overrides,
  };
  return { deps, calls };
}

/**
 * A composition over a MUTABLE fake config store: writes (applyVisibility,
 * clearRepoValue) mutate the backing config, so a post-write re-resolution reads the
 * state the write left behind — the honest path reset/pin take (they re-resolve the
 * row from the live store after writing).
 */
function statefulDeps(
  initial: { visibility?: ProjectVisibility; promoted?: boolean } = {},
  opts: { malformed?: boolean; project?: Project } = {},
): {
  deps: SettingsCompositionDeps;
  store: { visibility?: ProjectVisibility; promoted?: boolean };
  calls: {
    applyVisibility: ProjectVisibility[];
    clearRepoValue: "visibility"[];
    saved: number;
  };
} {
  const store: { visibility?: ProjectVisibility; promoted?: boolean } = {
    ...initial,
  };
  const calls = {
    applyVisibility: [] as ProjectVisibility[],
    clearRepoValue: [] as "visibility"[],
    saved: 0,
  };
  const deps: SettingsCompositionDeps = {
    listProjects: () => [opts.project ?? project()],
    loadConfigState: () =>
      opts.malformed
        ? { status: "malformed", config: null }
        : { status: "ok", config: { ...store } },
    readGlobalState: () => ({ status: "ok", config: { version: 1 } }),
    readDaemonSettings: () => ({ version: 1 }),
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
    clearRepoValue: ({ field }) => {
      calls.clearRepoValue.push(field);
      delete store[field];
      calls.saved += 1;
    },
  };
  return { deps, store, calls };
}

describe("createSettingsComposition — locus is a detected fact (#476)", () => {
  it("get() reports the detected locus with `detected` provenance, no override notion", async () => {
    const { deps } = makeDeps();
    const row = (await createSettingsComposition(deps).get()).projects[0];
    expect(row?.locus).toEqual({ kind: "host" });
    expect(row?.locusProvenance.layer).toBe("detected");
    expect(row?.locusProvenance.contributions.every((c) => c.layer === "detected")).toBe(true);
  });

  it("detects a WSL-UNC project's locus straight from the path", async () => {
    const repoPath = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo";
    const { deps } = makeDeps({
      listProjects: () => [project({ path: repoPath, openPath: repoPath })],
      gitTopLevel: async () => repoPath,
    });
    expect((await createSettingsComposition(deps).get()).projects[0]?.locus).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
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
      key: "visibility",
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
      key: "visibility",
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
});

describe("createSettingsComposition — daemon host sections (#476, §4.2)", () => {
  it("lists the local host first, carrying its daemon-settings listener rung", async () => {
    const { deps } = makeDeps({
      readDaemonSettings: () => ({
        version: 1,
        daemon: { listen: { host: "100.64.0.1", port: 7777 } },
      }),
    });
    const view = await createSettingsComposition(deps).get();
    expect(view.daemonHosts?.[0]).toEqual({
      source: "local",
      label: "This machine",
      isLocal: true,
      listen: { host: "100.64.0.1", port: 7777 },
    });
  });

  it("enumerates EVERY paired host a project routes to, not just local — remote rungs live on that host", async () => {
    const { deps } = makeDeps({
      readDaemonSettings: () => ({ version: 1 }),
      listProjects: () => [
        project({ id: "a", source: "local" }),
        project({ id: "b", source: "wsl:Ubuntu" }),
        project({ id: "c", source: "remote:phone-9" }),
        project({ id: "d", source: "wsl:Ubuntu" }), // dedup
      ],
    });
    const hosts = (await createSettingsComposition(deps).get()).daemonHosts ?? [];
    expect(hosts.map((h) => h.source)).toEqual(["local", "wsl:Ubuntu", "remote:phone-9"]);
    // The local host carries no listen (loopback default here); non-local hosts are LISTED
    // but their rung is not fabricated — it lives on that host.
    expect(hosts[0]).toMatchObject({ isLocal: true });
    expect(hosts[1]).toEqual({ source: "wsl:Ubuntu", label: "WSL · Ubuntu", isLocal: false });
    expect(hosts[2]).toEqual({
      source: "remote:phone-9",
      label: "Remote · phone-9",
      isLocal: false,
    });
    for (const h of hosts.slice(1)) expect(h.listen).toBeUndefined();
  });
});

describe("setTrackerValue — the global-rung tracker write (#461, B7)", () => {
  it("writes, resets, and validates through the registry declarations", () => {
    let stored: GlobalConfig = { version: 1 };
    const { deps } = makeDeps({
      updateGlobal: (update) => {
        stored = update(stored);
        return stored;
      },
    });
    const composition = createSettingsComposition(deps);

    expect(composition.setTrackerValue({ key: "kind", value: "jira" })).toEqual({ kind: "jira" });
    expect(composition.setTrackerValue({ key: "baseUrl", value: " https://j.example " })).toEqual({
      kind: "jira",
      baseUrl: "https://j.example",
    });
    // Reset drops the entry so the ladder falls back down.
    expect(composition.setTrackerValue({ key: "baseUrl", value: null })).toEqual({ kind: "jira" });
    // An illegal kind refuses through the SAME validator the resolver reads.
    expect(() => composition.setTrackerValue({ key: "kind", value: "asana" })).toThrow(
      /trackerKind/,
    );
  });
});
