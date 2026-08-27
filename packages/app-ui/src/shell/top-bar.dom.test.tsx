// @vitest-environment happy-dom
//
// The 56px session top-bar (C03 §4). The History · Map · Diff pill derives its
// selection from `?view` and toggles with `viewToggle` (replace — no back-stack
// entry); the back arrow shows exactly off-board; the trail renders title +
// `project › target` + needs-you WORDS from the projection.
import type { Project } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { fixtureCompletedRoundsSource } from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import {
  type SidebarSession,
  type SidebarSessionProjection,
  SidebarSessionProjectionProvider,
} from "./sidebar-data";
import { TopBar } from "./top-bar";

afterEach(cleanup);

function project(id: string, name: string): Project {
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
    source: "local",
  };
}

const SESSIONS: Record<string, readonly SidebarSession[]> = {
  p1: [
    {
      id: "s2",
      slug: "s2",
      title: "Beta",
      time: "1d",
      target: "your-pr",
      targetState: "needs-you",
    },
  ],
};

function mountTopBar(path: string, rounds?: RoundsSource) {
  const history = memoryHistory(path);
  const bridge = new MemoryBridge(frontDoorHandlers([project("p1", "atlas")]));
  const projection: SidebarSessionProjection = {
    sessionsByProject: SESSIONS,
    renameSession: () => undefined,
    setSessionPinned: () => undefined,
    archiveSession: () => undefined,
    restoreSession: () => undefined,
    renameProject: () => undefined,
  };
  const inner = (
    <SidebarSessionProjectionProvider value={projection}>
      <TopBar />
    </SidebarSessionProjectionProvider>
  );
  const utils = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        {rounds ? <RoundsSourceProvider value={rounds}>{inner}</RoundsSourceProvider> : inner}
      </Router>
    </BridgeProvider>,
  );
  return { ...utils, history };
}

describe("session top-bar (C03 §4)", () => {
  it("derives the pill selection from ?view", () => {
    const { getByText } = mountTopBar("/s/s2?view=map");
    expect(getByText("Map").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(getByText("Diff").closest("button")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("selects no pill on the board view", () => {
    const { getByText, queryByText } = mountTopBar("/s/s2");
    for (const label of ["Map", "Diff"]) {
      expect(getByText(label).closest("button")?.getAttribute("aria-pressed")).toBe("false");
    }
    // History (rounds) is gated on a completed round — absent over the default source.
    expect(queryByText("History")).toBeNull();
  });

  it("shows the History pill exactly when a round has completed", () => {
    // Absent by default (above); present once the source carries a completed round.
    const { getByText } = mountTopBar("/s/s2", fixtureCompletedRoundsSource);
    expect(getByText("History")).toBeTruthy();
  });

  it("toggles with replace — the back-stack does not grow", () => {
    const { getByText, history } = mountTopBar("/s/s2");
    const before = history.history.length;
    fireEvent.click(getByText("Diff"));
    expect(history.history.length).toBe(before);
    // ...and the URL now carries the toggled view.
    expect(history.history.at(-1)).toContain("view=diff");
  });

  it("shows the back arrow exactly off-board", () => {
    expect(mountTopBar("/s/s2?view=diff").getByLabelText("Back to board")).toBeTruthy();
    cleanup();
    expect(mountTopBar("/s/s2").queryByLabelText("Back to board")).toBeNull();
  });

  it("back returns to the board (replace, not a browser pop)", () => {
    const { getByLabelText, history } = mountTopBar("/s/s2?view=diff");
    const before = history.history.length;
    fireEvent.click(getByLabelText("Back to board"));
    expect(history.history.length).toBe(before);
    expect(history.history.at(-1)).not.toContain("view=");
  });

  it("renders the trail: title over project › target with needs-you words", async () => {
    const { container, findByText } = mountTopBar("/s/s2");
    // The trail's title is the session slug until projects.list resolves; then the
    // projection fills in project › target + needs-you.
    await findByText("Beta");
    await waitFor(() => expect(container.textContent ?? "").toContain("atlas"));
    const text = container.textContent ?? "";
    expect(text).toContain("Your PR");
    expect(text).toContain("needs you");
  });
});
