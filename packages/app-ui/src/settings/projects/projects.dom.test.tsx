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
  type ProjectLogo,
  type SettingsProject,
  type SettingsProjectValueKey,
  settingsProjectValueKeySchema,
  type WorktreeRemoveOutcome,
  type WorktreeRow,
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
    // The Worktrees card asks per repo row; this fixture is about the other sections, so
    // the repository honestly has no workspaces yet.
    "worktrees.list": () => ({ rows: [], truncated: false }),
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
    trackerByProject: trackers,
    guidanceByProject: guidance,
    // A seeded setter WINS, so a test can count the writes the field actually makes.
    setProjectName:
      seed?.setProjectName ?? ((id, name) => setNames((prev) => ({ ...prev, [id]: name }))),
    setProjectGlyph: (id, icon) => setGlyphs((prev) => ({ ...prev, [id]: icon })),
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

  // workspace-settings D7 — the card is CONTROLS again, because the binding reads the
  // settings now. Two claims here, both about the STATEFUL page (which serves no repo
  // row): the four prose rows are gone, and the card reads a repo row rather than a
  // project. The served-rung block further down proves what the controls write.
  //
  // POSITIVE CONTROL RUN, 2026-09-08: `worktrees.tsx` restored to its four-prose-row
  // version (the whole file, from HEAD) → this test reddened, and so did the other six
  // worktree cases. Restored, green.
  it("worktrees: the four prose rows are gone and the card offers the D7 controls", async () => {
    const { findByText, getByText, queryByText, queryByLabelText } = mount(<StatefulProjects />);
    await findByText("Worktrees");
    // The four cases the card used to STATE are gone — the binding reads settings now.
    expect(queryByText("A branch you already have out")).toBeNull();
    expect(queryByText("A branch nothing has out")).toBeNull();
    expect(queryByText("A pull request")).toBeNull();
    expect(queryByText("the session's workspace")).toBeNull();
    // D7's four rows are here instead.
    const card = getByText("Worktrees").closest('[data-slot="settings-section"]');
    expect(card).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Location")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Branch layout")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Pull-request layout")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Workspace")).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Workspaces")).toBeTruthy();
    // The caption names BOTH files the section writes (the global rung and the repo rung).
    const caption = card?.querySelector('[data-slot="backing-file"]')?.textContent ?? "";
    expect(caption).toContain("daemon-settings.json");
    expect(caption).toContain("config.json");
    // This page serves no settings row for p1's PROJECT (`settings.get` carries P1_ROW with
    // no prefs), so the editors exist but nothing is resolved into them.
    expect(queryByLabelText("Location for acme/checkout")).toBeTruthy();
    cleanup();
  });

  // D6's empty state is ONE sentence, and it is the row's own fact — never a sentence
  // about Rennet's machinery or an explanation of an empty cell.
  it("worktrees: an empty inventory says one sentence", async () => {
    const { findByText, getByText } = mount(<StatefulProjects />);
    await findByText("Workspaces");
    expect(
      getByText("Nothing yet. Rennet\u2019s worktrees for this repository appear here."),
    ).toBeTruthy();
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
      "worktrees.list": () => ({ rows: [], truncated: false }),
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
      "worktrees.list": () => ({ rows: [], truncated: false }),
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
    // Worktrees: every editor is locked too — the row this daemon serves carries no
    // `prefs`, so there is nothing resolved to put in them and nowhere to write.
    expect(getByLabelText("Location for acme/checkout").hasAttribute("disabled")).toBe(true);
    expect(getByRole("button", { name: "own" }).hasAttribute("disabled")).toBe(true);
    // Issue tracker: the segmented picker is locked.
    expect(getByRole("button", { name: "jira" }).hasAttribute("disabled")).toBe(true);
    // Guidance: Add Rule is locked, so no editor can open to discard a rule.
    expect(getByRole("button", { name: "Add Rule" }).hasAttribute("disabled")).toBe(true);

    // Each locked editor names its gap — the same honesty the Environments cards carry.
    const notes = [...document.querySelectorAll('[data-slot="unbacked-note"]')].map(
      (n) => n.textContent ?? "",
    );
    expect(notes.length).toBe(4);
    expect(notes.some((t) => /Marks aren/.test(t))).toBe(true);
    expect(notes.some((t) => /Worktree settings/.test(t))).toBe(true);
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
  // A SERVED value on the repo rung, so "renders the resolved prefs" has something that
  // is not the client default to prove. (It used to be `worktreePattern`; that editor is
  // gone — nothing placed a worktree from it — so the glyph carries the proof now, #812.)
  glyph: { value: "rocket", layer: "repo" },
  // The mark says WHETHER a glyph shows at all (#900); `glyph` here means it does, so the
  // grid's lit cell is still the resolved answer rather than a guess about one.
  mark: { value: "glyph", layer: "builtin" },
  worktreeRoot: { value: "/home/dev/trees", layer: "global" },
  worktreePattern: { value: "{name}/{branch}", layer: "repo" },
  prWorktreePattern: { value: "{owner}/{name}/pr-{number}", layer: "builtin" },
  workspace: { value: "share", layer: "builtin" },
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

/** The logo files the served host holds for p1 (#900), and what the two logo WRITES did —
 *  plus, for the Worktrees card, what the daemon RESOLVED for this repository and what it
 *  holds under it (workspace-settings D3/D6). */
interface ServedLogos {
  readonly logos?: readonly ProjectLogo[];
  /** What `project.detectLogo` answers — a host that found something, or one that did not. */
  readonly detection?: { readonly found: boolean; readonly source: string | null };
  /** The two example paths the DAEMON resolved for p1's repo row (D3). */
  readonly preview?: SettingsProject["worktreePreview"];
  /** A SECOND repository under the same project — the workspace fixture the 2026-08-28
   *  rule demands of anything that turns a project into a repository. */
  readonly second?: SettingsProject;
  /** What `worktrees.list` answers for p1's repo (D6). */
  readonly workspaces?: readonly WorktreeRow[];
  /** What `worktrees.remove` answers — git's refusal, or the removal it made. */
  readonly removal?: WorktreeRemoveOutcome;
}

/** The daemon's resolved example paths for p1, unless a case supplies its own. */
const P1_PREVIEW = {
  branch: "/home/dev/trees/widget/feat/x",
  pullRequest: "/home/dev/trees/acme/widget/pr-1",
} as const;

/** p1's SECOND repository. Same project, its own `repoPath`, its own resolved preview —
 *  a card keyed by the project id can render only one of the two. */
const SECOND_REPO: SettingsProject = {
  ...P1_ROW,
  name: "ledger",
  repoPath: "/repos/acme/ledger",
  worktreePreview: {
    branch: "/home/dev/trees/ledger/feat/x",
    pullRequest: "/home/dev/trees/acme/ledger/pr-1",
  },
};

/** The reviewer's own checkout, listed because a session is bound to it. Never removable. */
const OWN_CHECKOUT: WorktreeRow = {
  id: "w-own",
  path: "/repos/acme/checkout",
  kind: "own-checkout",
  ref: "feat/x",
  sessionIds: ["s-7"],
  removable: false,
};

/** A Rennet branch worktree a LIVE session is bound to — shown, with no remove. */
const BOUND_BRANCH: WorktreeRow = {
  id: "w-bound",
  path: "/home/dev/trees/widget/feat/y",
  kind: "branch",
  ref: "feat/y",
  sessionIds: ["s-42"],
  sizeBytes: 2048,
  removable: false,
};

/** An idle Rennet branch worktree whose size did not measure inside its bound. */
const IDLE_BRANCH: WorktreeRow = {
  id: "w-idle",
  path: "/home/dev/trees/widget/feat/z",
  kind: "branch",
  ref: "feat/z",
  sessionIds: [],
  removable: true,
};

/** A sibling holding work the branch does not, in a worktree git will refuse to remove. */
const DIRTY_SIBLING: WorktreeRow = {
  id: "w-sib",
  path: "/home/dev/trees/widget/rennet/feat/x",
  kind: "sibling",
  ref: "rennet/feat/x",
  sessionIds: [],
  aheadOf: { branch: "feat/x", commits: 2 },
  keepsBranch: "Removing this keeps rennet/feat/x: it is ahead of feat/x by 2 commits.",
  removable: true,
};

function mountServedPrefsWith(
  prefs: NonNullable<SettingsProject["prefs"]>,
  held: ServedLogos = {},
): {
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
  uploads: {
    projectId: string;
    mimeType: string;
    bytesBase64: string;
    fileName: string;
  }[];
  detections: string[];
  removals: { repoPath: string; id: string }[];
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
  const uploads: {
    projectId: string;
    mimeType: string;
    bytesBase64: string;
    fileName: string;
  }[] = [];
  const detections: string[] = [];
  const removals: { repoPath: string; id: string }[] = [];
  const rowsFor = (repoPath: string): readonly WorktreeRow[] =>
    repoPath === P1_ROW.repoPath ? (held.workspaces ?? []) : [];
  const served = new MemoryBridge(
    {
      "projects.list": () => ({ projects: [...PROJECTS] }),
      "project.logos": () => ({ logos: (held.logos ?? []).map((logo) => ({ ...logo })) }),
      "project.uploadLogo": (input) => {
        uploads.push({ ...input });
        return { status: "applied" as const, key: "mark" as const, project: null };
      },
      "project.detectLogo": (input) => {
        detections.push(input.projectId);
        return held.detection ?? { found: false, source: null };
      },
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [
          { ...P1_ROW, prefs, worktreePreview: held.preview ?? P1_PREVIEW },
          ...(held.second ? [{ ...held.second, prefs }] : []),
        ],
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
      "worktrees.list": ({ repoPath }) => ({ rows: [...rowsFor(repoPath)], truncated: false }),
      "worktrees.remove": (input) => {
        removals.push({ ...input });
        return (
          held.removal ?? {
            status: "removed" as const,
            id: input.id,
            path: rowsFor(input.repoPath).find((row) => row.id === input.id)?.path ?? input.id,
          }
        );
      },
    },
    { platform: "darwin", version: "1.0.1" },
  );
  const history = memoryHistory("/settings/projects?project=p1");
  return {
    writes,
    guidanceWrites,
    uploads,
    detections,
    removals,
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
    const rocket = await view.findByRole("button", { name: "rocket" });
    // The served repo-rung glyph is the one lit — not `layers`, the client default.
    expect(rocket.getAttribute("aria-pressed")).toBe("true");
    expect(rocket.hasAttribute("disabled")).toBe(false);
    expect((await view.findByRole("button", { name: "layers" })).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // No gap notes: every editor on this page is backed now.
    expect(document.querySelectorAll('[data-slot="unbacked-note"]').length).toBe(0);
    cleanup();
  });

  // Two keys, not one (#900): `glyph` names WHICH symbol, `mark` says a symbol shows at
  // all. Asserted as an ordered pair rather than as two memberships — a page that wrote
  // only `mark` would satisfy a `some(key === "mark")` check while leaving the grid's
  // chosen cell unstored, and one that wrote only `glyph` would leave a project wearing
  // its repo's logo still wearing it after picking a symbol.
  it("a glyph choice writes BOTH the glyph and the mark for THIS project's repoPath", async () => {
    const { writes, view } = mountServedPrefs();
    fireEvent.click(await view.findByRole("button", { name: "flask" }));
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes).toEqual([
      { projectId: "p1", repoPath: P1_ROW.repoPath, key: "glyph", value: "flask" },
      { projectId: "p1", repoPath: P1_ROW.repoPath, key: "mark", value: "glyph" },
    ]);
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
        "worktrees.list": () => ({ rows: [], truncated: false }),
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByRole } = mount(
      <BridgeProvider bridge={served}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <LiveSettingsProjectionProvider>
            <ProjectsPage />
          </LiveSettingsProjectionProvider>
        </Router>
      </BridgeProvider>,
    );
    expect((await findByRole("button", { name: "rocket" })).hasAttribute("disabled")).toBe(true);
    cleanup();

    // …and the SAME served view leaves p1 — the project that has a row — editable.
    const { view } = mountServedPrefs();
    expect((await view.findByRole("button", { name: "rocket" })).hasAttribute("disabled")).toBe(
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

  // ── The Worktrees card over the served rung (workspace-settings D7) ──────────
  // The four tests of task 4.2, plus the two-repo discrimination the 2026-08-28 rule
  // demands of anything that turns a project into a repository.

  // D3's whole point: the preview is a string the DAEMON resolved through the same
  // functions the binding calls. The client has neither the data directory nor the escaped
  // repo key, and #812 is what happened when it tried to derive one anyway.
  //
  // THE PAIR IS THE TEST, AND ONLY THE PAIR. This one alone cannot tell the row's string
  // from a constant that happens to equal it, which is measured, not assumed: POSITIVE
  // CONTROL RUN 2026-09-08 — the two `field(...)` calls in `worktrees.tsx` were given
  // literal preview strings instead of `row.worktreePreview`, and THIS test stayed green
  // while the next one (and the two-repo case) reddened. So the claim "renders the row's
  // string" is carried by the case below, and what this one adds is the other direction:
  // the field holds `{name}/{branch}` while the preview holds a resolved path, which no
  // client-side render of that pattern could have produced.
  it("worktrees: the preview renders the ROW's string, not one computed here", async () => {
    const { view } = mountServedPrefsWith(P1_PREFS, {
      preview: {
        branch: "/home/dev/trees/widget/feat/x",
        pullRequest: "/home/dev/trees/acme/widget/pr-1",
      },
    });
    const branch = await view.findByText("/home/dev/trees/widget/feat/x");
    expect(branch.getAttribute("data-slot")).toBe("worktree-preview");
    expect(view.getByText("/home/dev/trees/acme/widget/pr-1")).toBeTruthy();
    // The field holds the PATTERN; the preview holds the resolved path. A surface that
    // rendered the pattern would show `{name}/{branch}` in both places.
    expect((view.getByLabelText("Branch layout for acme/checkout") as HTMLInputElement).value).toBe(
      "{name}/{branch}",
    );
    cleanup();
  });

  // The control for the one above, run as a TEST rather than described: the same page, a
  // different row string, and the render follows it. "Reads the row" is a claim about where
  // the bytes came from, and this is the only assertion in the suite that can see it.
  it("worktrees: a different row string renders a different preview", async () => {
    const { view } = mountServedPrefsWith(P1_PREFS, {
      preview: { branch: "/elsewhere/tree", pullRequest: "/elsewhere/pr-1" },
    });
    await view.findByText("/elsewhere/tree");
    expect(view.queryByText("/home/dev/trees/widget/feat/x")).toBeNull();
    cleanup();
  });

  // A WORKSPACE PROJECT MAPS MANY REPOS ONTO ONE IDENTITY, and that mapping is not
  // invertible. Two repos of one project, each with its own resolved answer: the card
  // renders BOTH, their previews differ, and a click on the second one's control writes
  // THAT row's `repoPath`.
  //
  // POSITIVE CONTROL RUN, 2026-09-08: `WorktreeSection` was given back the shape the
  // review found — one entry per PROJECT (`new Map(rows.map(r => [r.projectId, r]))`),
  // which is what `live-projection.tsx` did — and this test reddened on the second repo's
  // preview. A duplicate React `key` alone does NOT reproduce it (React renders both rows
  // and only warns), which is why the control is the collapse and not the key.
  it("worktrees: a two-repo project renders both repos, and a workspace click writes THAT row's repoPath", async () => {
    const { writes, view } = mountServedPrefsWith(P1_PREFS, { second: SECOND_REPO });
    // Both repos' previews are on screen, and they are different paths.
    await view.findByText("/home/dev/trees/widget/feat/x");
    expect(view.getByText("/home/dev/trees/ledger/feat/x")).toBeTruthy();
    // The SECOND repo's workspace control — addressed by its own label, so the click
    // cannot land on the first row by position.
    const own = view.getByLabelText("Workspace for acme/ledger");
    fireEvent.click(within(own).getByRole("button", { name: "own" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes).toEqual([
      { projectId: "p1", repoPath: SECOND_REPO.repoPath, key: "workspace", value: "own" },
    ]);
    cleanup();
  });

  it("worktrees: a remove click dispatches the ROW's id, and a refused removal prints git's text", async () => {
    const { removals, view } = mountServedPrefsWith(P1_PREFS, {
      workspaces: [DIRTY_SIBLING, IDLE_BRANCH],
      removal: {
        status: "refused",
        id: DIRTY_SIBLING.id,
        path: DIRTY_SIBLING.path,
        reason:
          "fatal: '/home/dev/trees/widget/rennet/feat/x' contains modified or untracked files, use --force to delete it",
      },
    });
    const remove = await view.findByLabelText(
      `Remove workspace ${DIRTY_SIBLING.path} in acme/checkout`,
    );
    fireEvent.click(remove);
    // ONE click, no confirmation step in between (Rule Zero), addressing the row by ITS id.
    await waitFor(() => expect(removals.length).toBe(1));
    expect(removals).toEqual([{ repoPath: P1_ROW.repoPath, id: DIRTY_SIBLING.id }]);
    // Git's own sentence, verbatim, on the row it refused.
    const outcome = await view.findByText(/contains modified or untracked files/);
    expect(outcome.textContent).toBe(
      "fatal: '/home/dev/trees/widget/rennet/feat/x' contains modified or untracked files, use --force to delete it",
    );
    cleanup();
  });

  // The rows a removal cannot address carry no button at all — a fact about the row, not
  // a permission prompt. `own-checkout` is one by definition; a row a live session is
  // bound to is the other, and it shows the session instead.
  it("worktrees: an own-checkout row and a bound row carry no remove", async () => {
    const { view } = mountServedPrefsWith(P1_PREFS, {
      workspaces: [OWN_CHECKOUT, BOUND_BRANCH, IDLE_BRANCH],
    });
    await view.findByLabelText(`Remove workspace ${IDLE_BRANCH.path} in acme/checkout`);
    expect(
      view.queryByLabelText(`Remove workspace ${OWN_CHECKOUT.path} in acme/checkout`),
    ).toBeNull();
    expect(
      view.queryByLabelText(`Remove workspace ${BOUND_BRANCH.path} in acme/checkout`),
    ).toBeNull();
    // The bound row says WHOSE it is, and the unmeasured one says its size is unknown.
    expect(view.getByText("s-42")).toBeTruthy();
    const idle = view.getByText(IDLE_BRANCH.path).closest('[data-slot="worktree-row"]');
    expect(idle?.textContent).toContain("—");
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

// ── The project MARK over the live projection (#900) ─────────────────────────────
// A mark is a glyph OR a logo, and WHICH one shows is resolved on the ladder before the
// surface sees it: `settings.get` carries the `mark` pref and `project.logos` carries the
// bytes, and the live projection folds the pair. These prove the fold — that a `detected`
// mark reaches the picker as a real image, that a mark naming bytes the host does not hold
// degrades to the glyph instead of an empty square, and that each Identity control writes
// the key it claims to.

const LOGO_SVG = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4IDgiLz4=";

const REPO_LOGO: ProjectLogo = {
  projectId: "p1",
  logo: "detected",
  mimeType: "image/svg+xml",
  bytesBase64: LOGO_SVG,
  source: "assets/logo.svg",
};

/** The same served rung, but wearing the repo's logo rather than its glyph. */
const MARK_DETECTED: NonNullable<SettingsProject["prefs"]> = {
  ...P1_PREFS,
  mark: { value: "detected", layer: "detected" },
};

/** The picker trigger, which draws the scoped project's mark beside its name. */
async function markTrigger(view: ReturnType<typeof mount>): Promise<HTMLElement> {
  return await view.findByRole("button", { name: "Choose project" });
}

describe("ProjectsPage — the resolved project mark (#900)", () => {
  it("draws the repo's logo where the project is named, and lights no glyph", async () => {
    const { view } = mountServedPrefsWith(MARK_DETECTED, { logos: [REPO_LOGO] });
    const trigger = await markTrigger(view);
    await waitFor(() =>
      expect(trigger.querySelector("img")?.getAttribute("src")).toBe(
        `data:image/svg+xml;base64,${LOGO_SVG}`,
      ),
    );
    // The served glyph is still `rocket`, and it is still what the grid would light — but
    // the project is not wearing it, so nothing in the grid may read as selected. (The
    // paired assertion in "renders the RESOLVED prefs" has `rocket` pressed when the mark
    // IS the glyph, so this is the same page answering a different resolved mark.)
    expect((await view.findByRole("button", { name: "rocket" })).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The repo-logo tile is the one lit instead.
    expect(
      (await view.findByRole("button", { name: "Repo logo" })).getAttribute("aria-pressed"),
    ).toBe("true");
    cleanup();
  });

  // The other half of the pair: the SAME `mark: detected` pref, with the bytes gone (the
  // file was removed under the host, or the logo read has not landed). A surface that
  // trusted the pref alone would render an empty square beside the project's name.
  it("falls back to the glyph when the host holds no bytes for the chosen mark", async () => {
    const { view } = mountServedPrefsWith(MARK_DETECTED, { logos: [] });
    const trigger = await markTrigger(view);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "rocket" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger.querySelector("svg.lucide-rocket")).toBeTruthy();
    cleanup();
  });

  it("offers the repo-logo tile only for a project that actually has one", async () => {
    // A repo with no image found: no tile to choose, and no empty frame pretending there is.
    const bare = mountServedPrefs();
    await bare.view.findByRole("button", { name: "rocket" });
    expect(bare.view.queryByRole("button", { name: "Repo logo" })).toBeNull();
    // …and "Detect again" is offered anyway, so a repo that GAINS a logo can be re-scouted.
    expect(bare.view.getByRole("button", { name: "Detect again" })).toBeTruthy();
    cleanup();

    const held = mountServedPrefsWith(P1_PREFS, { logos: [REPO_LOGO] });
    const tile = await held.view.findByRole("button", { name: "Repo logo" });
    // Its provenance is the path the scout chose, shown as the line under the tiles.
    expect(await held.view.findByText(/assets\/logo\.svg/)).toBeTruthy();
    // Not selected: the served mark is still the glyph, so the tile offers a choice
    // rather than reporting one.
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    cleanup();
  });

  it("choosing the repo logo writes the mark alone — the glyph it keeps is untouched", async () => {
    const { writes, view } = mountServedPrefsWith(P1_PREFS, { logos: [REPO_LOGO] });
    fireEvent.click(await view.findByRole("button", { name: "Repo logo" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes).toEqual([
      { projectId: "p1", repoPath: P1_ROW.repoPath, key: "mark", value: "detected" },
    ]);
    cleanup();
  });

  it("an upload sends the picked image's type, bytes and file name", async () => {
    const { uploads, view } = mountServedPrefs();
    const input = (await view.findByLabelText("Upload an image")) as HTMLInputElement;
    const file = new File([Uint8Array.from([1, 2, 3])], "brand.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    // The bytes are what the command carries — base64 of 0x01 0x02 0x03, not a path or a
    // blob URL the daemon could never read.
    await waitFor(() => expect(uploads.length).toBe(1));
    expect(uploads[0]).toEqual({
      projectId: "p1",
      mimeType: "image/png",
      bytesBase64: "AQID",
      fileName: "brand.png",
    });
    cleanup();
  });

  it("names the formats it takes instead of sending a file the wire would refuse", async () => {
    const { uploads, view } = mountServedPrefs();
    const input = (await view.findByLabelText("Upload an image")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await view.findByText("Choose an SVG, PNG, JPEG, or WebP image.")).toBeTruthy();
    expect(uploads).toEqual([]);
    cleanup();
  });

  it("reports what a re-detection found, in the host's own words", async () => {
    const found = mountServedPrefsWith(P1_PREFS, {
      detection: { found: true, source: "assets/logo.svg" },
    });
    fireEvent.click(await found.view.findByRole("button", { name: "Detect again" }));
    expect(await found.view.findByText("Found assets/logo.svg")).toBeTruthy();
    expect(found.detections).toEqual(["p1"]);
    cleanup();

    // POSITIVE CONTROL for the sentence above: the same click over a host that found
    // nothing must NOT read as a find. A single hardcoded line would pass one of these.
    const none = mountServedPrefsWith(P1_PREFS);
    fireEvent.click(await none.view.findByRole("button", { name: "Detect again" }));
    expect(await none.view.findByText("No logo found in the repo")).toBeTruthy();
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
    const { findAllByText } = mountRepo(bridge);
    // BOTH live-reading sections say it: Repository and Worktrees each read
    // `settings.get` for their rows, so a failed read is disclosed where each of them
    // would have shown a value — never masked as the "not yet scanned" empty.
    const said = await findAllByText(/Couldn’t read settings: daemon down/);
    expect(said.length).toBe(2);
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
