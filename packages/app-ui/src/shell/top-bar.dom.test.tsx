// @vitest-environment happy-dom
//
// The 56px session top-bar (C03 §4). The History · Map · Diff pill derives its
// selection from `?view` and toggles with `viewToggle` (replace — no back-stack
// entry); the back arrow shows exactly off-board; the trail renders title +
// `project › target` + needs-you WORDS from the projection.
import type { LensBoard, LensKind, Project, Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { findingAskId, findingRef } from "../board/finding-lifecycle";
import { BridgeProvider } from "../data";
import type { RoundsSource } from "../rounds/rounds-data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { FIXTURE_BOARDS } from "../test/fixtures/boards";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { fixtureCompletedRoundsSource } from "../test/fixtures/rounds";
import { type SessionSeed, sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { TopBar } from "./top-bar";

afterEach(() => {
  cleanup();
  useRennetStore.getState().reviewActions.resetReview();
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

function mountTopBar(path: string, rounds?: RoundsSource, handlers: MemoryBridgeHandlers = {}) {
  const history = memoryHistory(path);
  const bridge = new MemoryBridge({
    ...frontDoorHandlers([project("p1", "atlas")]),
    ...sessionHandlers(SESSIONS),
    ...handlers,
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

const REVIEW = {
  id: "rv-1",
  repositoryRoot: "/repos/atlas",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local-branch", files: [] }],
} as unknown as Review;

const LIVE_GENERATION = "gen:ps-1";
const BOARDS_AT_LIVE: Partial<Record<LensKind, LensBoard>> = Object.fromEntries(
  Object.entries(FIXTURE_BOARDS.gen1 ?? {}).map(([lens, board]) => [
    lens,
    { ...board, generation: LIVE_GENERATION },
  ]),
);

const lensHandlers: MemoryBridgeHandlers = {
  "session.list": () => ({
    sessions: [
      {
        id: "s2",
        projectId: "p1",
        title: "Beta",
        target: "your-pr" as const,
        targetState: "needs-you" as const,
        reviewId: REVIEW.id,
        createdAt: 0,
      },
    ],
  }),
  "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
  "board.read": ({ generation, lens }) => ({
    board: generation === LIVE_GENERATION ? (BOARDS_AT_LIVE[lens as LensKind] ?? null) : null,
  }),
};

describe("session top-bar (C03 §4)", () => {
  it("owns the ordered lens rail through the URL and leaves it unselected off-board", async () => {
    const { container, history, findByLabelText, getByText } = mountTopBar(
      "/s/s2",
      undefined,
      lensHandlers,
    );

    const flagged = await findByLabelText("Flagged, 2 open");
    const rail = container.querySelector('[data-slot="lens-switcher"] [role="tablist"]');
    expect(
      [...(rail?.querySelectorAll("[data-lens]") ?? [])].map((tab) =>
        tab.getAttribute("data-lens"),
      ),
    ).toEqual(["design", "sequence", "decisions", "flagged", "noise"]);
    for (const [lens, label] of [
      ["design", "Design"],
      ["sequence", "Sequence"],
      ["decisions", "Decisions"],
      ["flagged", "Flagged"],
      ["noise", "Noise"],
    ] as const) {
      const tab = rail?.querySelector<HTMLElement>(`[data-lens=${lens}]`);
      const visibleLabel = [...(tab?.querySelectorAll("span") ?? [])].find(
        (span) => span.textContent === label,
      );
      expect(tab?.getAttribute("title")).toBe(label);
      expect(tab?.querySelector("svg")).toBeTruthy();
      expect(visibleLabel?.className).toContain("hidden");
      expect(visibleLabel?.className).toContain("@[46rem]:inline");
    }
    expect(flagged.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(await findByLabelText("Design"));
    expect(history.history.at(-1)).toBe("/s/s2?lens=design");

    fireEvent.click(getByText("Diff"));
    expect(history.history.at(-1)).toBe("/s/s2?view=diff&lens=design");
    expect(
      [...(rail?.querySelectorAll('[role="tab"]') ?? [])].every(
        (tab) => tab.getAttribute("aria-selected") === "false",
      ),
    ).toBe(true);

    fireEvent.click(await findByLabelText("Sequence"));
    expect(history.history.at(-1)).toBe("/s/s2?lens=sequence");
  });

  it("derives the Flagged count from dismiss and request state, ahead of its delta pip", async () => {
    const flagged = BOARDS_AT_LIVE.flagged;
    if (!flagged) throw new Error("missing flagged fixture");
    const flaggedWithDelta: LensBoard = {
      ...flagged,
      sections: flagged.sections.map((section, index) =>
        index === 0 ? { ...section, delta: "new" } : section,
      ),
    };
    const handlers: MemoryBridgeHandlers = {
      ...lensHandlers,
      "board.read": ({ generation, lens }) => ({
        board:
          generation !== LIVE_GENERATION
            ? null
            : lens === "flagged"
              ? flaggedWithDelta
              : (BOARDS_AT_LIVE[lens as LensKind] ?? null),
      }),
    };
    const { container, findByLabelText } = mountTopBar("/s/s2", undefined, handlers);
    const firstRef = findingRef(LIVE_GENERATION, flagged.boardId, "f1");
    const secondRef = findingRef(LIVE_GENERATION, flagged.boardId, "f2");

    const twoOpen = await findByLabelText("Flagged, 2 open");
    const openBadge = twoOpen.querySelector<HTMLElement>("[data-testid=lens-open-count]");
    expect(openBadge?.textContent).toBe("2");
    expect(openBadge?.className).toContain("bg-destructive");
    expect(openBadge?.className).toContain("text-destructive-foreground");
    expect(openBadge?.className).not.toContain("text-white");
    expect(twoOpen.querySelector("[data-testid=lens-delta-pip]")).toBeNull();

    act(() => useRennetStore.getState().reviewActions.dismissFinding(firstRef));
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Flagged, 1 open"]')).toBeTruthy(),
    );

    act(() => useRennetStore.getState().reviewActions.restoreFinding(firstRef));
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Flagged, 2 open"]')).toBeTruthy(),
    );

    const askId = findingAskId(firstRef);
    act(() =>
      useRennetStore.getState().reviewActions.stageAsk({
        id: askId,
        anchor: "packages/adapters/src/github-auth.ts:244",
        type: "request-change",
        body: "Write a terminal record on every exit.",
        finding: firstRef,
      }),
    );
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Flagged, 1 open"]')).toBeTruthy(),
    );

    act(() => useRennetStore.getState().reviewActions.dismissFinding(secondRef));
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Flagged, 0 open, changed this round"]'),
      ).toBeTruthy(),
    );
    const zeroOpen = container.querySelector('[data-lens="flagged"]');
    expect(zeroOpen?.querySelector("[data-testid=lens-open-count]")).toBeNull();
    expect(zeroOpen?.querySelector("[data-testid=lens-delta-pip]")).toBeTruthy();

    act(() => useRennetStore.getState().reviewActions.restoreFinding(secondRef));
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Flagged, 1 open"]')).toBeTruthy(),
    );

    act(() => useRennetStore.getState().reviewActions.unstageAsk(askId));
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Flagged, 2 open"]')).toBeTruthy(),
    );
  });

  it("keeps a requested live lens while other lenses are still drafting", async () => {
    const progressiveHandlers: MemoryBridgeHandlers = {
      ...lensHandlers,
      "board.read": ({ generation, lens }) => ({
        board:
          generation === LIVE_GENERATION && lens === "design"
            ? (BOARDS_AT_LIVE.design ?? null)
            : null,
      }),
    };
    const { findByLabelText, history } = mountTopBar("/s/s2", undefined, progressiveHandlers);

    const design = await findByLabelText("Design");
    await waitFor(() => {
      expect(design.getAttribute("aria-selected")).toBe("true");
      expect(history.history.at(-1)).toBe("/s/s2");
    });
  });

  it("canonicalizes only after a frozen generation proves the lens absent", async () => {
    const frozenHandlers: MemoryBridgeHandlers = {
      ...lensHandlers,
      "board.read": ({ generation, lens }) => ({
        board:
          generation === "gen0" && lens === "design" && BOARDS_AT_LIVE.design
            ? { ...BOARDS_AT_LIVE.design, generation }
            : null,
      }),
    };
    const { findByLabelText, history } = mountTopBar(
      "/s/s2?generation=gen0",
      undefined,
      frozenHandlers,
    );

    const design = await findByLabelText("Design");
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/s2?lens=design&generation=gen0"));
    expect(design.getAttribute("aria-selected")).toBe("true");
  });

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

  it("drops its own trail once the dock is open (only TopBar is mounted here)", async () => {
    // The dock's own header renders the same trail; two of them is the same session
    // named twice. `TopBar` is session-routes-only, so `chatOpen` IS the dock's state.
    // This half only proves the BAR lets go — the other half of the hand-off needs the
    // frame, and is asserted in "the trail transfers…" below.
    const { container, findByText } = mountTopBar("/s/s2");
    await findByText("Beta");
    await waitFor(() => expect(container.textContent ?? "").toContain("atlas"));
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    await waitFor(() => expect(container.querySelector('[data-slot="trail"]')).toBeNull());
    // The title went with it — the whole trail is gone, not just its second line.
    expect(container.textContent ?? "").not.toContain("Beta");
    // ...and the controls that share the slot stayed. This is the assertion that would
    // catch "gated the entire left slot" being mistaken for "gated the trail".
    expect(container.querySelector('[aria-label="Close chat"]')).not.toBeNull();
  });

  it("the trail transfers: in the whole frame exactly ONE renders, and it is the dock's", async () => {
    // Driven through the real frame, because the bar-only test above cannot see the chat
    // header at all — it asserts a disappearance and reads as a hand-off. The dock is
    // always MOUNTED (R47), so counting its trail proves nothing on its own; what the
    // hand-off means is that the open dock leaves exactly one trail in the document, and
    // ungating `TopBar`'s copy makes this two.
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([project("p1", "atlas")]),
      ...sessionHandlers(SESSIONS),
    });
    const { container, getByTestId } = mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/s/s2")} />,
    );
    await waitFor(() => expect(getByTestId("chat-dock-slot").hasAttribute("inert")).toBe(false));
    const trails = [...container.querySelectorAll('[data-slot="trail"]')];
    expect(trails).toHaveLength(1);
    expect(getByTestId("chat-dock-slot").contains(trails[0] as Node)).toBe(true);
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
