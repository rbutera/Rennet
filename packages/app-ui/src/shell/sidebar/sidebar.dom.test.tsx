// @vitest-environment happy-dom
//
// The sidebar (C03 §2–3) over a MemoryBridge: the projects half is real
// (`projects.list` / `projects.remove`), the sessions half rides the B9 projection
// context (reconciliation 2) so rename / pin / archive / highlight are provable
// today. Zero props — every read and write resolves through `sidebar-data`, folds
// through the `ui` slice, highlight from the route.
import type { Project } from "@rennet/protocol";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { useUpdateReady } from "../../components/update-ready";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { useRennetStore } from "../../store";
import { cleanup, fireEvent, mount, waitFor } from "../../test/dom";
import { frontDoorHandlers } from "../../test/fixtures/front-door";
import { MemoryBridge, type MemoryBridgeHandlers } from "../../test/memory-bridge";
import { SIDEBAR_PANEL_WIDTH } from "../constants";
import {
  type SidebarSession,
  type SidebarSessionProjection,
  SidebarSessionProjectionProvider,
} from "../sidebar-data";
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

type SessionMap = Record<string, readonly SidebarSession[]>;

/** A state-backed projection so a mutation re-renders the tree (the row appears /
 *  disappears / renames), exactly as B9's real projection will once it lands. */
function Harness({
  bridge,
  history,
  seed,
}: {
  readonly bridge: MemoryBridge;
  readonly history: ReturnType<typeof memoryHistory>;
  readonly seed: SessionMap;
}): ReactNode {
  const [sessions, setSessions] = useState<SessionMap>(seed);
  const map = (id: string, patch: (s: SidebarSession) => SidebarSession): void =>
    setSessions((prev) => {
      const next: SessionMap = {};
      for (const [pid, rows] of Object.entries(prev)) {
        next[pid] = rows.map((s) => (s.id === id ? patch(s) : s));
      }
      return next;
    });
  const projection: SidebarSessionProjection = {
    sessionsByProject: sessions,
    renameSession: (id, title) => map(id, (s) => ({ ...s, title })),
    setSessionPinned: (id, pinned) => map(id, (s) => ({ ...s, pinned })),
    archiveSession: (id) => map(id, (s) => ({ ...s, archived: true })),
    restoreSession: (id) => map(id, (s) => ({ ...s, archived: false })),
    renameProject: () => undefined,
  };
  return (
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <SidebarSessionProjectionProvider value={projection}>
          <Sidebar />
        </SidebarSessionProjectionProvider>
      </Router>
    </BridgeProvider>
  );
}

function mountSidebar(opts: {
  projects?: readonly Project[];
  sessions?: SessionMap;
  path?: string;
  extraHandlers?: MemoryBridgeHandlers;
  platform?: string;
}) {
  const history = memoryHistory(opts.path ?? "/");
  const bridge = new MemoryBridge(
    {
      ...frontDoorHandlers(opts.projects ?? []),
      ...opts.extraHandlers,
    },
    { platform: opts.platform },
  );
  const utils = mount(<Harness bridge={bridge} history={history} seed={opts.sessions ?? {}} />);
  return { ...utils, history, bridge };
}

const SESSIONS: SessionMap = {
  p1: [
    { id: "s1", slug: "s1", title: "Alpha", time: "2h", target: "your-branch" },
    {
      id: "s2",
      slug: "s2",
      title: "Beta",
      time: "1d",
      target: "your-pr",
      targetState: "needs-you",
      unread: true,
    },
  ],
};

describe("sidebar structure (C03 §2)", () => {
  it("collapses the panel to the rail, writing ui.sidebarOpen both ways", async () => {
    const { getByLabelText } = mountSidebar({ projects: [project("p1", "atlas")] });
    fireEvent.click(getByLabelText("Collapse sidebar"));
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
    await waitFor(() => expect(getByLabelText("Expand sidebar")).toBeTruthy());
    fireEvent.click(getByLabelText("Expand sidebar"));
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
  });

  it("keeps keyboard focus on the toggle across a collapse AND an expand", async () => {
    const { getByLabelText } = mountSidebar({ projects: [project("p1", "atlas")] });
    const collapse = getByLabelText("Collapse sidebar");
    collapse.focus();
    expect(document.activeElement).toBe(collapse);
    // Collapse: the panel subtree unmounts — focus must land on the rail's Expand
    // toggle, not fall to <body>.
    fireEvent.click(collapse);
    const expand = await waitFor(() => getByLabelText("Expand sidebar"));
    expect(document.activeElement).toBe(expand);
    // Expand again: focus returns to the panel's Collapse toggle.
    fireEvent.click(expand);
    const collapseAgain = await waitFor(() => getByLabelText("Collapse sidebar"));
    expect(document.activeElement).toBe(collapseAgain);
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

  it("orders the expanded footer Update → Help → Settings (rail order, read left-to-right)", () => {
    useUpdateReady.setState({ ready: { version: "1.2.3" } });
    const { getByText, getByLabelText } = mountSidebar({ projects: [project("p1", "atlas")] });
    const order = [
      getByText("Update").closest("button"),
      getByLabelText("Help"),
      getByLabelText("Settings"),
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
      sessions: {
        p1: [
          { id: "s9", slug: "s9", title: "Old", time: "3d", target: "your-branch", archived: true },
        ],
      },
    });
    expect(await some.findByText("Archived")).toBeTruthy();
  });
});

describe("sidebar tree (C03 §3)", () => {
  it("renders host + project + session rows from the projection", async () => {
    const { getByText, findByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    expect(await findByText("atlas")).toBeTruthy();
    expect(getByText("This machine")).toBeTruthy();
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();
  });

  it("groups a remote project under a remote host", async () => {
    const { findByText } = mountSidebar({ projects: [project("p2", "billing", "remote:dev-box")] });
    expect(await findByText("dev-box")).toBeTruthy();
  });

  it("shows a reviewed session's green tick beside the title (R36), not a recolored icon", async () => {
    const { findByLabelText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: {
        p1: [
          {
            id: "s1",
            slug: "s1",
            title: "Done",
            time: "2h",
            target: "your-pr",
            targetState: "reviewed",
          },
        ],
      },
    });
    // The separate tick carries the "Reviewed" name; the leading target icon stays "Your PR".
    expect(await findByLabelText("Reviewed")).toBeTruthy();
    expect(await findByLabelText("Your PR")).toBeTruthy();
  });

  it("folds a project through the ui slice (aria-expanded + ui.sidebarFolds)", async () => {
    const { getByText, findByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    await findByText("atlas");
    const row = getByText("atlas").closest("button");
    if (!row) throw new Error("project row missing");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(useRennetStore.getState().ui.sidebarFolds.p1).toBe(true);
    expect(getByText("atlas").closest("button")?.getAttribute("aria-expanded")).toBe("false");
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
    const { getByText, findByText, getByRole, getByLabelText, queryByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    await findByText("Alpha");
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

  it("archives a session, removing its row", async () => {
    const { getByText, findByText, getByRole, queryByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    await findByText("Alpha");
    fireEvent.contextMenu(getByText("Alpha"));
    fireEvent.click(getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(queryByText("Alpha")).toBeNull());
  });

  it("pins a session into the Pinned section and unpins it away", async () => {
    const { getByText, findByText, getAllByText, getByRole, queryByText } = mountSidebar({
      projects: [project("p1", "atlas")],
      sessions: SESSIONS,
    });
    await findByText("Alpha");
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
// macOS traffic-light clearance. The desktop window is `titleBarStyle:
// "hiddenInset"` on darwin, so the native close/minimise/zoom buttons paint OVER
// the renderer's top-left — on top of the lockup, which made the wordmark
// unreadable on a real packaged build. Both sidebar states must clear them, and
// no other host may pay for it.
// ─────────────────────────────────────────────────────────────────────────────

/** The lockup's authored aspect ratio (`lockup.tsx`): width = height × this. */
const LOCKUP_RATIO = 726.868 / 126;

function headerLockup(header: Element): Element {
  const svg = header.querySelector("svg");
  if (!svg) throw new Error("sidebar header has no lockup");
  return svg;
}

describe("macOS traffic-light clearance", () => {
  it("insets the header, shrinks the lockup, and makes the strip the drag surface on darwin", () => {
    const { getByTestId } = mountSidebar({
      projects: [project("p1", "atlas")],
      platform: "darwin",
    });
    const header = getByTestId("sidebar-header");
    expect(header.className).toContain("pl-[76px]");
    expect(header.className).not.toContain("pl-3");
    // With hiddenInset the strip IS the titlebar; the shared `navigation-titlebar`
    // rule drags it and opts its buttons back out.
    expect(header.className).toContain("navigation-titlebar");

    const svg = headerLockup(header);
    expect(svg.getAttribute("height")).toBe("14");
    // Unclipped: the 76px reserved zone + the lockup's own rendered width + the
    // 12px trailing pad + the 24px collapse toggle must all fit the 256px panel.
    const width = Number(svg.getAttribute("width"));
    expect(width).toBeCloseTo(14 * LOCKUP_RATIO, 3);
    expect(76 + width + 12 + 24).toBeLessThanOrEqual(SIDEBAR_PANEL_WIDTH);
  });

  it("clears the lights vertically on the collapsed rail, which is narrower than they are", async () => {
    const { getByLabelText } = mountSidebar({
      projects: [project("p1", "atlas")],
      platform: "darwin",
    });
    fireEvent.click(getByLabelText("Collapse sidebar"));
    const rail = await waitFor(() => {
      const parent = getByLabelText("Expand sidebar").parentElement;
      if (!parent) throw new Error("rail not mounted");
      return parent;
    });
    expect(rail.className).toContain("pt-8");
  });

  it("leaves every non-darwin host un-inset, full-size and undraggable", () => {
    for (const platform of ["win32", "linux", undefined]) {
      const { getByTestId } = mountSidebar({
        projects: [project("p1", "atlas")],
        platform,
      });
      const header = getByTestId("sidebar-header");
      expect(header.className).toContain("pl-3");
      expect(header.className).not.toContain("pl-[76px]");
      expect(header.className).not.toContain("navigation-titlebar");
      expect(headerLockup(header).getAttribute("height")).toBe("16");
      cleanup();
    }
  });
});
