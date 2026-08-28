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
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { fixtureCompletedRoundsSource } from "../test/fixtures/rounds";
import { type SessionSeed, sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";
import { TopBar } from "./top-bar";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, sidebarOpen: true } }));
});

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

const SESSIONS: readonly SessionSeed[] = [
  { id: "s1", projectId: "p1", title: "Alpha", target: "your-branch" },
  { id: "s2", projectId: "p1", title: "Beta", target: "your-pr", targetState: "needs-you" },
];

function mountTopBar(path: string, rounds?: RoundsSource) {
  const history = memoryHistory(path);
  const bridge = new MemoryBridge({
    ...frontDoorHandlers([project("p1", "atlas")]),
    ...sessionHandlers(SESSIONS),
  });
  const inner = <TopBar />;
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

// ─────────────────────────────────────────────────────────────────────────────
// The app's ONE chat open/close control (C20 §4). It lives on the rightmost pane's
// top-left, is present in both directions, and replaces today's split pair (the bar's
// "Expand chat" plus the chat header's "Collapse chat"). Driven through the real
// frame, because the proof is that the dock actually opens and shuts.
// ─────────────────────────────────────────────────────────────────────────────

function mountFrame(sidebarOpen: boolean) {
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(sidebarOpen);
    useRennetStore.getState().uiActions.setChatOpen(true);
  });
  return mount(
    <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/s/review-1")} />,
  );
}

describe("the one chat toggle (C20 §4)", () => {
  for (const [name, sidebarOpen] of [
    ["state 1 (sidebar open)", true],
    ["state 2 (sidebar collapsed)", false],
  ] as const) {
    it(`round-trips the dock from the main view in ${name}`, async () => {
      const { getByLabelText, getByTestId } = mountFrame(sidebarOpen);
      const dock = getByTestId("chat-dock-slot");
      await waitFor(() => expect(dock.getAttribute("data-open")).toBe("true"));

      // Open → closed.
      const close = getByLabelText("Close chat");
      expect(close.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(close);
      await waitFor(() => expect(dock.getAttribute("data-open")).toBe("false"));

      // ...and the SAME control, now labelled the other way, opens it again.
      const open = getByLabelText("Open chat");
      expect(open.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(open);
      await waitFor(() => expect(dock.getAttribute("data-open")).toBe("true"));
      cleanup();
    });
  }

  it("leaves no collapse-chat control anywhere in the mounted tree", async () => {
    const { getByTestId, queryByLabelText } = mountFrame(false);
    await waitFor(() =>
      expect(getByTestId("chat-dock-slot").getAttribute("data-open")).toBe("true"),
    );
    expect(queryByLabelText("Collapse chat")).toBeNull();
    expect(queryByLabelText("Expand chat")).toBeNull();
    // Exactly one chat toggle exists, not a pair.
    expect(document.querySelectorAll('[aria-label="Close chat"]').length).toBe(1);
  });
});
