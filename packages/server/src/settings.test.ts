import { escapePath } from "@rennet/core";
import type {
  ClientSettings,
  DaemonSettings,
  DetectedForge,
  Project,
  ProjectVisibility,
} from "@rennet/protocol";
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
    updateDaemon: (update) => update({ version: 1 }),
    listPairedDevices: () => [],
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
    updateDaemon: (update) => update({ version: 1 }),
    listPairedDevices: () => [],
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

  it("setCoachmarks persists skip-all + seen and survives a re-read (C13 reload survival)", async () => {
    // A STATEFUL fake store so a write is re-readable — the reload criterion: the
    // coach store re-seeds from `settings.get` after a restart.
    let stored: ClientSettings = { version: 1 };
    const { deps } = makeDeps({
      readGlobalState: () => ({ status: "ok", config: stored }),
      updateGlobal: (update) => {
        stored = update(stored);
        return stored;
      },
    });
    const composition = createSettingsComposition(deps);

    // A fresh install reads no slice — the client defaults it to empty/false.
    expect((await composition.get()).coachmarks).toBeUndefined();

    // Skip-all + a couple of seen marks persist and read back verbatim (survives reload).
    const written = composition.setCoachmarks({
      seen: ["start-review", "new-chat"],
      skipAll: true,
    });
    expect(written).toEqual({ seen: ["start-review", "new-chat"], skipAll: true });
    expect((await composition.get()).coachmarks).toEqual({
      seen: ["start-review", "new-chat"],
      skipAll: true,
    });

    // Replay clears the slice (seen empty, skip-all false) — also durable.
    composition.setCoachmarks({ seen: [], skipAll: false });
    expect((await composition.get()).coachmarks).toEqual({ seen: [], skipAll: false });
  });

  it("setCoachmarks REFUSES a malformed config (Rule 75), writing nothing (C13)", () => {
    const { deps } = makeDeps({
      updateGlobal: () => {
        throw new Error("refused: malformed global config");
      },
    });
    expect(() =>
      createSettingsComposition(deps).setCoachmarks({ seen: ["fab"], skipAll: false }),
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

  it("includes a paired host with NO project yet, unioned with project sources (finding 9)", async () => {
    const { deps } = makeDeps({
      readDaemonSettings: () => ({ version: 1 }),
      // One project routes to a paired phone; a second device is paired but routes
      // nothing yet. Both must show; the device's friendly name labels each.
      listProjects: () => [project({ id: "a", source: "remote:phone-9" })],
      listPairedDevices: () => [
        {
          deviceId: "phone-9",
          name: "Rai's phone",
          createdAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-27T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        {
          deviceId: "tablet-3",
          name: "Studio tablet",
          createdAt: "2026-08-02T00:00:00.000Z",
          lastSeenAt: "2026-08-27T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    const hosts = (await createSettingsComposition(deps).get()).daemonHosts ?? [];
    // The project-less paired device (tablet-3) is listed even though nothing routes
    // to it; the shared host (phone-9) is not duplicated; the friendly name labels both.
    expect(hosts.map((h) => h.source)).toEqual(["local", "remote:phone-9", "remote:tablet-3"]);
    expect(hosts.find((h) => h.source === "remote:phone-9")?.label).toBe("Remote · Rai's phone");
    expect(hosts.find((h) => h.source === "remote:tablet-3")).toEqual({
      source: "remote:tablet-3",
      label: "Remote · Studio tablet",
      isLocal: false,
    });
  });
});

describe("daemonStatus — per-host daemon detection (C17 cluster 2, #485)", () => {
  /**
   * A composition over a MUTABLE daemon-settings store plus a swappable probe, so a test
   * can watch a host answer, be remembered, then GO DARK across two reads of the same
   * composition — which is the only way the last-seen memory is actually proved.
   */
  function statusDeps(options: {
    projects?: Project[];
    probe?: SettingsCompositionDeps["probeDaemon"];
    latestDaemonVersion?: string;
    stored?: DaemonSettings;
  }) {
    let stored: DaemonSettings = options.stored ?? { version: 1 };
    const { deps } = makeDeps({
      listProjects: () => options.projects ?? [project({ source: "local" })],
      readDaemonSettings: () => stored,
      updateDaemon: (update) => {
        stored = update(stored);
        return stored;
      },
      ...(options.probe ? { probeDaemon: options.probe } : {}),
      ...(options.latestDaemonVersion ? { latestDaemonVersion: options.latestDaemonVersion } : {}),
    });
    return { deps, read: () => stored };
  }

  it("a reachable host yields reachable + its RUNNING version, and remembers it", async () => {
    const { deps, read } = statusDeps({ probe: async () => ({ version: "0.1.5" }) });
    const [status] = await createSettingsComposition(deps).daemonStatus();
    expect(status).toEqual({ source: "local", reachable: true, version: "0.1.5" });
    // The answer is remembered, keyed by host, so a later dark read can name it.
    expect(read().hosts).toEqual({ local: { lastSeenVersion: "0.1.5" } });
  });

  it("a host that STOPS answering reads unreachable with its last-seen version and NO version", async () => {
    let answering = true;
    const { deps } = statusDeps({ probe: async () => (answering ? { version: "0.1.4" } : null) });
    const composition = createSettingsComposition(deps);
    expect(await composition.daemonStatus()).toEqual([
      { source: "local", reachable: true, version: "0.1.4" },
    ]);

    answering = false; // the host goes dark — the card must not keep reading green.
    const [dark] = await composition.daemonStatus();
    expect(dark).toEqual({ source: "local", reachable: false, lastSeenVersion: "0.1.4" });
    // POSITIVE CONTROL (the unreachable-invents-nothing invariant): a host that did not
    // answer carries no running `version` at all — not the last-seen one moved across,
    // not the local daemon's, not a guess. Break the fallback and this fails.
    expect(dark).not.toHaveProperty("version");
    expect(dark?.updateAvailable).toBeUndefined();
  });

  it("a host that has NEVER answered reads unreachable with neither version", async () => {
    const { deps } = statusDeps({
      projects: [project({ id: "b", source: "wsl:Ubuntu" })],
      probe: async (source) => (source === "local" ? { version: "0.1.5" } : null),
    });
    const statuses = await createSettingsComposition(deps).daemonStatus();
    expect(statuses.find((entry) => entry.source === "wsl:Ubuntu")).toEqual({
      source: "wsl:Ubuntu",
      reachable: false,
    });
  });

  it("reports on EVERY host settings.get enumerates — one status per card", async () => {
    const { deps } = statusDeps({
      projects: [project({ id: "a", source: "local" }), project({ id: "b", source: "wsl:Ubuntu" })],
      probe: async () => null,
    });
    const composition = createSettingsComposition(deps);
    const cards = (await composition.get()).daemonHosts ?? [];
    const statuses = await composition.daemonStatus();
    expect(statuses.map((entry) => entry.source)).toEqual(cards.map((card) => card.source));
  });

  it("updateAvailable is a REAL comparison, and absent when either side is unknown", async () => {
    // Running older than the version this daemon ships ⇒ an update genuinely exists.
    const behind = statusDeps({
      probe: async () => ({ version: "0.1.4" }),
      latestDaemonVersion: "0.1.5",
    });
    expect((await createSettingsComposition(behind.deps).daemonStatus())[0]).toMatchObject({
      updateAvailable: true,
    });

    // Running the latest ⇒ false, not a nagging flag.
    const current = statusDeps({
      probe: async () => ({ version: "0.1.5" }),
      latestDaemonVersion: "0.1.5",
    });
    expect((await createSettingsComposition(current.deps).daemonStatus())[0]).toMatchObject({
      updateAvailable: false,
    });

    // No latest known (no update mechanism) ⇒ WITHHELD, so the button cannot show.
    const unknownLatest = statusDeps({ probe: async () => ({ version: "0.1.4" }) });
    const [status] = await createSettingsComposition(unknownLatest.deps).daemonStatus();
    expect(status).not.toHaveProperty("updateAvailable");

    // Answered but could not name its version ⇒ reachable, no version, no flag.
    const noVersion = statusDeps({
      probe: async () => ({ version: null }),
      latestDaemonVersion: "0.1.5",
    });
    expect((await createSettingsComposition(noVersion.deps).daemonStatus())[0]).toEqual({
      source: "local",
      reachable: true,
    });
  });

  it("a probe that THROWS reads unreachable, never a fabricated version", async () => {
    const { deps } = statusDeps({
      stored: { version: 1, hosts: { local: { lastSeenVersion: "0.1.3" } } },
      probe: async () => {
        throw new Error("wsl.exe is not installed");
      },
    });
    expect((await createSettingsComposition(deps).daemonStatus())[0]).toEqual({
      source: "local",
      reachable: false,
      lastSeenVersion: "0.1.3",
    });
  });

  it("a malformed daemon-settings refuses the remember-write without failing the read", async () => {
    const { deps } = makeDeps({
      probeDaemon: async () => ({ version: "0.1.5" }),
      updateDaemon: () => {
        throw new Error("refusing to overwrite a malformed config");
      },
    });
    expect(await createSettingsComposition(deps).daemonStatus()).toEqual([
      { source: "local", reachable: true, version: "0.1.5" },
    ]);
  });

  it("no probe at all ⇒ every host reads unreachable (nothing to ask, nothing invented)", async () => {
    const { deps } = makeDeps({});
    expect(await createSettingsComposition(deps).daemonStatus()).toEqual([
      { source: "local", reachable: false },
    ]);
  });
});

describe("reconnect — the on-demand re-handshake (C17 cluster 5, #533)", () => {
  /** A composition over a mutable daemon-settings store plus a swappable reconnect effect. */
  function reconnectDeps(options: {
    reconnect?: SettingsCompositionDeps["reconnectDaemon"];
    probe?: SettingsCompositionDeps["probeDaemon"];
    stored?: DaemonSettings;
    latestDaemonVersion?: string;
  }) {
    let stored: DaemonSettings = options.stored ?? { version: 1 };
    const { deps } = makeDeps({
      listProjects: () => [project({ source: "local" })],
      readDaemonSettings: () => stored,
      updateDaemon: (update) => {
        stored = update(stored);
        return stored;
      },
      ...(options.reconnect ? { reconnectDaemon: options.reconnect } : {}),
      ...(options.probe ? { probeDaemon: options.probe } : {}),
      ...(options.latestDaemonVersion ? { latestDaemonVersion: options.latestDaemonVersion } : {}),
    });
    return { deps, read: () => stored };
  }

  it("a successful re-handshake reports the host reachable and remembers the version", async () => {
    const { deps, read } = reconnectDeps({ reconnect: async () => ({ version: "0.1.5" }) });
    expect(await createSettingsComposition(deps).reconnect("local")).toEqual({
      status: { source: "local", reachable: true, version: "0.1.5" },
    });
    // A real sighting, remembered exactly as the poll remembers one.
    expect(read().hosts).toEqual({ local: { lastSeenVersion: "0.1.5" } });
  });

  it("POSITIVE CONTROL: a FAILING re-handshake stays unreachable and carries the reason", async () => {
    // The whole point of the button being real: an attempt that did not complete must not
    // read green. Return a reachable status here from anything but a real answer and this fails.
    const { deps } = reconnectDeps({
      stored: { version: 1, hosts: { local: { lastSeenVersion: "0.1.3" } } },
      reconnect: async () => {
        throw new Error('No Rennet daemon answered in WSL distro "Ubuntu".');
      },
    });
    const outcome = await createSettingsComposition(deps).reconnect("local");
    expect(outcome.status.reachable).toBe(false);
    // The handshake's own reason, verbatim — not a generic "failed".
    expect(outcome.error).toBe('No Rennet daemon answered in WSL distro "Ubuntu".');
    // And no fabricated running version: only the last-seen it really answered with before.
    expect(outcome.status).not.toHaveProperty("version");
    expect(outcome.status.lastSeenVersion).toBe("0.1.3");
  });

  it("a host that answers NOTHING (no throw) is unreachable with no error line invented", async () => {
    const { deps } = reconnectDeps({ reconnect: async () => null });
    expect(await createSettingsComposition(deps).reconnect("local")).toEqual({
      status: { source: "local", reachable: false },
    });
  });

  it("ruled-out agents on the host survive a reconnect that learns a new version", async () => {
    const { deps, read } = reconnectDeps({
      stored: { version: 1, hosts: { local: { disabledHarnesses: ["codex"] } } },
      reconnect: async () => ({ version: "0.1.6" }),
    });
    await createSettingsComposition(deps).reconnect("local");
    expect(read().hosts?.local).toEqual({
      disabledHarnesses: ["codex"],
      lastSeenVersion: "0.1.6",
    });
  });

  it("with no reconnect effect wired it falls back to the ordinary probe — still a real attempt", async () => {
    const { deps } = reconnectDeps({ probe: async () => ({ version: "0.1.5" }) });
    expect(await createSettingsComposition(deps).reconnect("local")).toEqual({
      status: { source: "local", reachable: true, version: "0.1.5" },
    });
  });
});

describe("setTrackerValue — the global-rung tracker write (#461, B7)", () => {
  it("writes, resets, and validates through the registry declarations", () => {
    let stored: DaemonSettings = { version: 1 };
    const { deps } = makeDeps({
      updateDaemon: (update) => {
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

describe("harnessHosts + setHarnessEnabled — per-host agents (C17 cluster 3, #485)", () => {
  /** A composition over a MUTABLE daemon-settings store plus a per-host detection stub. */
  function agentDeps(options: {
    projects?: Project[];
    detect?: SettingsCompositionDeps["detectHarnessesOn"];
    stored?: DaemonSettings;
  }) {
    let stored: DaemonSettings = options.stored ?? { version: 1 };
    const { deps } = makeDeps({
      listProjects: () =>
        options.projects ?? [
          project({ source: "local" }),
          project({ id: "b", source: "wsl:Ubuntu" }),
        ],
      readDaemonSettings: () => stored,
      updateDaemon: (update) => {
        stored = update(stored);
        return stored;
      },
      ...(options.detect ? { detectHarnessesOn: options.detect } : {}),
    });
    return { deps, read: () => stored };
  }

  /** Each host reports its OWN harnesses; the local machine has both, the distro only codex. */
  const perHost: SettingsCompositionDeps["detectHarnessesOn"] = async (source) =>
    source === "local"
      ? [
          { id: "claude", version: "2.1.0" },
          { id: "codex", version: "0.9.0" },
        ]
      : [{ id: "codex", version: "0.8.0" }];

  it("two hosts each report THEIR OWN harnesses — never the local set copied across", async () => {
    const { deps } = agentDeps({ detect: perHost });
    const hosts = await createSettingsComposition(deps).harnessHosts();

    expect(hosts.map((host) => host.source)).toEqual(["local", "wsl:Ubuntu"]);
    expect(hosts[0]).toEqual({
      source: "local",
      asked: true,
      detected: [
        { id: "claude", version: "2.1.0", enabled: true },
        { id: "codex", version: "0.9.0", enabled: true },
      ],
    });
    // POSITIVE CONTROL (the no-fabrication law at unit scale): `claude` is absent from the
    // distro's answer, so the distro has NO claude row and its codex carries the DISTRO's
    // version. Copy the local set across — the bug this guards — and both assertions fail.
    expect(hosts[1]?.detected).toEqual([{ id: "codex", version: "0.8.0", enabled: true }]);
    expect(hosts[1]?.detected.some((harness) => harness.id === "claude")).toBe(false);
  });

  it("reports on EVERY host settings.get enumerates — one entry per card", async () => {
    const { deps } = agentDeps({ detect: perHost });
    const composition = createSettingsComposition(deps);
    const cards = (await composition.get()).daemonHosts ?? [];
    const hosts = await composition.harnessHosts();
    expect(hosts.map((host) => host.source)).toEqual(cards.map((card) => card.source));
  });

  it("a host that CANNOT be asked reads honestly absent, not 'no agents installed'", async () => {
    const { deps } = agentDeps({
      // null = unaskable (a paired device that dials US); a throw is the same nothing.
      detect: async (source) => {
        if (source === "local") return [{ id: "claude", version: "2.1.0" }];
        throw new Error("wsl.exe is not installed");
      },
    });
    const hosts = await createSettingsComposition(deps).harnessHosts();
    expect(hosts[1]).toEqual({ source: "wsl:Ubuntu", asked: false, detected: [] });
    // The distinction the flag exists for: asked-with-nothing is a REAL claim, and this is not it.
    expect(hosts[1]?.asked).toBe(false);
  });

  it("a host with NO detection dep at all is unasked — never given this machine's agents", async () => {
    const { deps } = agentDeps({});
    expect(await createSettingsComposition(deps).harnessHosts()).toEqual([
      { source: "local", asked: false, detected: [] },
      { source: "wsl:Ubuntu", asked: false, detected: [] },
    ]);
  });

  it("toggling an agent off on ONE host persists and leaves the other host untouched", async () => {
    const { deps, read } = agentDeps({ detect: perHost });
    const composition = createSettingsComposition(deps);

    expect(
      composition.setHarnessEnabled({ source: "local", harnessId: "codex", enabled: false }),
    ).toEqual(["codex"]);
    expect(read().hosts).toEqual({ local: { disabledHarnesses: ["codex"] } });

    // A RE-READ reflects it: the decision came back from the store, not from a session set.
    const hosts = await composition.harnessHosts();
    expect(hosts[0]?.detected).toEqual([
      { id: "claude", version: "2.1.0", enabled: true },
      // Still DETECTED and still listed — ruled out of reviews, not uninstalled or hidden.
      { id: "codex", version: "0.9.0", enabled: false },
    ]);
    // The other host's codex is untouched — the decision is scoped to the host.
    expect(hosts[1]?.detected).toEqual([{ id: "codex", version: "0.8.0", enabled: true }]);

    // Re-enabling drops the id rather than accumulating a tombstone.
    expect(
      composition.setHarnessEnabled({ source: "local", harnessId: "codex", enabled: true }),
    ).toEqual([]);
    expect((await composition.harnessHosts())[0]?.detected.every((h) => h.enabled)).toBe(true);
  });

  it("a status poll that learns a version does NOT un-rule-out an agent on that host", async () => {
    const { deps, read } = agentDeps({ detect: perHost });
    const composition = createSettingsComposition(deps);
    composition.setHarnessEnabled({ source: "local", harnessId: "claude", enabled: false });

    // The two facts share one host entry, written by two different paths. Replace the entry
    // instead of merging it — the bug this guards — and the decision silently vanishes.
    await createSettingsComposition({
      ...deps,
      probeDaemon: async () => ({ version: "0.1.5" }),
    }).daemonStatus();

    expect(read().hosts?.local).toEqual({
      disabledHarnesses: ["claude"],
      lastSeenVersion: "0.1.5",
    });
    expect((await composition.harnessHosts())[0]?.detected[0]).toEqual({
      id: "claude",
      version: "2.1.0",
      enabled: false,
    });
  });

  it("a malformed daemon-settings REFUSES the decision rather than reporting a false success", () => {
    const { deps } = makeDeps({
      detectHarnessesOn: async () => [{ id: "claude", version: "2.1.0" }],
      updateDaemon: () => {
        throw new Error("daemon-settings is malformed");
      },
    });
    expect(() =>
      createSettingsComposition(deps).setHarnessEnabled({
        source: "local",
        harnessId: "claude",
        enabled: false,
      }),
    ).toThrow(/malformed/);
  });
});

describe("setForgeEnabled — the forge ruling the toggle was missing (C17 amendment A)", () => {
  /** A composition over a MUTABLE daemon-settings store, detecting one agent on each host. */
  function forgeDeps(stored?: DaemonSettings) {
    let store: DaemonSettings = stored ?? { version: 1 };
    const { deps } = makeDeps({
      listProjects: () => [
        project({ source: "local" }),
        project({ id: "b", source: "wsl:Ubuntu" }),
      ],
      readDaemonSettings: () => store,
      updateDaemon: (update) => {
        store = update(store);
        return store;
      },
      detectHarnessesOn: async () => [{ id: "claude", version: "2.1.0" }],
    });
    return { deps, read: () => store };
  }

  it("POSITIVE CONTROL: a forge ruled out on a host READS BACK disabled; an unruled host reads enabled", async () => {
    // The whole gap amendment A closes: before the served read this toggle wrote nowhere and
    // every re-read said enabled. Drop the store or the read and this fails.
    const { deps, read } = forgeDeps();
    const composition = createSettingsComposition(deps);

    // No ruling yet ⇒ enabled by default, honestly, with no entry invented for it.
    expect((await composition.harnessHosts())[0]?.disabledForges).toBeUndefined();

    expect(
      composition.setForgeEnabled({ source: "local", forgeId: "github", enabled: false }),
    ).toEqual(["github"]);
    expect(read().hosts).toEqual({ local: { disabledForges: ["github"] } });

    // The RE-READ carries it — from the store, not from a session flag.
    const hosts = await composition.harnessHosts();
    expect(hosts[0]?.disabledForges).toEqual(["github"]);
    // Scoped to the host: the other card's `gh` is untouched.
    expect(hosts[1]?.disabledForges).toBeUndefined();

    // Re-enabling drops the id rather than accumulating a tombstone.
    expect(
      composition.setForgeEnabled({ source: "local", forgeId: "github", enabled: true }),
    ).toEqual([]);
    expect((await composition.harnessHosts())[0]?.disabledForges).toBeUndefined();
  });

  it("the forge ruling and the agent ruling share an entry without clobbering each other", async () => {
    const { deps, read } = forgeDeps();
    const composition = createSettingsComposition(deps);
    composition.setHarnessEnabled({ source: "local", harnessId: "claude", enabled: false });
    composition.setForgeEnabled({ source: "local", forgeId: "github", enabled: false });

    expect(read().hosts?.local).toEqual({
      disabledHarnesses: ["claude"],
      disabledForges: ["github"],
    });
    const [local] = await composition.harnessHosts();
    expect(local?.detected[0]?.enabled).toBe(false);
    expect(local?.disabledForges).toEqual(["github"]);
  });

  it("a host that could not be ASKED still carries its forge ruling — it is a decision, not a detection", async () => {
    const { deps } = forgeDeps({ version: 1, hosts: { local: { disabledForges: ["github"] } } });
    const composition = createSettingsComposition({ ...deps, detectHarnessesOn: async () => null });
    const [local] = await composition.harnessHosts();
    expect(local).toEqual({
      source: "local",
      asked: false,
      detected: [],
      disabledForges: ["github"],
    });
  });

  it("a malformed daemon-settings REFUSES the forge decision rather than faking success", () => {
    const { deps } = makeDeps({
      updateDaemon: () => {
        throw new Error("daemon-settings is malformed");
      },
    });
    expect(() =>
      createSettingsComposition(deps).setForgeEnabled({
        source: "local",
        forgeId: "github",
        enabled: false,
      }),
    ).toThrow(/malformed/);
  });
});

describe("forgeHosts — per-host forge CLIs (C17 amendment B)", () => {
  /** A composition over two hosts plus a swappable per-host forge detection stub. */
  function hostsDeps(detect?: SettingsCompositionDeps["detectForgesOn"]) {
    const { deps } = makeDeps({
      listProjects: () => [
        project({ source: "local" }),
        project({ id: "b", source: "wsl:Ubuntu" }),
      ],
      ...(detect ? { detectForgesOn: detect } : {}),
    });
    return deps;
  }

  const gh = (version: string): DetectedForge => ({
    id: "github",
    version,
    status: "available",
    detail: "Authenticated with GitHub through the `gh` CLI.",
  });

  it("each host reports ITS OWN gh — the distro's version, never this machine's", async () => {
    // The gap amendment B closes: keyed to the connected host alone, the distro card could
    // never show a `gh` it really has. Copy the local answer across and this fails too.
    const hosts = await createSettingsComposition(
      hostsDeps(async (source) => [gh(source === "local" ? "2.76.0" : "2.40.0")]),
    ).forgeHosts();
    expect(hosts).toEqual([
      { source: "local", asked: true, detected: [gh("2.76.0")] },
      { source: "wsl:Ubuntu", asked: true, detected: [gh("2.40.0")] },
    ]);
  });

  it("reports on EVERY host settings.get enumerates — one entry per card", async () => {
    const composition = createSettingsComposition(hostsDeps(async () => [gh("2.76.0")]));
    const cards = (await composition.get()).daemonHosts ?? [];
    expect((await composition.forgeHosts()).map((host) => host.source)).toEqual(
      cards.map((card) => card.source),
    );
  });

  it("POSITIVE CONTROL: a host that cannot be asked reads honestly absent, never a borrowed gh", async () => {
    const hosts = await createSettingsComposition(
      hostsDeps(async (source) => (source === "local" ? [gh("2.76.0")] : null)),
    ).forgeHosts();
    expect(hosts[1]).toEqual({ source: "wsl:Ubuntu", asked: false, detected: [] });
    // Bind the unasked host to the local answer — the exact bug — and this fails.
    expect(hosts[1]?.detected).toHaveLength(0);
  });

  it("a detection that THROWS is unasked, and a host asked with nothing found says so", async () => {
    const rejected = await createSettingsComposition(
      hostsDeps(async () => {
        throw new Error("gh probe blew up");
      }),
    ).forgeHosts();
    expect(rejected.every((host) => host.asked === false)).toBe(true);

    // Asked-and-empty is the DIFFERENT, real claim: that host has no forge CLI installed.
    const empty = await createSettingsComposition(hostsDeps(async () => [])).forgeHosts();
    expect(empty[0]).toEqual({ source: "local", asked: true, detected: [] });
  });

  it("no detection dep at all ⇒ every host unasked (nothing to ask, nothing invented)", async () => {
    const hosts = await createSettingsComposition(hostsDeps()).forgeHosts();
    expect(hosts.every((host) => host.asked === false && host.detected.length === 0)).toBe(true);
  });
});

describe("update — the real daemon update behind Update Daemon (C17 cluster 6, #534)", () => {
  /** A composition over a mutable daemon-settings store plus a swappable update effect. */
  function updateDeps(options: {
    update?: SettingsCompositionDeps["updateDaemonOn"];
    probe?: SettingsCompositionDeps["probeDaemon"];
    stored?: DaemonSettings;
    latestDaemonVersion?: string;
  }) {
    let stored: DaemonSettings = options.stored ?? { version: 1 };
    const { deps } = makeDeps({
      listProjects: () => [project({ id: "b", source: "wsl:Ubuntu" })],
      readDaemonSettings: () => stored,
      updateDaemon: (update) => {
        stored = update(stored);
        return stored;
      },
      ...(options.update ? { updateDaemonOn: options.update } : {}),
      ...(options.probe ? { probeDaemon: options.probe } : {}),
      ...(options.latestDaemonVersion ? { latestDaemonVersion: options.latestDaemonVersion } : {}),
    });
    return { deps, read: () => stored };
  }

  it("a successful update reports the NEW version the host answered with, and remembers it", async () => {
    const { deps, read } = updateDeps({
      stored: { version: 1, hosts: { "wsl:Ubuntu": { lastSeenVersion: "0.1.3" } } },
      update: async () => ({ version: "0.2.0" }),
      latestDaemonVersion: "0.2.0",
    });
    expect(await createSettingsComposition(deps).update("wsl:Ubuntu")).toEqual({
      status: {
        source: "wsl:Ubuntu",
        reachable: true,
        version: "0.2.0",
        // Now current, so the button stops offering an update — a real comparison, not a flag.
        updateAvailable: false,
      },
    });
    expect(read().hosts?.["wsl:Ubuntu"]?.lastSeenVersion).toBe("0.2.0");
  });

  it("POSITIVE CONTROL: a FAILING update carries the reason and invents no new version", async () => {
    // Report success from anything but the host's own post-update answer and this fails.
    const { deps, read } = updateDeps({
      stored: { version: 1, hosts: { "wsl:Ubuntu": { lastSeenVersion: "0.1.3" } } },
      update: async () => {
        throw new Error('No Node runtime in WSL distro "Ubuntu".');
      },
    });
    const outcome = await createSettingsComposition(deps).update("wsl:Ubuntu");
    expect(outcome.status.reachable).toBe(false);
    expect(outcome.error).toBe('No Node runtime in WSL distro "Ubuntu".');
    expect(outcome.status).not.toHaveProperty("version");
    expect(outcome.status.lastSeenVersion).toBe("0.1.3");
    // Nothing was learned, so nothing was remembered — the store still holds the old sighting.
    expect(read().hosts?.["wsl:Ubuntu"]?.lastSeenVersion).toBe("0.1.3");
  });

  it("with NO update mechanism it says so — and never falls back to a probe that reads green", async () => {
    // The trap this guards: reusing `probeDaemon` here would report the host reachable on its
    // OLD version and the card would read as though the update had happened.
    const { deps } = updateDeps({ probe: async () => ({ version: "0.1.3" }) });
    const outcome = await createSettingsComposition(deps).update("wsl:Ubuntu");
    expect(outcome.status.reachable).toBe(false);
    expect(outcome.error).toBe("Rennet has no way to update this host's daemon.");
    expect(outcome.status).not.toHaveProperty("version");
  });

  it("ruled-out agents on the host survive an update that learns a new version", async () => {
    const { deps, read } = updateDeps({
      stored: { version: 1, hosts: { "wsl:Ubuntu": { disabledHarnesses: ["codex"] } } },
      update: async () => ({ version: "0.2.0" }),
    });
    await createSettingsComposition(deps).update("wsl:Ubuntu");
    expect(read().hosts?.["wsl:Ubuntu"]).toEqual({
      disabledHarnesses: ["codex"],
      lastSeenVersion: "0.2.0",
    });
  });
});
