// @vitest-environment happy-dom
//
// The sidebar (C03 §2–3) over a MemoryBridge: BOTH halves are real commands now
// (`projects.list` / `projects.remove`, and the C18 `session.*` family). The session
// fixture is a stateful store behind the bridge, so rename / pin / archive are proven
// through the same served-write-then-re-read path the live client takes. Zero props —
// every read and write resolves through `sidebar-data`, folds through the `ui` slice,
// highlight from the route.
import type { Project } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { useUpdateReady } from "../../components/update-ready";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import type { ProjectIconName } from "../../settings/assets/project-icon";
import type { ProjectMarkView } from "../../settings/assets/project-mark";
import {
  EMPTY_SETTINGS_PROJECTION,
  SettingsProjectionProvider,
} from "../../settings/data/projections";
import { useRennetStore } from "../../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../../test/dom";
import { frontDoorHandlers } from "../../test/fixtures/front-door";
import { type SessionSeed, sessionHandlers } from "../../test/fixtures/sessions";
import { MemoryBridge, type MemoryBridgeHandlers } from "../../test/memory-bridge";
import { SIDEBAR_PANEL_WIDTH } from "../constants";
import { useReviewActivityState } from "../review-activity-state";
import { Sidebar } from "./sidebar";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: {
      ...s.ui,
      sidebarOpen: true,
      sidebarFolds: {},
      chatOpen: false,
      commandMenuOpen: false,
      openDialogs: [],
    },
  }));
  useUpdateReady.setState({ ready: null, promptOpen: false });
  useReviewActivityState.setState({ bySession: {} });
});

function project(id: string, name: string, source = "local"): Project {
  return {
    id,
    name,
    path: `/repos/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/repos/${id}`,
    addedAt: "2026-08-27T00:00:00.000Z",
    source: source as Project["source"],
  };
}

function projectStore(seed: readonly Project[], failure?: Error) {
  let projects = [...seed];
  const calls: string[] = [];
  const handlers: MemoryBridgeHandlers = {
    "projects.list": () => ({ projects: [...projects] }),
    "project.rename": ({ projectId, name }) => {
      calls.push(name);
      if (failure) throw failure;
      const current = projects.find((candidate) => candidate.id === projectId) ?? null;
      if (!current) return { project: null, projects: [...projects] };
      const path = current.openPath || current.path;
      const parts = path.split(/[/\\]+/).filter(Boolean);
      const next = { ...current, name: name.trim() || parts.slice(-2).join("/") || path };
      projects = projects.map((candidate) => (candidate.id === projectId ? next : candidate));
      return { project: next, projects: [...projects] };
    },
  };
  return { calls, handlers, list: () => [...projects] };
}

function mountSidebar(opts: {
  projects?: readonly Project[];
  sessions?: readonly SessionSeed[];
  path?: string;
  extraHandlers?: MemoryBridgeHandlers;
  platform?: string;
  /** Persisted project glyphs, as the C10 settings projection serves them (D5). */
  glyphs?: Readonly<Record<string, ProjectIconName>>;
  /** Resolved project marks (#900) — a logo here replaces the row's glyph. */
  marks?: Readonly<Record<string, ProjectMarkView>>;
}) {
  const history = memoryHistory(opts.path ?? "/");
  const bridge = new MemoryBridge(
    {
      ...frontDoorHandlers(opts.projects ?? []),
      ...sessionHandlers(opts.sessions ?? []),
      ...opts.extraHandlers,
    },
    { platform: opts.platform },
  );
  const utils = mount(
    <BridgeProvider bridge={bridge}>
      <SettingsProjectionProvider
        value={{
          ...EMPTY_SETTINGS_PROJECTION,
          glyphByProject: opts.glyphs ?? {},
          markByProject: opts.marks ?? {},
        }}
      >
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Sidebar />
        </Router>
      </SettingsProjectionProvider>
    </BridgeProvider>,
  );
  return { ...utils, history, bridge };
}

/** Open a project row so its session list exists. A project is folded by default, and a
 *  folded `Collapse` mounts NO children (perf audit §5 H2 — a folded list used to sit in
 *  the DOM behind `inert`), so its sessions are simply not in the document until it opens. */
async function openProject(view: ReturnType<typeof mountSidebar>, name: string): Promise<void> {
  const row = (await view.findByText(name)).closest("button");
  if (row?.getAttribute("aria-expanded") === "false") fireEvent.click(row);
}

const SESSIONS: readonly SessionSeed[] = [
  { id: "s1", projectId: "p1", title: "Alpha", target: "your-branch" },
  {
    id: "s2",
    projectId: "p1",
    title: "Beta",
    target: "your-pr",
    targetState: "needs-you",
    unread: true,
  },
];

describe("sidebar structure (C03 §2)", () => {
  it("collapses to NOTHING — zero width, no rail, no nav — writing ui.sidebarOpen", async () => {
    const { getByLabelText, container } = mountSidebar({ projects: [project("p1", "atlas")] });
    const aside = container.querySelector('[data-region="sidebar"]');
    if (!aside) throw new Error("sidebar aside missing");
    expect(aside.className).toContain("w-64");
    fireEvent.click(getByLabelText("Collapse sidebar"));
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
    // C20: collapsed means HIDDEN. No 48px icon rail, no App nav, no hairline —
    // a collapsed sidebar contributes zero width so the next pane sits flush to the
    // window edge and the corner slot's light inset lands where the OS draws them.
    await waitFor(() => expect(aside.getAttribute("data-open")).toBe("false"));
    expect(aside.className).toContain("w-0");
    expect(aside.className).not.toContain("w-12");
    expect(aside.className).not.toContain("border-r");
    expect(aside.querySelector('nav[aria-label="App"]')).toBeNull();
    expect(aside.querySelector('[data-slot="corner-slot"]')).toBeNull();
    expect(aside.textContent).toBe("");
  });

  it("orders the action block Search → New Chat → Add Project → Add Environment", () => {
    const { getByText } = mountSidebar({ projects: [project("p1", "atlas")] });
    const order = ["Search", "New Chat", "Add Project", "Add Environment"].map((t) => getByText(t));
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1];
      const curr = order[i];
      if (!prev || !curr) throw new Error("missing action row");
      // Node.DOCUMENT_POSITION_FOLLOWING (4) — each item follows the previous one.
      expect(prev.compareDocumentPosition(curr) & 4).toBe(4);
    }
  });

  it("orders the expanded footer Settings → Help → Update, read left-to-right", () => {
    useUpdateReady.setState({ ready: { version: "1.2.3" } });
    const { getByText, getByLabelText } = mountSidebar({ projects: [project("p1", "atlas")] });
    const order = [
      getByLabelText("Settings"),
      getByLabelText("Help"),
      getByText("Update").closest("button"),
    ];
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1];
      const curr = order[i];
      if (!prev || !curr) throw new Error("missing footer control");
      // Node.DOCUMENT_POSITION_FOLLOWING (4) — each control follows the previous one.
      expect(prev.compareDocumentPosition(curr) & 4).toBe(4);
    }
  });

  it("Search opens the command menu (sets ui.commandMenuOpen)", () => {
    const { getByText } = mountSidebar({ projects: [project("p1", "atlas")] });
    fireEvent.click(getByText("Search"));
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);
  });

  it("hides Archived at zero and shows it with a count when > 0", async () => {
    const none = mountSidebar({ projects: [project("p1", "atlas")], sessions: SESSIONS });
    await none.findByText("atlas");
    expect(none.queryByText("Archived")).toBeNull();
    cleanup();
    const some = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: [{ id: "s9", projectId: "p1", title: "Old", archived: true }],
    });
    expect(await some.findByText("Archived")).toBeTruthy();
  });
});

describe("sidebar tree (C03 §3)", () => {
  it("renders host + project + session rows from the projection", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    const { getByText } = view;
    expect(await view.findByText("atlas")).toBeTruthy();
    expect(getByText("This machine")).toBeTruthy();
    await openProject(view, "atlas");
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();
  });

  it("renders the project's persisted glyph, falling back to layers (D5)", async () => {
    // Positive control: a project whose settings glyph is `rocket` must NOT render
    // the default `layers` mark — the sidebar reads `glyphByProject`, it does not
    // hardcode a glyph (the bug this replaces).
    const chosen = mountSidebar({
      projects: [project("p1", "atlas")],
      glyphs: { p1: "rocket" },
    });
    const chosenRow = (await chosen.findByText("atlas")).closest("button");
    expect(chosenRow?.querySelector("svg.lucide-rocket")).toBeTruthy();
    expect(chosenRow?.querySelector("svg.lucide-layers")).toBeNull();
    cleanup();

    // No persisted glyph → the default mark, unchanged.
    const bare = mountSidebar({ projects: [project("p1", "atlas")] });
    const bareRow = (await bare.findByText("atlas")).closest("button");
    expect(bareRow?.querySelector("svg.lucide-layers")).toBeTruthy();
  });

  // #900: a project whose resolved mark is a LOGO wears the image in the row, not a
  // symbol. Positive control: the same project also carries a `rocket` glyph, so a row
  // still reading `glyphByProject` would render that svg and no image at all.
  it("renders a project's logo mark in the row, in place of its glyph", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      glyphs: { p1: "rocket" },
      marks: { p1: { kind: "logo", logo: "detected", src: "data:image/png;base64,AQID" } },
    });
    const row = (await view.findByText("atlas")).closest("button");
    expect(row?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AQID");
    expect(row?.querySelector("svg.lucide-rocket")).toBeNull();
  });

  it("groups a remote project under a remote host", async () => {
    const { findByText } = mountSidebar({ projects: [project("p2", "billing", "remote:dev-box")] });
    expect(await findByText("dev-box")).toBeTruthy();
  });

  it("shows a reviewed session's green tick beside the title (R36), not a recolored icon", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: [
        { id: "s1", projectId: "p1", title: "Done", target: "your-pr", targetState: "reviewed" },
      ],
    });
    await openProject(view, "atlas");
    // The separate tick carries the "Reviewed" name; the leading target icon stays "Your PR".
    expect(await view.findByLabelText("Reviewed")).toBeTruthy();
    expect(await view.findByLabelText("Your PR")).toBeTruthy();
  });

  it("unfolds a project through the ui slice (aria-expanded + ui.sidebarFolds)", async () => {
    const { getByText, findByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    await findByText("atlas");
    const row = getByText("atlas").closest("button");
    if (!row) throw new Error("project row missing");
    // No session of this project is open, so it starts folded and untouched — the
    // slice holds NO entry for it, which is what lets the default answer at all.
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBeUndefined();
    fireEvent.click(row);
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBe(false);
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(getByText("atlas").closest("button") as Element);
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBe(true);
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  // The default the prototype ships (`app-sidebar.tsx`): a project opens because it
  // holds the session you are in, and every OTHER project stays shut. The two-project
  // fixture is what makes this visible — with one project on screen a "collapsed by
  // default" rule and an "expanded by default" rule are told apart only by the row
  // you are standing in, and the sibling is the half that regressed before.
  it("defaults to folded, except the project holding the active session", async () => {
    const { getByText, findByText } = mountSidebar({
      projects: [project("p1", "atlas"), project("p2", "beacon")],
      sessions: [...SESSIONS, { id: "s3", projectId: "p2", title: "Gamma", target: "your-branch" }],
      path: "/s/s1",
    });
    await findByText("atlas");
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("beacon").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    // …and the reviewer outranks the default in BOTH directions: shutting the active
    // project's own list sticks, rather than being reopened by the route.
    fireEvent.click(getByText("atlas").closest("button") as Element);
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  // The half the default alone cannot reach: a project with a STORED fold answers
  // `false` for expanded no matter which session you are in, so arriving in it left
  // the row you just opened hidden. Hidden now means ABSENT — a folded `Collapse`
  // mounts no children — so the row's arrival in the document is the whole assertion.
  it("navigating into a folded project reveals the session you opened", async () => {
    useRennetStore.setState((s) => ({ ui: { ...s.ui, sidebarFolds: { p2: true } } }));
    const { getByText, findByText, queryByText, history } = mountSidebar({
      projects: [project("p1", "atlas"), project("p2", "beacon")],
      sessions: [...SESSIONS, { id: "s3", projectId: "p2", title: "Gamma", target: "your-branch" }],
    });
    await findByText("beacon");
    expect(getByText("beacon").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("Gamma")).toBeNull();

    history.navigate("/s/s3");
    await waitFor(() =>
      expect(getByText("beacon").closest("button")?.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(useRennetStore.getState().ui.sidebarFolds.p2).toBe(false);
    expect(await findByText("Gamma")).toBeTruthy();
    // ...and ONLY that project: the sibling you did not navigate into is untouched,
    // so this is an arrival opening one list, not a route clearing every fold.
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("Alpha")).toBeNull();
  });

  // The unfold is keyed on the active project CHANGING, so it fires on arrival and
  // never again. Moving between two sessions of the SAME project must not reopen a
  // list the reviewer just shut — that would make the fold un-settable while you work.
  it("folding the project you are standing in stays folded across its own sessions", async () => {
    const { getByText, findByText, history } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
      path: "/s/s1",
    });
    await findByText("atlas");
    fireEvent.click(getByText("atlas").closest("button") as Element);
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBe(true);

    history.navigate("/s/s2");
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/s2"));
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBe(true);
  });

  it("highlights the active session from the route and follows a navigation", async () => {
    const { getByText, findByText, history } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
      path: "/s/s1",
    });
    await findByText("Alpha");
    expect(getByText("Alpha").closest("button")?.getAttribute("aria-current")).toBe("true");
    expect(getByText("Beta").closest("button")?.getAttribute("aria-current")).toBe("false");
    history.navigate("/s/s2");
    await waitFor(() =>
      expect(getByText("Beta").closest("button")?.getAttribute("aria-current")).toBe("true"),
    );
    expect(getByText("Alpha").closest("button")?.getAttribute("aria-current")).toBe("false");
  });

  it("renames a session on Enter and keeps the old title on Escape", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    const { getByText, getByRole, getByLabelText, queryByText } = view;
    await openProject(view, "atlas");
    await view.findByText("Alpha");
    // Escape does NOT commit.
    fireEvent.contextMenu(getByText("Alpha"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(getByLabelText("Session name"), { target: { value: "Renamed" } });
    fireEvent.keyDown(getByLabelText("Session name"), { key: "Escape" });
    expect(getByText("Alpha")).toBeTruthy();
    expect(queryByText("Renamed")).toBeNull();
    // Enter DOES commit.
    fireEvent.contextMenu(getByText("Alpha"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(getByLabelText("Session name"), { target: { value: "Renamed" } });
    fireEvent.keyDown(getByLabelText("Session name"), { key: "Enter" });
    await waitFor(() => expect(getByText("Renamed")).toBeTruthy());
  });

  it("renames a project inline, cancels on Escape, and sends blank to restore its default", async () => {
    const atlas = { ...project("p1", "atlas"), openPath: "/repos/acme/atlas" };
    const store = projectStore([atlas]);
    const { getByText, findByText, getByRole, getByLabelText, history } = mountSidebar({
      projects: [atlas],
      sessions: SESSIONS,
      path: "/s/s1",
      extraHandlers: store.handlers,
    });
    await findByText("atlas");

    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    const cancelled = getByLabelText("Project name") as HTMLInputElement;
    expect(cancelled.selectionStart).toBe(0);
    expect(cancelled.selectionEnd).toBe("atlas".length);
    fireEvent.change(cancelled, { target: { value: "Discard me" } });
    fireEvent.keyDown(cancelled, { key: "Escape" });
    expect(getByText("atlas")).toBeTruthy();
    expect(store.calls).toEqual([]);

    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    const committed = getByLabelText("Project name");
    fireEvent.change(committed, { target: { value: "Atlas Core" } });
    fireEvent.keyDown(committed, { key: "Enter" });
    await waitFor(() => expect(getByText("Atlas Core")).toBeTruthy());
    expect(store.calls).toEqual(["Atlas Core"]);
    expect(history.history.at(-1)).toBe("/s/s1");

    fireEvent.contextMenu(getByText("Atlas Core"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    const emptied = getByLabelText("Project name");
    fireEvent.change(emptied, { target: { value: "  " } });
    fireEvent.keyDown(emptied, { key: "Enter" });
    await waitFor(() => expect(getByText("acme/atlas")).toBeTruthy());
    expect(store.calls).toEqual(["Atlas Core", ""]);
    expect(store.list()[0]?.name).toBe("acme/atlas");
  });

  it("keeps a failed project rename in the editor and names the write failure", async () => {
    const atlas = project("p1", "atlas");
    const store = projectStore([atlas], new Error("daemon connection lost"));
    const { getByText, findByText, getByRole, getByLabelText, findByRole } = mountSidebar({
      projects: [atlas],
      extraHandlers: store.handlers,
    });
    await findByText("atlas");

    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Rename" }));
    const input = getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "Atlas Core" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await findByRole("alert")).textContent).toContain("daemon connection lost");
    expect(getByLabelText("Project name")).toBeTruthy();
    expect(store.list()[0]?.name).toBe("atlas");
  });

  it("archives a session, removing its row", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    const { getByText, getByRole, queryByText } = view;
    await openProject(view, "atlas");
    await view.findByText("Alpha");
    fireEvent.contextMenu(getByText("Alpha"));
    fireEvent.click(getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(queryByText("Alpha")).toBeNull());
  });

  it("pins a session into the Pinned section and unpins it away", async () => {
    const view = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    const { getByText, getAllByText, getByRole, queryByText } = view;
    await openProject(view, "atlas");
    await view.findByText("Alpha");
    expect(queryByText("Pinned")).toBeNull();
    fireEvent.contextMenu(getByText("Alpha"));
    fireEvent.click(getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(getByText("Pinned")).toBeTruthy());
    // Alpha now appears twice (Pinned + its project) — unpin from the pinned row.
    const rows = getAllByText("Alpha");
    expect(rows.length).toBeGreaterThan(1);
    const pinnedRow = rows[0];
    if (!pinnedRow) throw new Error("pinned row missing");
    fireEvent.contextMenu(pinnedRow);
    fireEvent.click(getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(queryByText("Pinned")).toBeNull());
  });

  it("fires projects.remove DIRECTLY from the menu — no confirmation ceremony (Rule Zero)", async () => {
    const remove = vi.fn(() => ({ projects: [] }));
    const { getByText, findByText, getByRole, queryByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
      extraHandlers: { "projects.remove": remove },
    });
    await findByText("atlas");
    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Remove project" }));
    // No dialog stands between the menu and the command.
    expect(queryByText(/Remove atlas/)).toBeNull();
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }));
  });

  it("navigates away only AFTER a successful removal of the project you stand in", async () => {
    const { getByText, findByText, getByRole, history } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
      path: "/s/s1", // standing in p1 via session s1
      extraHandlers: { "projects.remove": () => ({ projects: [] }) },
    });
    await findByText("atlas");
    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Remove project" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat"));
  });

  it("does NOT navigate (nor claim success) when the removal command rejects", async () => {
    const { getByText, findByText, getByRole, history } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
      path: "/s/s1",
      extraHandlers: {
        "projects.remove": () => {
          throw new Error("daemon connection lost");
        },
      },
    });
    await findByText("atlas");
    fireEvent.contextMenu(getByText("atlas"));
    fireEvent.click(getByRole("menuitem", { name: "Remove project" }));
    // Give the rejected mutation a turn to settle, then prove we stayed put.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(history.history).not.toContain("/new-chat");
    expect(history.history.at(-1)).toBe("/s/s1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// macOS traffic-light clearance — state 1 of the corner slot (C20, #558). The
// desktop window is `titleBarStyle: "hiddenInset"` on darwin, so the native
// close/minimise/zoom buttons paint OVER the renderer's top-left — on top of the
// lockup, which made the wordmark unreadable on a real packaged build. With the
// sidebar expanded the sidebar owns the slot, and the row now reads
// lights → toggle: the identity has LEFT this strip for its own row beneath it.
//
// So the budget this describes has collapsed from seven terms to three. What it still
// proves is the thing #557 was about: the reserve is declared, the strip is the drag
// surface, and nothing interactive sits under the lights. The lockup row is measured
// separately below — it is not titlebar and answers to the panel width, not the lights.
// ─────────────────────────────────────────────────────────────────────────────

/** The WORDMARK half's authored aspect ratio (`lockup.tsx`): width = height × this. */
const WORDMARK_RATIO = 480.168 / 112;
/** Every term of the state-1 corner row, in px, as the component declares them. */
const LIGHT_RESERVE = 81; // pl-[81px]
const TRAILING_PAD = 12; // pr-3
const TOGGLE = 24; // size-6
/** The lockup row (`sidebar.tsx`), which is a row of the PANEL, not of the titlebar. */
const LOCKUP_ROW_PAD_LEFT = 16; // pl-4, the actions' icon column
const MARK = 44; // the live sphere
const WORDMARK = 22; // HALF the mark — the stacked-header prototype's 2:1
const LOCKUP_GAP = 8; // gap-2 ≈ the authored 24/126 of a 44px mark (8.38)

function cornerSlot(container: Element): Element {
  const slot = container.querySelector('[data-slot="corner-slot"]');
  if (!slot) throw new Error("sidebar header has no corner slot");
  return slot;
}

function lockupRow(container: Element): Element {
  const row = container.querySelector('[data-slot="sidebar-lockup"]');
  if (!row) throw new Error("sidebar has no lockup row");
  return row;
}

/** The sphere — live canvas in a real window, the static colour mark under happy-dom.
 *  Either way the ROOT carries `data-liquid-sphere`, which is what the chrome asserts. */
function slotSphere(root: Element): Element {
  const sphere = root.querySelector("[data-liquid-sphere]");
  if (!sphere) throw new Error("no sphere");
  return sphere;
}

/** The wordmark SVG. "The one non-lucide svg" no longer identifies it: the sphere's
 *  static fallback draws an SVG of its own, and it comes FIRST in document order, so the
 *  old helper would silently have measured the sphere and passed. The wordmark is the
 *  non-lucide svg that is not inside the sphere. */
function slotWordmark(root: Element): Element {
  const svg = [...root.querySelectorAll("svg:not(.lucide)")].find(
    (el) => el.closest("[data-liquid-sphere]") === null,
  );
  if (!svg) throw new Error("no wordmark");
  return svg;
}

describe("macOS traffic-light clearance (corner slot, state 1)", () => {
  it("insets the slot, holds nothing but the toggle, and makes the strip the drag surface on darwin", () => {
    const { container } = mountSidebar({
      projects: [project("p1", "atlas")],
      platform: "darwin",
    });
    const slot = cornerSlot(container);
    expect(slot.getAttribute("data-owner")).toBe("sidebar");
    expect(slot.className).toContain("pl-[81px]");
    expect(slot.className).not.toContain("pl-3");
    // With hiddenInset the strip IS the titlebar; `app-region-drag` drags it and each
    // control inside marks itself `app-region-no-drag`.
    expect(slot.className).toContain("app-region-drag");

    // The identity is NOT here any more: no sphere, no wordmark, no accessible name.
    // Those three absences are the whole point of the change and each is asserted on
    // its own, because "the row looks right" is exactly what a screenshot cannot say.
    expect(slot.querySelector("[data-liquid-sphere]")).toBeNull();
    expect(slot.querySelectorAll("svg:not(.lucide)").length).toBe(0);
    expect(slot.querySelectorAll('[aria-label="Rennet"]').length).toBe(0);

    // What is left is the toggle, alone, held at the row's trailing edge.
    const controls = slot.querySelectorAll("button, a, input, [role='button']");
    expect(controls.length).toBe(1);
    const toggle = slot.querySelector('[aria-label="Collapse sidebar"]');
    if (!toggle) throw new Error("corner slot has no sidebar toggle");
    expect(controls[0]).toBe(toggle);
    expect(toggle.className).toContain("ml-auto");

    // The budget the corner row has to clear is now only its own: 81 + 12 + 24 = 117
    // of 256. It was 255.9 when the lockup rode this strip, which is why the lockup
    // could not grow inside it and why it moved.
    expect(LIGHT_RESERVE + TRAILING_PAD + TOGGLE).toBeLessThanOrEqual(SIDEBAR_PANEL_WIDTH);
  });

  it("leaves every non-darwin host un-inset and undraggable, with the same single toggle", () => {
    for (const platform of ["win32", "linux", undefined]) {
      const { container } = mountSidebar({
        projects: [project("p1", "atlas")],
        platform,
      });
      const slot = cornerSlot(container);
      expect(slot.className).toContain("pl-3");
      expect(slot.className).not.toMatch(/pl-\[\d+px\]/);
      expect(slot.className).not.toContain("app-region-drag");
      // Non-darwin loses the inset, not the affordance: the same single toggle.
      expect(slot.querySelectorAll('[aria-label="Collapse sidebar"]').length).toBe(1);
      // And the lockup row is a row of the PANEL, so it is identical on every host.
      expect(slotWordmark(lockupRow(container)).getAttribute("height")).toBe(String(WORDMARK));
      cleanup();
    }
  });

  it("rests the sphere until a session is running, then works while one is", () => {
    // The sphere is the app's working state in state 1 — the same fact the collapsed
    // orb carries. Driven through the review-activity projection, which is what the
    // sidebar's own rows read, so this cannot pass on a prop nobody sets.
    const { container } = mountSidebar({ projects: [project("p1", "atlas")] });
    expect(slotSphere(lockupRow(container)).getAttribute("data-state")).toBe("resting");
    act(() =>
      useReviewActivityState.setState({ bySession: { s1: { kind: "running", runId: "r1" } } }),
    );
    expect(slotSphere(lockupRow(container)).getAttribute("data-state")).toBe("working");
    act(() => useReviewActivityState.setState({ bySession: {} }));
    expect(slotSphere(lockupRow(container)).getAttribute("data-state")).toBe("resting");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lockup row — Rai's placement from `spikes/sidebar-lockup-prototypes`: "Own row"
// geometry with the stacked header's 2:1 mark-to-wordmark proportion. It sits BELOW
// the corner strip, so it is panel, not titlebar: it does not drag the window and it
// answers to the 256px panel width rather than to the light reserve.
// ─────────────────────────────────────────────────────────────────────────────
describe("the sidebar lockup row", () => {
  it("draws one lockup, beneath the corner slot, at 44 over 22", () => {
    const { container } = mountSidebar({ projects: [project("p1", "atlas")], platform: "darwin" });
    const rows = container.querySelectorAll('[data-slot="sidebar-lockup"]');
    expect(rows.length).toBe(1);
    const row = lockupRow(container);

    // BENEATH the corner slot, and outside it — the strip owns the lights and the
    // toggle, this row owns the identity. Node.DOCUMENT_POSITION_FOLLOWING (4).
    const slot = cornerSlot(container);
    expect(row.closest('[data-slot="corner-slot"]')).toBeNull();
    expect(slot.compareDocumentPosition(row) & 4).toBe(4);
    // ...and ABOVE the actions, so the identity leads the panel. Asserted by POSITION
    // against a named neighbour rather than by membership: "a button exists after it"
    // is satisfied by every arrangement of the panel, including the wrong ones.
    const searchRow = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Search"),
    );
    if (!searchRow) throw new Error("sidebar has no Search action");
    expect(row.compareDocumentPosition(searchRow) & 4).toBe(4);
    expect(row.nextElementSibling?.contains(searchRow)).toBe(true);

    // 44px mark, 22px wordmark: the wordmark is exactly HALF the mark. Asserted as a
    // RATIO as well as two numbers, because the pair is the decision — either size
    // alone could drift to something that still reads plausibly in a screenshot.
    const sphere = slotSphere(row);
    expect((sphere as HTMLElement).style.width).toBe(`${MARK}px`);
    expect((sphere as HTMLElement).style.height).toBe(`${MARK}px`);
    const svg = slotWordmark(row);
    const height = Number(svg.getAttribute("height"));
    expect(height).toBe(WORDMARK);
    expect(height * 2).toBe(MARK);
    // The width follows the authored 480.168:112 window — ~94.3px.
    expect(Number(svg.getAttribute("width"))).toBeCloseTo(WORDMARK * WORDMARK_RATIO, 3);

    // Mark then wordmark, at the authored gap, on the actions' 16px icon column,
    // vertically centred on each other.
    expect(sphere.compareDocumentPosition(svg) & 4).toBe(4);
    expect(row.className).toContain("gap-2");
    expect(row.className).toContain("pl-4");
    expect(row.className).toContain("h-14");
    expect(row.className).toContain("items-center");

    // The row fits the panel with room to spare: 16 + 44 + 8 + 94.3 + 12 = 174.3.
    expect(
      LOCKUP_ROW_PAD_LEFT + MARK + LOCKUP_GAP + Number(svg.getAttribute("width")) + TRAILING_PAD,
    ).toBeLessThanOrEqual(SIDEBAR_PANEL_WIDTH);
  });

  it("carries the one accessible name on the wrapper, and is not a drag region", () => {
    const { container } = mountSidebar({ projects: [project("p1", "atlas")], platform: "darwin" });
    const row = lockupRow(container);
    // ONE role=img called "Rennet" over two decorative halves — the accessible name is
    // unchanged by the move, which is the part a geometry assertion cannot see.
    expect(row.getAttribute("role")).toBe("img");
    expect(row.getAttribute("aria-label")).toBe("Rennet");
    expect(container.querySelectorAll('[aria-label="Rennet"]').length).toBe(1);
    expect(slotSphere(row).getAttribute("aria-label")).toBeNull();
    expect(slotWordmark(row).getAttribute("aria-hidden")).toBe("true");
    // Below the titlebar strip on darwin, so it neither drags nor opts out of dragging.
    // What this CANNOT prove: `-webkit-app-region` has no representation in happy-dom,
    // so this is the absence of the DECLARATION, not of the behaviour.
    expect(row.className).not.toContain("app-region-drag");
    expect(row.className).not.toContain("app-region-no-drag");
  });
});

it("exposes running activity when the existing session row receives keyboard focus", async () => {
  const view = mountSidebar({
    projects: [project("p1", "atlas")],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        title: "Alpha",
        preparation: { status: "capturing", step: "capturing-change" },
      },
    ],
  });
  await openProject(view, "atlas");
  const row = await view.findByRole("button", { name: /Alpha/ });
  expect(view.getByRole("status", { name: "Reviewing the change" })).toBeTruthy();
  for (let step = 0; step < 20 && document.activeElement !== row; step++) await view.user.tab();
  expect(document.activeElement).toBe(row);
  await waitFor(() =>
    expect(view.getByRole("tooltip").textContent).toContain("Reviewing the change"),
  );
  expect(row.querySelector("button")).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// The footer is a second titlebar handle. On darwin the strip carries the drag
// region (the empty gap the Update pill's `ml-auto` opens is the target), and
// every standing control inside opts back out with `app-region-no-drag` — the
// same convention the corner slot carries, so a new footer button that forgets
// it goes dead to the click. jsdom cannot verify the OS actually drags the
// window (Electron-only); it can pin the class contract that makes it possible.
// ─────────────────────────────────────────────────────────────────────────────

/** The footer strip: the `border-t` container that holds Settings · Help · Update. */
function footer(container: Element, byLabel: (label: string) => HTMLElement): Element {
  const strip = byLabel("Settings").closest("div.border-t");
  if (!strip || !container.contains(strip)) throw new Error("sidebar has no footer strip");
  return strip;
}

describe("window drag surface (footer)", () => {
  it("makes the footer strip draggable on darwin while every control opts out", async () => {
    useUpdateReady.setState({ ready: { version: "1.2.3" } });
    const { container, getByLabelText, getByText, findByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: [{ id: "s9", projectId: "p1", title: "Old", archived: true }],
      platform: "darwin",
    });
    // Archived renders once the session projection resolves (async), like elsewhere.
    await findByText("Archived");
    const strip = footer(container, getByLabelText);
    expect(strip.className).toContain("app-region-drag");
    // Archived (count > 0), Settings, Help and the ready Update pill must each opt out,
    // or a drag started on the control swallows its own click.
    for (const control of [
      getByText("Archived").closest("button"),
      getByLabelText("Settings"),
      getByLabelText("Help"),
      getByText("Update").closest("button"),
    ]) {
      if (!control) throw new Error("missing footer control");
      expect(control.className).toContain("app-region-no-drag");
    }
  });

  it("leaves the footer undraggable on every non-darwin host", () => {
    for (const platform of ["win32", "linux", undefined]) {
      const { container, getByLabelText } = mountSidebar({
        projects: [project("p1", "atlas")],
        platform,
      });
      expect(footer(container, getByLabelText).className).not.toContain("app-region-drag");
      cleanup();
    }
  });
});
