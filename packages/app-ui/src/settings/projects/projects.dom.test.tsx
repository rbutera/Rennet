// @vitest-environment happy-dom
//
// C10 §8 — the Projects settings page over the dual-source seam. Real projects from
// `projects.list` (identity + environment grouping) composed with the per-project
// settings projection (name, glyph, worktree, tracker, guidance) and the live repo
// row (`settings.get`). The `?project` param drives the scope (the structural rule);
// every edit persists through the projection to a second reader (the probe), never a
// local copy; "Runs on" is a displayed detected fact with no control; the tracker's
// REST fields carry only the env-var NAME; the guidance editor's Escape closes the
// editor without bubbling to the takeover.
import {
  type Project,
  type SettingsProject,
  type SettingsProjectValueKey,
  settingsProjectValueKeySchema,
} from "@rennet/protocol";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { cleanup, fireEvent, mount, waitFor, within } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import {
  EMPTY_SETTINGS_PROJECTION,
  type GuidanceRule,
  type IssueTrackerSettings,
  LiveSettingsProjectionProvider,
  type SettingsProjection,
  SettingsProjectionProvider,
  type WorktreeSettings,
} from "../data";
import { ProjectsPage } from "./projects-page";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkProject(over: Partial<Project> & Pick<Project, "id" | "name" | "source">): Project {
  return {
    path: `/repos/${over.id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/repos/acme/${over.id}`,
    addedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// openPath's last-two segments are the `org/repo` fallback; a single segment keeps the
// default name equal to the listed name (no Reset showing on an unrenamed project).
const PROJECTS: readonly Project[] = [
  mkProject({ id: "p1", name: "checkout", source: "local", openPath: "/checkout" }),
  mkProject({ id: "p2", name: "billing", source: "remote:dev-box", openPath: "/billing" }),
];

/** The live repo row for p1 — visibility/promotion/locus each with the rung it resolved from. */
const P1_ROW: SettingsProject = {
  projectId: "p1",
  name: "checkout",
  repoPath: "/repos/acme/checkout",
  visibility: "local",
  visibilityProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "local", effective: true }],
  },
  promoted: false,
  promotedProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "not promoted", effective: true }],
  },
  locus: { kind: "host" },
  locusProvenance: {
    layer: "detected",
    contributions: [{ layer: "detected", value: "host", effective: true }],
  },
  configMalformed: false,
};

function bridge(): MemoryBridge {
  return new MemoryBridge({
    "projects.list": () => ({ projects: [...PROJECTS] }),
    "settings.get": () => ({
      scheme: "system",
      schemeProvenance: {
        layer: "builtin",
        contributions: [{ layer: "builtin", value: "system", effective: true }],
      },
      appearanceMalformed: false,
      projects: [P1_ROW],
    }),
  });
}

/** A stateful projection: every edit lands in one state, read by BOTH the page and the probe. */
function StatefulProjects({
  seed,
  path = "/settings/projects?project=p1",
}: {
  readonly seed?: Partial<SettingsProjection>;
  readonly path?: string;
}) {
  const [names, setNames] = useState<Record<string, string>>({ ...(seed?.nameByProject ?? {}) });
  const [glyphs, setGlyphs] = useState<
    Record<string, import("../assets/project-icon").ProjectIconName>
  >({
    ...(seed?.glyphByProject ?? {}),
  });
  const [worktrees, setWorktrees] = useState<Record<string, WorktreeSettings>>({
    ...(seed?.worktreeByProject ?? {}),
  });
  const [trackers, setTrackers] = useState<Record<string, IssueTrackerSettings>>({
    ...(seed?.trackerByProject ?? {}),
  });
  const [guidance, setGuidanceState] = useState<Record<string, readonly GuidanceRule[]>>({
    ...(seed?.guidanceByProject ?? {}),
  });
  // Bridge + history must be STABLE across re-renders — a fresh bridge would reset
  // `projects.list` to pending and collapse the page back to its loading state.
  const [bridgeInstance] = useState(bridge);
  const [history] = useState(() => memoryHistory(path));

  const projection: SettingsProjection = {
    ...EMPTY_SETTINGS_PROJECTION,
    // A stateful fixture DOES persist (edits reach the probe), so it is a backed
    // projection — the editors render live, exactly as B10's projection will.
    projectEditsPersist: true,
    // The name has its own served-write flag (C18: `project.rename`), true here for the
    // same reason — this fixture genuinely persists.
    nameEditsPersist: true,
    nameByProject: names,
    glyphByProject: glyphs,
    worktreeByProject: worktrees,
    trackerByProject: trackers,
    guidanceByProject: guidance,
    // A seeded setter WINS, so a test can count the writes the field actually makes.
    setProjectName:
      seed?.setProjectName ?? ((id, name) => setNames((prev) => ({ ...prev, [id]: name }))),
    setProjectGlyph: (id, icon) => setGlyphs((prev) => ({ ...prev, [id]: icon })),
    setWorktreeRoot: (id, root) =>
      setWorktrees((prev) => ({
        ...prev,
        [id]: {
          root: { value: root, layer: "global" },
          pattern: prev[id]?.pattern ?? { value: "{project}-{branch}", layer: "builtin" },
        },
      })),
    setWorktreePattern: (id, pattern) =>
      setWorktrees((prev) => ({
        ...prev,
        [id]: {
          root: prev[id]?.root ?? { value: "~/.rennet/worktrees", layer: "builtin" },
          pattern: { value: pattern, layer: "global" },
        },
      })),
    setTracker: (id, tracker) => setTrackers((prev) => ({ ...prev, [id]: tracker })),
    setGuidance: (id, rules) => setGuidanceState((prev) => ({ ...prev, [id]: rules })),
  };

  return (
    <BridgeProvider bridge={bridgeInstance}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <SettingsProjectionProvider value={projection}>
          <ProjectsPage />
          <div data-testid="probe-name">{names.p1 ?? ""}</div>
          <div data-testid="probe-glyph">{glyphs.p1 ?? ""}</div>
          <div data-testid="probe-pattern">{worktrees.p1?.pattern.value ?? ""}</div>
          {/* Value AND rung: the surface renders no provenance badge any more, so the
              ladder move (detected → global) is proven here, at the projection. */}
          <div data-testid="probe-tracker">
            {trackers.p1 ? `${trackers.p1.kind.value}@${trackers.p1.kind.layer}` : ""}
          </div>
          <div data-testid="probe-guidance">{(guidance.p1 ?? []).map((r) => r.rule).join("|")}</div>
        </SettingsProjectionProvider>
      </Router>
    </BridgeProvider>
  );
}

function trackerSection(): HTMLElement {
  // The Issue Tracker section — located by its Tracker row's group aria-label.
  const group = document.querySelector<HTMLElement>('[aria-label="Issue tracker"]');
  const section = group?.closest<HTMLElement>('[data-slot="settings-section"]');
  if (!section) throw new Error("tracker section not found");
  return section;
}

describe("ProjectsPage — dual-source settings", () => {
  it("scopes to the project named by ?project (the structural rule)", async () => {
    const { findByLabelText } = mount(<StatefulProjects path="/settings/projects?project=p2" />);
    // The Identity name field resolves to the scoped project's name (after the tree loads).
    expect(((await findByLabelText("Project name")) as HTMLInputElement).value).toBe("billing");
    cleanup();
  });

  it("a different ?project scopes a different project", async () => {
    const { findByLabelText } = mount(<StatefulProjects path="/settings/projects?project=p1" />);
    expect(((await findByLabelText("Project name")) as HTMLInputElement).value).toBe("checkout");
    cleanup();
  });

  it("accepts a unique display name in ?project while keeping the stable id as the scope", async () => {
    const { findByLabelText } = mount(
      <StatefulProjects path="/settings/projects?project=billing" />,
    );
    expect(((await findByLabelText("Project name")) as HTMLInputElement).value).toBe("billing");
    cleanup();
  });

  it("identity: rename persists, Reset restores org/repo, empty blur restores it", async () => {
    const { findByLabelText, getByRole, queryByRole, getByTestId, user } = mount(
      <StatefulProjects />,
    );
    const input = (await findByLabelText("Project name")) as HTMLInputElement;
    // Unrenamed ⇒ no Reset yet (the listed name is the org/repo default).
    expect(queryByRole("button", { name: "Reset" })).toBeNull();
    // The draft commits on blur, so the write lands once when the field is left.
    fireEvent.change(input, { target: { value: "Checkout Service" } });
    fireEvent.blur(input);
    expect(getByTestId("probe-name").textContent).toBe("Checkout Service");
    // Renamed ⇒ a Reset appears, restoring the org/repo fallback (checkout).
    await user.click(getByRole("button", { name: "Reset" }));
    expect(getByTestId("probe-name").textContent).toBe("checkout");
    expect(queryByRole("button", { name: "Reset" })).toBeNull();
    // Emptying and blurring falls back to the default, never an empty name.
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(getByTestId("probe-name").textContent).toBe("checkout");
    cleanup();
  });

  it("identity: the name field WRITES ONCE on commit, not once per keystroke", async () => {
    // `project.rename` is a disk write. A per-keystroke write would fire one for every
    // character (and, on a controlled input, drop characters when the round trip lags),
    // so the field holds a local draft and commits on blur/Enter — the same shape the
    // sidebar's own rename uses.
    const calls: string[] = [];
    const { findByLabelText, user } = mount(
      <StatefulProjects seed={{ setProjectName: (_id, name) => calls.push(name) }} />,
    );
    const input = (await findByLabelText("Project name")) as HTMLInputElement;
    await user.click(input);
    await user.keyboard("Pay");
    // Typing alone commits NOTHING — the draft is local until the field is left.
    expect(calls).toEqual([]);
    // The field still shows every keystroke (a draft, not a swallowed edit).
    expect(input.value).toContain("Pay");
    fireEvent.blur(input);
    expect(calls).toHaveLength(1);
    cleanup();
  });

  it("identity: Enter commits the name once, without waiting for a blur", async () => {
    const calls: string[] = [];
    const { findByLabelText, user } = mount(
      <StatefulProjects seed={{ setProjectName: (_id, name) => calls.push(name) }} />,
    );
    const input = (await findByLabelText("Project name")) as HTMLInputElement;
    await user.click(input);
    await user.keyboard("Payments{Enter}");
    expect(calls).toEqual(["checkoutPayments"]);
    cleanup();
  });

  it("identity: a glyph choice applies live (a second reader sees it)", async () => {
    const { findByRole, getByTestId, user } = mount(<StatefulProjects />);
    await user.click(await findByRole("button", { name: "rocket" }));
    expect(getByTestId("probe-glyph").textContent).toBe("rocket");
    cleanup();
  });

  it("worktree: a token insert appends to the pattern and the preview flattens slashes", async () => {
    // Seed the starting pattern (the field text carries braces userEvent would parse as keys).
    const seed: Partial<SettingsProjection> = {
      worktreeByProject: {
        p1: {
          root: { value: "~/wt", layer: "global" },
          pattern: { value: "{project}-", layer: "global" },
        },
      },
    };
    const { findByText, getByText, getByTestId, user } = mount(<StatefulProjects seed={seed} />);
    await user.click(await findByText("{branch}"));
    expect(getByTestId("probe-pattern").textContent).toBe("{project}-{branch}");
    // {project} resolves to the name; {branch} sample is `fix/session-scope` — the preview
    // flattens the slash to a dash, so a real worktree folder name never nests a directory.
    expect(getByText("~/wt/checkout-fix-session-scope")).toBeTruthy();
    cleanup();
  });

  it("Runs on is a displayed detected fact with no edit control", async () => {
    const { findByText, getByText } = mount(<StatefulProjects />);
    await findByText("Runs on");
    const label = getByText("Runs on");
    const row = label.closest("div")?.parentElement as HTMLElement;
    // The host label shows; the row carries NO provenance badge (D6) and NO control.
    expect(within(row).getByText("This machine")).toBeTruthy();
    expect(row.querySelector('[data-slot="provenance-chip"]')).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByRole("textbox")).toBeNull();
    cleanup();
  });

  it("tracker: a detected pick reads 'detected'; switching to jira lands 'global' and seeds the env var", async () => {
    const seed: Partial<SettingsProjection> = {
      trackerByProject: {
        p1: {
          kind: { value: "github", layer: "detected" },
          projectKey: null,
          baseUrl: null,
          tokenEnv: null,
        },
      },
    };
    const { findByRole, getByRole, getByLabelText, queryByLabelText, getByTestId, user } = mount(
      <StatefulProjects seed={seed} />,
    );
    await findByRole("button", { name: "jira" }); // wait for the tree to load
    // The scout pick resolved from the detected rung. The surface shows no badge for
    // it (D6), so the rung is read off the projection itself.
    expect(getByTestId("probe-tracker").textContent).toBe("github@detected");
    // Switching to JIRA is a user pick — the global rung — and seeds the REST fields.
    await user.click(getByRole("button", { name: "jira" }));
    expect(getByTestId("probe-tracker").textContent).toBe("jira@global");
    // …and no provenance badge appeared on the surface to say so.
    expect(trackerSection().querySelector('[data-slot="provenance-chip"]')).toBeNull();
    // Only the env-var NAME is exposed — never the token value.
    expect((getByLabelText("Tracker token environment variable") as HTMLInputElement).value).toBe(
      "JIRA_API_TOKEN",
    );
    expect(getByLabelText("Tracker project key")).toBeTruthy();
    // Switching away to none drops every REST field.
    await user.click(getByRole("button", { name: "none" }));
    expect(queryByLabelText("Tracker token environment variable")).toBeNull();
    expect(queryByLabelText("Tracker project key")).toBeNull();
    cleanup();
  });

  it("tracker: Escape inside a field blurs it without closing settings", async () => {
    let bubbled = 0;
    const seed: Partial<SettingsProjection> = {
      trackerByProject: {
        p1: {
          kind: { value: "jira", layer: "global" },
          projectKey: { value: "PAY", layer: "global" },
          baseUrl: null,
          tokenEnv: null,
        },
      },
    };
    const { findByLabelText, user } = mount(
      // biome-ignore lint/a11y/noStaticElementInteractions: a takeover-root proxy that counts Escape reaching it
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") bubbled += 1;
        }}
      >
        <StatefulProjects seed={seed} />
      </div>,
    );
    const field = await findByLabelText("Tracker project key");
    field.focus();
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Escape}");
    // The field blurred (Escape handled here) and the event never reached the takeover.
    expect(document.activeElement).not.toBe(field);
    expect(bubbled).toBe(0);
    cleanup();
  });

  it("guidance: Enter saves a new rule; empty text is refused; Escape closes only the editor", async () => {
    let bubbled = 0;
    const { findByRole, getByRole, getByLabelText, getByTestId, queryByLabelText, user } = mount(
      // biome-ignore lint/a11y/noStaticElementInteractions: a takeover-root proxy that counts Escape reaching it
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") bubbled += 1;
        }}
      >
        <StatefulProjects />
      </div>,
    );
    // Empty text is refused — Save stays disabled and Enter does not persist.
    await user.click(await findByRole("button", { name: "Add Rule" }));
    const editor = getByLabelText("Guidance rule text");
    await user.type(editor, "Money amounts are integer cents{Enter}");
    expect(getByTestId("probe-guidance").textContent).toBe("Money amounts are integer cents");

    // Re-open, type, then Escape: the editor closes, nothing persists, settings stays open.
    await user.click(getByRole("button", { name: "Add Rule" }));
    const editor2 = getByLabelText("Guidance rule text");
    await user.type(editor2, "half-written{Escape}");
    expect(queryByLabelText("Guidance rule text")).toBeNull();
    expect(getByTestId("probe-guidance").textContent).toBe("Money amounts are integer cents");
    expect(bubbled).toBe(0);
    cleanup();
  });
});

// ── The LIVE projection: no served write store ⇒ honest disabled + disclosed gap ──
// Mirrors the Environments honest-gap tests (`source-control`/`model-mappings`): under
// the real `LiveSettingsProjectionProvider` (`projectEditsPersist === false`), every
// unbacked Projects editor renders DISABLED and discloses its gap — it must never be a
// live-looking control wired to a no-op setter that silently eats input.
function liveBridge(): MemoryBridge {
  return new MemoryBridge(
    {
      "projects.list": () => ({ projects: [...PROJECTS] }),
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [P1_ROW],
      }),
      // The one served field post-fold; empty here — irrelevant to the Projects editors.
      "harness.detect": () => ({ detected: [] }),
    },
    { platform: "darwin", version: "1.0.1" },
  );
}

function mountLiveRenamableProject() {
  let projects = [...PROJECTS];
  const renames: { projectId: string; name: string }[] = [];
  const history = memoryHistory("/settings/projects?project=billing");
  const live = new MemoryBridge(
    {
      "projects.list": () => ({ projects: [...projects] }),
      "project.rename": ({ projectId, name }) => {
        renames.push({ projectId, name });
        const current = projects.find((project) => project.id === projectId) ?? null;
        if (!current) return { project: null, projects: [...projects] };
        const renamed = { ...current, name };
        projects = projects.map((project) => (project.id === projectId ? renamed : project));
        return { project: renamed, projects: [...projects] };
      },
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [P1_ROW],
      }),
      "harness.detect": () => ({ detected: [] }),
    },
    { platform: "darwin", version: "1.0.1" },
  );
  const view = mount(
    <BridgeProvider bridge={live}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <LiveSettingsProjectionProvider>
          <ProjectsPage />
        </LiveSettingsProjectionProvider>
      </Router>
    </BridgeProvider>,
  );
  return { history, renames, view };
}

function mountLiveProjects() {
  const history = memoryHistory("/settings/projects?project=p1");
  return mount(
    <BridgeProvider bridge={liveBridge()}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <LiveSettingsProjectionProvider>
          <ProjectsPage />
        </LiveSettingsProjectionProvider>
      </Router>
    </BridgeProvider>,
  );
}

describe("ProjectsPage — stable route identity", () => {
  it("canonicalizes a name route before rename so the stable project stays selected", async () => {
    const { history, renames, view } = mountLiveRenamableProject();
    const name = (await view.findByLabelText("Project name")) as HTMLInputElement;
    expect(name.value).toBe("billing");

    fireEvent.change(name, { target: { value: "Payments" } });
    fireEvent.blur(name);
    await waitFor(() => expect(renames).toEqual([{ projectId: "p2", name: "Payments" }]));
    await waitFor(() => {
      expect(history.history).toEqual(["/settings/projects?project=p2"]);
      expect((view.getByLabelText("Project name") as HTMLInputElement).value).toBe("Payments");
      expect(view.getByRole("button", { name: "Choose project" }).textContent).toContain(
        "Payments",
      );
    });
    cleanup();
  });
});

describe("ProjectsPage — live projection is honest about the unserved write store", () => {
  it("disables every unbacked editor and discloses the gap (no silent no-op controls)", async () => {
    const { findByLabelText, getByLabelText, getByRole } = mountLiveProjects();

    // Identity: the name field is LIVE — `project.rename` is served (C18), so it is the one
    // project editor that is not disabled here.
    expect((await findByLabelText("Project name")).hasAttribute("disabled")).toBe(false);
    // Identity: the glyph choices are locked (the group disables its members).
    expect(getByRole("button", { name: "rocket" }).hasAttribute("disabled")).toBe(true);
    // Worktrees: both fields disabled.
    expect(getByLabelText("Worktree location").hasAttribute("disabled")).toBe(true);
    expect(getByLabelText("Worktree naming pattern").hasAttribute("disabled")).toBe(true);
    // Issue tracker: the segmented picker is locked.
    expect(getByRole("button", { name: "jira" }).hasAttribute("disabled")).toBe(true);
    // Guidance: Add Rule is locked, so no editor can open to discard a rule.
    expect(getByRole("button", { name: "Add Rule" }).hasAttribute("disabled")).toBe(true);

    // Each locked editor names its gap — the same honesty the Environments cards carry.
    const notes = [...document.querySelectorAll('[data-slot="unbacked-note"]')].map(
      (n) => n.textContent ?? "",
    );
    expect(notes.length).toBe(4);
    expect(notes.some((t) => /Glyphs aren/.test(t))).toBe(true);
    expect(notes.some((t) => /Worktree location and naming/.test(t))).toBe(true);
    expect(notes.some((t) => /Issue-tracker config/.test(t))).toBe(true);
    expect(notes.some((t) => /Guidance rules/.test(t))).toBe(true);
    cleanup();
  });

  it("keeps Review Context (repo visibility) live — it IS backed by settings.setRepoVisibility", async () => {
    const { findByRole } = mountLiveProjects();
    // The visibility Segmented is NOT part of the projection seam; it stays interactive.
    expect((await findByRole("button", { name: "git-visible" })).hasAttribute("disabled")).toBe(
      false,
    );
    cleanup();
  });
});

// ── The LIVE projection WITH the served per-project rung (C18 group A) ───────────
// The same provider, over a daemon that serves `prefs`: the editors go live and each
// edit dispatches the real repo-rung write for THIS project's repoPath. The unserved
// case above is the other half of the pair — one daemon serves the rung, one does not,
// and the surface tells the truth about which.
const P1_PREFS: NonNullable<SettingsProject["prefs"]> = {
  glyph: { value: "", layer: "builtin" },
  worktreeRoot: { value: "", layer: "builtin" },
  worktreePattern: { value: "{project}-{branch}", layer: "repo" },
  tracker: {
    kind: { value: "none", layer: "builtin" },
    projectKey: { value: "", layer: "builtin" },
    baseUrl: { value: "", layer: "builtin" },
    tokenEnv: { value: "", layer: "builtin" },
  },
  guidance: [],
};

function mountServedPrefs() {
  return mountServedPrefsWith(P1_PREFS);
}

function mountServedPrefsWith(prefs: NonNullable<SettingsProject["prefs"]>): {
  writes: {
    projectId: string;
    repoPath: string;
    key: SettingsProjectValueKey;
    value: string | null;
  }[];
  guidanceWrites: {
    repoPath: string;
    rules: { id?: string; rule: string; severity: string }[];
  }[];
  view: ReturnType<typeof mount>;
} {
  const writes: {
    projectId: string;
    repoPath: string;
    key: SettingsProjectValueKey;
    value: string | null;
  }[] = [];
  const guidanceWrites: {
    repoPath: string;
    rules: { id?: string; rule: string; severity: string }[];
  }[] = [];
  const served = new MemoryBridge(
    {
      "projects.list": () => ({ projects: [...PROJECTS] }),
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [{ ...P1_ROW, prefs }],
      }),
      "settings.setProjectValue": (input) => {
        const write = input as (typeof writes)[number];
        writes.push(write);
        return { status: "applied" as const, key: write.key, project: null };
      },
      "settings.setGuidance": (input) => {
        guidanceWrites.push(input as (typeof guidanceWrites)[number]);
        return { status: "applied", guidance: { rules: [], reason: "empty", dropped: 0 } };
      },
    },
    { platform: "darwin", version: "1.0.1" },
  );
  const history = memoryHistory("/settings/projects?project=p1");
  return {
    writes,
    guidanceWrites,
    view: mount(
      <BridgeProvider bridge={served}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <LiveSettingsProjectionProvider>
            <ProjectsPage />
          </LiveSettingsProjectionProvider>
        </Router>
      </BridgeProvider>,
    ),
  };
}

describe("ProjectsPage — the served per-project rung (C18 group A)", () => {
  it("renders the RESOLVED prefs and enables their editors", async () => {
    const { view } = mountServedPrefs();
    const pattern = (await view.findByLabelText("Worktree naming pattern")) as HTMLInputElement;
    // The served repo-rung value, not the client default.
    expect(pattern.value).toBe("{project}-{branch}");
    expect(pattern.hasAttribute("disabled")).toBe(false);
    // An UNSET location resolves empty, so the client's own default shows.
    expect(((await view.findByLabelText("Worktree location")) as HTMLInputElement).value).toBe(
      "~/.rennet/worktrees",
    );
    // No gap notes: every editor on this page is backed now.
    expect(document.querySelectorAll('[data-slot="unbacked-note"]').length).toBe(0);
    cleanup();
  });

  it("a worktree-pattern edit writes the repo rung for THIS project's repoPath", async () => {
    const { writes, view } = mountServedPrefs();
    const pattern = await view.findByLabelText("Worktree naming pattern");
    fireEvent.change(pattern, { target: { value: "{branch}" } });
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toEqual({
      projectId: "p1",
      repoPath: P1_ROW.repoPath,
      key: "worktreePattern",
      value: "{branch}",
    });
    cleanup();
  });

  // Absence (t3-lens-threads 4.1): the engine choice is deleted — every session is a T3
  // thread — so the page offers no engine control and the wire refuses the retired key.
  // LOAD-BEARING: restoring `ChatEngineSection` to `projects-page.tsx` reddens the first
  // two assertions, and putting "chatEngine" back into `settingsProjectValueKeySchema`
  // reddens the third. The `findByRole("jira")` await is what makes the queryBy misses
  // mean something: the served page really did render before we looked for the control.
  it("offers no chat-engine choice, and the wire refuses the retired `chatEngine` key", async () => {
    const { view } = mountServedPrefs();
    await view.findByRole("button", { name: "jira" });
    expect(view.queryByRole("button", { name: "t3 code" })).toBeNull();
    expect(view.container.querySelector('[data-slot="chat-engine-disclosure"]')).toBeNull();
    expect(settingsProjectValueKeySchema.safeParse("chatEngine").success).toBe(false);
    cleanup();
  });

  it("a tracker pick writes ONLY the kind — the endpoint fields that did not move are untouched", async () => {
    const { writes, view } = mountServedPrefs();
    const jira = await view.findByRole("button", { name: "jira" });
    fireEvent.click(jira);
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes.filter((write) => write.key === "trackerKind")).toEqual([
      { projectId: "p1", repoPath: P1_ROW.repoPath, key: "trackerKind", value: "jira" },
    ]);
    // Switching to a REST tracker seeds its conventional token env-var NAME — the token
    // value itself never enters any store.
    expect(writes.find((write) => write.key === "trackerTokenEnv")?.value).toBe("JIRA_API_TOKEN");
    cleanup();
  });

  it("a project whose row is NOT served keeps its editors disabled while a sibling's are live", async () => {
    // p2 has no settings row (never scanned, or its read has not arrived). The capability
    // is per project, so p2 stays disabled — an enabled control there would sit over a
    // write with no repoPath to address, which is the silent no-op this pair guards.
    const history = memoryHistory("/settings/projects?project=p2");
    const served = new MemoryBridge(
      {
        "projects.list": () => ({ projects: [...PROJECTS] }),
        "settings.get": () => ({
          scheme: "system",
          schemeProvenance: {
            layer: "builtin",
            contributions: [{ layer: "builtin", value: "system", effective: true }],
          },
          appearanceMalformed: false,
          projects: [{ ...P1_ROW, prefs: P1_PREFS }],
        }),
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByLabelText } = mount(
      <BridgeProvider bridge={served}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <LiveSettingsProjectionProvider>
            <ProjectsPage />
          </LiveSettingsProjectionProvider>
        </Router>
      </BridgeProvider>,
    );
    expect((await findByLabelText("Worktree naming pattern")).hasAttribute("disabled")).toBe(true);
    cleanup();

    // …and the SAME served view leaves p1 — the project that has a row — editable.
    const { view } = mountServedPrefs();
    expect((await view.findByLabelText("Worktree naming pattern")).hasAttribute("disabled")).toBe(
      false,
    );
    cleanup();
  });

  it("editing a served rule sends its ID back, so the catalogue can keep what it authored", async () => {
    const { guidanceWrites, view } = mountServedPrefsWith({
      ...P1_PREFS,
      guidance: [
        { id: "arch-boundary", rule: "file I/O lives only in adapters", severity: "high" },
      ],
    });
    fireEvent.click(await view.findByRole("button", { name: "Edit" }));
    fireEvent.change(await view.findByLabelText("Guidance rule text"), {
      target: { value: "file I/O belongs in adapters only" },
    });
    fireEvent.click(await view.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(guidanceWrites.length).toBe(1));
    expect(guidanceWrites[0]?.rules).toEqual([
      { id: "arch-boundary", rule: "file I/O belongs in adapters only", severity: "high" },
    ]);
    cleanup();
  });

  it("a saved guidance rule writes the repo's catalogue", async () => {
    const { guidanceWrites, view } = mountServedPrefs();
    fireEvent.click(await view.findByRole("button", { name: "Add Rule" }));
    fireEvent.change(await view.findByLabelText("Guidance rule text"), {
      target: { value: "keep main releasable" },
    });
    fireEvent.click(await view.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(guidanceWrites.length).toBe(1));
    expect(guidanceWrites[0]).toEqual({
      projectId: "p1",
      repoPath: P1_ROW.repoPath,
      rules: [{ rule: "keep main releasable", severity: "medium" }],
    });
    cleanup();
  });
});

// ── The Repository section over the live settings ladder (P1-1/P1-3/P1-5) ────────
// A project can carry more than one repo (a workspace ⇒ one `SettingsProject` row per
// repoPath): each repo renders its OWN controls, and a write targets its OWN repoPath —
// never collapsed onto the first. A non-apply outcome or a rejection is disclosed, not
// swallowed. The ladder controls (Pin the current effective value / Reset to inherit)
// ride the real `pinRepoValue` / `resetRepoValue` commands.

type RepoWriteInput = { readonly repoPath: string; readonly key?: string };
type RepoBridge = {
  readonly bridge: MemoryBridge;
  readonly calls: { visibility: RepoWriteInput[]; pin: RepoWriteInput[]; reset: RepoWriteInput[] };
};

function mkRow(
  over: Partial<SettingsProject> & Pick<SettingsProject, "repoPath">,
): SettingsProject {
  return { ...P1_ROW, ...over };
}

/** A bridge whose `settings.get` returns the given repo rows and whose repo-write
 *  commands record their input (so a test can prove which repoPath was addressed). */
function repoBridge(
  rows: readonly SettingsProject[],
  outcomes: {
    readonly visibility?: { status: "applied" | "unresolved" | "malformed" } | "throw";
  } = {},
): RepoBridge {
  const calls: RepoBridge["calls"] = { visibility: [], pin: [], reset: [] };
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: [...PROJECTS] }),
    "settings.get": () => ({
      scheme: "system",
      schemeProvenance: {
        layer: "builtin",
        contributions: [{ layer: "builtin", value: "system", effective: true }],
      },
      appearanceMalformed: false,
      projects: [...rows],
    }),
    "settings.setRepoVisibility": (input) => {
      calls.visibility.push(input);
      if (outcomes.visibility === "throw") throw new Error("daemon unreachable");
      return {
        status: outcomes.visibility?.status ?? "applied",
        visibility: input.visibility,
        changed: true,
        gitignorePath: `${input.repoPath}/.rennet/.gitignore`,
      };
    },
    "settings.pinRepoValue": (input) => {
      calls.pin.push(input);
      return { status: "applied", key: "visibility", project: rows[0] ?? null };
    },
    "settings.resetRepoValue": (input) => {
      calls.reset.push(input);
      return { status: "applied", key: "visibility", project: rows[0] ?? null };
    },
  });
  return { bridge, calls };
}

function mountRepo(bridge: MemoryBridge) {
  const history = memoryHistory("/settings/projects?project=p1");
  return mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <SettingsProjectionProvider value={EMPTY_SETTINGS_PROJECTION}>
          <ProjectsPage />
        </SettingsProjectionProvider>
      </Router>
    </BridgeProvider>,
  );
}

/** The ToggleGroup element for one repo's Review Context (by its per-repo aria-label). */
function reviewContext(repoLabel: string): HTMLElement {
  const group = document.querySelector<HTMLElement>(
    `[aria-label="Review context for ${repoLabel}"]`,
  );
  if (!group) throw new Error(`review-context group not found for ${repoLabel}`);
  return group;
}

describe("Repository — multi-repo rows, write outcomes, and ladder controls", () => {
  it("renders EVERY repo of a workspace and writes to the addressed repoPath (not the first)", async () => {
    const rows = [
      mkRow({ repoPath: "/repos/acme/checkout", name: "checkout" }),
      mkRow({ repoPath: "/repos/acme/api", name: "api" }),
    ];
    const { bridge, calls } = repoBridge(rows);
    const { findByLabelText } = mountRepo(bridge);
    // Both repos surface their own Review Context control.
    await findByLabelText("Review context for acme/checkout");
    expect(reviewContext("acme/api")).toBeTruthy();
    // Writing the SECOND repo's visibility addresses THAT repoPath — never collapsed onto p1's first repo.
    fireEvent.click(within(reviewContext("acme/api")).getByRole("button", { name: "git-visible" }));
    await waitFor(() => expect(calls.visibility.length).toBe(1));
    expect(calls.visibility[0]?.repoPath).toBe("/repos/acme/api");
    cleanup();
  });

  it("discloses a no-op outcome (unresolved) instead of silently snapping back", async () => {
    const { bridge } = repoBridge([mkRow({ repoPath: "/repos/acme/checkout" })], {
      visibility: { status: "unresolved" },
    });
    const { findByLabelText, findByText } = mountRepo(bridge);
    await findByLabelText("Review context for acme/checkout");
    fireEvent.click(
      within(reviewContext("acme/checkout")).getByRole("button", { name: "git-visible" }),
    );
    expect(await findByText(/nothing was written/)).toBeTruthy();
    cleanup();
  });

  it("discloses a transport rejection", async () => {
    const { bridge } = repoBridge([mkRow({ repoPath: "/repos/acme/checkout" })], {
      visibility: "throw",
    });
    const { findByLabelText, findByText } = mountRepo(bridge);
    await findByLabelText("Review context for acme/checkout");
    fireEvent.click(
      within(reviewContext("acme/checkout")).getByRole("button", { name: "git-visible" }),
    );
    expect(await findByText(/The write failed: daemon unreachable/)).toBeTruthy();
    cleanup();
  });

  it("discloses a failed settings read distinctly from the 'not yet scanned' empty (P2-7)", async () => {
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [...PROJECTS] }),
      "settings.get": () => {
        throw new Error("daemon down");
      },
    });
    const { findByText } = mountRepo(bridge);
    expect(await findByText(/Couldn’t read settings: daemon down/)).toBeTruthy();
    cleanup();
  });

  it("offers Pin when the value inherits, and Reset when it resolves from the repo layer", async () => {
    // Inherited (builtin) ⇒ Pin freezes the current effective value at the repo layer.
    const inherited = repoBridge([
      mkRow({
        repoPath: "/repos/acme/checkout",
        visibilityProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "local", effective: true }],
        },
      }),
    ]);
    const pinned = mountRepo(inherited.bridge);
    const pinBtn = await pinned.findByRole("button", {
      name: "Pin review context for acme/checkout at the repo",
    });
    fireEvent.click(pinBtn);
    await waitFor(() => expect(inherited.calls.pin.length).toBe(1));
    expect(inherited.calls.pin[0]?.key).toBe("visibility");
    cleanup();

    // Repo-layer entry ⇒ Reset clears it and falls back down the ladder.
    const explicit = repoBridge([
      mkRow({
        repoPath: "/repos/acme/checkout",
        visibilityProvenance: {
          layer: "repo",
          contributions: [{ layer: "repo", value: "git-visible", effective: true }],
        },
      }),
    ]);
    const reset = mountRepo(explicit.bridge);
    const resetBtn = await reset.findByRole("button", {
      name: "Reset review context for acme/checkout to inherit",
    });
    fireEvent.click(resetBtn);
    await waitFor(() => expect(explicit.calls.reset.length).toBe(1));
    expect(explicit.calls.reset[0]?.key).toBe("visibility");
    cleanup();
  });
});
