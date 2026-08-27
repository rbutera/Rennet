// @vitest-environment happy-dom
//
// The archived-sessions view (C12 cluster 5) over a MemoryBridge. Sessions are
// B9-shaped: they arrive through the sidebar's session projection (empty in the live
// client until B9), so the test drives archived rows through the projection context —
// no fake session protocol. Restore calls `restoreSession`, un-archiving the row; the
// row then leaves the archived list (release is archive-only, never a delete).
import type { Project } from "@rennet/protocol";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath } from "../routes/url";
import {
  type SidebarSession,
  type SidebarSessionProjection,
  SidebarSessionProjectionProvider,
} from "../shell/sidebar-data";
import { cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ArchivedView } from "./archived-view";

afterEach(cleanup);

function project(id: string): Project {
  return {
    id,
    name: "rennet",
    path: "/home/rai/rennet",
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: "/home/rai/rennet",
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

/** Mounts ArchivedView with a stateful projection so Restore genuinely mutates it. */
function renderArchived(initial: SidebarSession[]) {
  const history = memoryHistory("/archived");
  const bridge = new MemoryBridge({ "projects.list": () => ({ projects: [project("p1")] }) });
  function Harness() {
    const [rows, setRows] = useState<SidebarSession[]>(initial);
    const projection: SidebarSessionProjection = {
      sessionsByProject: { p1: rows },
      renameSession: () => undefined,
      setSessionPinned: () => undefined,
      archiveSession: (id) =>
        setRows((prev) => prev.map((s) => (s.id === id ? { ...s, archived: true } : s))),
      restoreSession: (id) =>
        setRows((prev) => prev.map((s) => (s.id === id ? { ...s, archived: false } : s))),
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

describe("ArchivedView — archived sessions (C12 cluster 5)", () => {
  it("lists archived sessions and restores a row out of the list", async () => {
    renderArchived([session(), session({ id: "s2", title: "Live one", archived: false })]);
    // Only the archived row lists; the live one never appears here.
    await waitFor(() => expect(screen.getByText("Review the auth refactor")).toBeTruthy());
    expect(screen.queryByText("Live one")).toBeNull();

    fireEvent.click(screen.getByText("Restore"));
    // Restored → un-archived → it leaves the archived list (returns to the live sidebar).
    await waitFor(() => expect(screen.queryByText("Review the auth refactor")).toBeNull());
    expect(screen.getByText("Nothing archived.")).toBeTruthy();
  });

  it("states an honest empty when nothing is archived", () => {
    renderArchived([]);
    expect(screen.getByText("Nothing archived.")).toBeTruthy();
  });

  it("leaves to New Chat on Back", async () => {
    const { history } = renderArchived([session()]);
    await waitFor(() => expect(screen.getByLabelText("Back")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Back"));
    expect(history.history.at(-1)).toBe(newChatPath());
  });
});
