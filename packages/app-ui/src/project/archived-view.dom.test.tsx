// @vitest-environment happy-dom
//
// The archived-sessions view (C10 §9, enriching C12's minimal list) over a MemoryBridge.
// Sessions are B9-shaped: they arrive through the sidebar's session projection (empty in
// the live client until B9), so the test drives archived rows through the projection
// context — no fake session protocol. Search matches title OR project name; Escape in the
// search field clears it BEFORE the window listener can close the view; sort covers
// recent (fuzzy-time parse) / project / title; a row opens its session; Unarchive calls
// `restoreSession`, un-archiving the row (release is archive-only, never a delete).
import type { Project } from "@rennet/protocol";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath, sessionPath } from "../routes/url";
import {
  type SidebarSession,
  type SidebarSessionProjection,
  SidebarSessionProjectionProvider,
} from "../shell/sidebar-data";
import { cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ArchivedView } from "./archived-view";

afterEach(cleanup);

function project(id: string, name: string, path: string): Project {
  return {
    id,
    name,
    path,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: path,
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

function session(over: Partial<SidebarSession> = {}): SidebarSession {
  return {
    id: "s1",
    slug: "s1",
    title: "Review the auth refactor",
    time: "2d",
    target: "your-branch",
    archived: true,
    ...over,
  };
}

/**
 * Mounts ArchivedView with a stateful projection so Unarchive genuinely mutates it, over
 * two projects (rennet / webapp) so project-name search + project sort have something to
 * discriminate. `sessionsByProject` keys the projection; `projects.list` supplies the tree.
 */
function renderArchived(byProject: Record<string, SidebarSession[]>) {
  const history = memoryHistory("/archived");
  const bridge = new MemoryBridge({
    "projects.list": () => ({
      projects: [
        project("p1", "rennet", "/home/rai/rennet"),
        project("p2", "webapp", "/home/rai/webapp"),
      ],
    }),
  });
  function Harness() {
    const [rows, setRows] = useState(byProject);
    const projection: SidebarSessionProjection = {
      sessionsByProject: rows,
      renameSession: () => undefined,
      setSessionPinned: () => undefined,
      archiveSession: () => undefined,
      restoreSession: (id) =>
        setRows((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([pid, list]) => [
              pid,
              list.map((s) => (s.id === id ? { ...s, archived: false } : s)),
            ]),
          ),
        ),
      renameProject: () => undefined,
    };
    return (
      <SidebarSessionProjectionProvider value={projection}>
        <ArchivedView />
      </SidebarSessionProjectionProvider>
    );
  }
  return {
    ...mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Harness />
        </Router>
      </BridgeProvider>,
    ),
    history,
  };
}

/** The archived row titles in DOM order (Testing Library returns matches in document order). */
function orderedTitles(): string[] {
  return screen
    .getAllByText(/Review the auth refactor|Fix the parser|Bump deps/)
    .map((node) => node.textContent ?? "");
}

describe("ArchivedView — C10 §9 enrichment", () => {
  it("states an honest empty when nothing is archived, and shows no search/sort", () => {
    renderArchived({ p1: [session({ archived: false })] });
    expect(screen.getByText("Nothing archived.")).toBeTruthy();
    expect(screen.getByText("Right-click a session in the sidebar to archive it.")).toBeTruthy();
    expect(screen.queryByLabelText("Search archived sessions")).toBeNull();
  });

  it("lists only archived rows and shows the count in the header", async () => {
    renderArchived({
      p1: [session(), session({ id: "s2", title: "Live one", archived: false })],
      p2: [session({ id: "s3", title: "Fix the parser", time: "now", target: "your-pr" })],
    });
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    expect(screen.queryByText("Live one")).toBeNull();
    // Header count = number archived (2), not total sessions.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("searches by session title", async () => {
    renderArchived({
      p1: [session()],
      p2: [session({ id: "s3", title: "Fix the parser", time: "now", target: "your-pr" })],
    });
    await waitFor(() => expect(screen.getByText("Fix the parser")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search archived sessions"), {
      target: { value: "auth" },
    });
    expect(screen.getByText("Review the auth refactor")).toBeTruthy();
    expect(screen.queryByText("Fix the parser")).toBeNull();
  });

  it("searches by project name", async () => {
    renderArchived({
      p1: [session()],
      p2: [session({ id: "s3", title: "Fix the parser", time: "now", target: "your-pr" })],
    });
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search archived sessions"), {
      target: { value: "webapp" },
    });
    // Only the session under the "webapp" project survives the project-name match.
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    expect(screen.queryByText("Review the auth refactor")).toBeNull();
  });

  it("names the query when nothing matches", async () => {
    renderArchived({ p1: [session()] });
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search archived sessions"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No archived sessions match “zzz”.")).toBeTruthy();
  });

  it("clears the search on Escape BEFORE it can close the view", async () => {
    const { history } = renderArchived({ p1: [session()] });
    const input = await waitFor(() => screen.getByLabelText("Search archived sessions"));
    fireEvent.change(input, { target: { value: "auth" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // The search cleared and the view stayed — Escape did NOT navigate away.
    expect((input as HTMLInputElement).value).toBe("");
    expect(history.history.at(-1)).toBe("/archived");
    // A second Escape, with an already-empty field, now leaves to New Chat.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(history.history.at(-1)).toBe(newChatPath());
  });

  it("sorts by recent (fuzzy-time), project, then title", async () => {
    renderArchived({
      p1: [
        session({ id: "s1", title: "Review the auth refactor", time: "2d" }),
        session({ id: "s2", title: "Bump deps", time: "3w" }),
      ],
      p2: [session({ id: "s3", title: "Fix the parser", time: "now", target: "your-pr" })],
    });
    await waitFor(() => expect(screen.getByText("Fix the parser")).toBeTruthy());
    // recent (default): now < 2d < 3w — the fuzzy times parse to a real order.
    expect(orderedTitles()).toEqual(["Fix the parser", "Review the auth refactor", "Bump deps"]);
    // project: rennet (p1: s1, s2) before webapp (p2: s3), ties broken by recency.
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(orderedTitles()).toEqual(["Review the auth refactor", "Bump deps", "Fix the parser"]);
    // title: alphabetical.
    fireEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(orderedTitles()).toEqual(["Bump deps", "Fix the parser", "Review the auth refactor"]);
  });

  it("renders row anatomy: reviewed tick + project chip", async () => {
    renderArchived({ p1: [session({ targetState: "reviewed" })] });
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    expect(screen.getByLabelText("Reviewed")).toBeTruthy();
    expect(screen.getByText("rennet")).toBeTruthy();
  });

  it("opens the session when its row is selected", async () => {
    const { history } = renderArchived({ p1: [session({ slug: "auth-refactor" })] });
    const title = await waitFor(() => screen.getByText("Review the auth refactor"));
    fireEvent.click(title);
    expect(history.history.at(-1)).toBe(sessionPath("auth-refactor"));
  });

  it("unarchives a row out of the list", async () => {
    renderArchived({ p1: [session()] });
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    fireEvent.click(screen.getByText("Unarchive"));
    await waitFor(() => expect(screen.queryByText("Review the auth refactor")).toBeNull());
    expect(screen.getByText("Nothing archived.")).toBeTruthy();
  });

  it("leaves to New Chat on Back", async () => {
    const { history } = renderArchived({ p1: [session()] });
    await waitFor(() => expect(screen.getByLabelText("Back")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Back"));
    expect(history.history.at(-1)).toBe(newChatPath());
  });
});
