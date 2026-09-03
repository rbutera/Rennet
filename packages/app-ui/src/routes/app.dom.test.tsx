// @vitest-environment happy-dom

import type { Project, SettingsView } from "@rennet/protocol";
import { lazy, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, mount, screen, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";
import { RennetRouterApp, WelcomeChunkBoundary } from "./app";
import { memoryHistory } from "./history";

// The ui store is a module singleton, so a test that opens the chat dock would leak
// `chatOpen: true` into every later test in this file. Reset it to the app's real
// default before each one.
beforeEach(() => {
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false } }));
});

describe("RennetRouterApp", () => {
  const project = (id: string, name: string): Project => ({
    id,
    name,
    path: `/code/${name}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 0,
    primaryBranch: "main",
    openPath: `/code/${name}`,
    addedAt: "2026-08-28T00:00:00.000Z",
    source: "local",
  });

  const settings = (overrides: Partial<SettingsView> = {}): SettingsView => ({
    scheme: "system",
    schemeProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "system", effective: true }],
    },
    appearanceMalformed: false,
    projects: [],
    welcome: { completedAt: "2026-08-28T00:00:00.000Z" },
    ...overrides,
  });

  it("shows the full-window welcome only for a fresh zero-project client", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "settings.get": () => settings({ welcome: undefined }),
      "harness.hosts": () => ({ hosts: [] }),
      "forge.hosts": () => ({ hosts: [] }),
    });
    const history = memoryHistory("/"); // "/" redirects to /new-chat
    const { findByText, queryByTestId } = mount(
      <RennetRouterApp bridge={bridge} history={history} />,
    );
    expect(
      // Lazy welcome: the text arrives only after the dynamic chunk resolves, which under a
      // saturated parallel gate can exceed findBy*'s default 1s. Timeout, not behaviour.
      await findByText(
        "You stopped writing the code. You still have to answer for it.",
        undefined,
        { timeout: 15_000 },
      ),
    ).toBeTruthy();
    // The shell is NOT mounted beneath the welcome (D7). A hidden-but-mounted underlay
    // still registered coach anchors and still let the coachmark — which portals to
    // `document.body`, outside the underlay — paint over the wizard.
    expect(queryByTestId("chat-dock-slot")).toBeNull();
  });

  it("reopens the welcome after a replay request even though the client has projects", async () => {
    // The load-bearing half of `settings.resetWelcome`. First-run ELIGIBILITY elects the
    // wizard only for a zero-project client, so on any machine that has a project the
    // reset is a no-op unless the replay stamp bypasses eligibility outright. This client
    // has a project AND had completed the welcome, which is every real install.
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([project("p1", "alpha")]),
      "settings.get": () =>
        settings({ welcome: { replayRequestedAt: "2026-08-29T09:30:00.000Z" } }),
      "harness.hosts": () => ({ hosts: [] }),
      "forge.hosts": () => ({ hosts: [] }),
    });
    const { findByText, queryByTestId } = mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/")} />,
    );
    expect(
      // Lazy welcome: the text arrives only after the dynamic chunk resolves, which under a
      // saturated parallel gate can exceed findBy*'s default 1s. Timeout, not behaviour.
      await findByText(
        "You stopped writing the code. You still have to answer for it.",
        undefined,
        { timeout: 15_000 },
      ),
    ).toBeTruthy();
    // Same D7 rule as the fresh path: the shell does not mount beneath the wizard.
    expect(queryByTestId("chat-dock-slot")).toBeNull();
  });

  it("shows the focused Add Project entry after a completed welcome has no projects", async () => {
    const { findByText, getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/")} />,
    );
    expect(await findByText("Add a project to begin.")).toBeTruthy();
    expect(getByTestId("chat-dock-slot")).toBeTruthy();
  });

  it("opens bare New Chat on the remembered valid project", async () => {
    const alpha = project("p1", "alpha");
    const beta = project("p2", "beta");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p2" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([alpha, beta]),
      "settings.get": () => settings({ navigation: { lastProjectBySource: { local: "p2" } } }),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("no open branches or change requests yet")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p2"));
    expect(remember).toHaveBeenCalledWith({ source: "local", projectId: "p2" });
  });

  it("recovers a stale remembered project to the first surviving project", async () => {
    const alpha = project("p1", "alpha");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p1" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([alpha]),
      "settings.get": () => settings({ navigation: { lastProjectBySource: { local: "removed" } } }),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("no open branches or change requests yet")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p1"));
  });

  it("resolves a project query by unique display name and canonicalizes it to the stable id", async () => {
    const alpha = project("p1", "alpha");
    const beta = project("p2", "beta");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p2" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([alpha, beta]),
      "settings.get": () => settings(),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat?project=beta");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);

    expect(await findByText("no open branches or change requests yet")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p2"));
    expect(remember).toHaveBeenCalledWith({ source: "local", projectId: "p2" });
  });

  it("gives an exact id precedence over another project's matching display name", async () => {
    const exactId = project("p1", "alpha");
    const matchingName = project("p2", "p1");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p1" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([exactId, matchingName]),
      "settings.get": () => settings(),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat?project=p1");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);

    expect(await findByText("no open branches or change requests yet")).toBeTruthy();
    await waitFor(() => expect(remember).toHaveBeenCalledOnce());
    expect(remember).toHaveBeenCalledWith({ source: "local", projectId: "p1" });
    expect(history.history.at(-1)).toBe("/new-chat?project=p1");
  });

  it("treats duplicate display names as ambiguous and keeps the remembered fallback", async () => {
    const first = project("p1", "shared");
    const remembered = project("p2", "shared");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p2" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([first, remembered]),
      "settings.get": () => settings({ navigation: { lastProjectBySource: { local: "p2" } } }),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat?project=shared");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);

    expect(await findByText("no open branches or change requests yet")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p2"));
    expect(remember).toHaveBeenCalledWith({ source: "local", projectId: "p2" });
  });

  it("chat-dock DOM node survives a settings route round-trip (risk 4)", async () => {
    const history = memoryHistory("/new-chat");
    const { getByTestId, findByText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await findByText("Add a project to begin.");
    const dockBefore = getByTestId("chat-dock-slot");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(document.querySelector('[data-screen="settings"]')).toBeTruthy());

    act(() => history.navigate("/new-chat"));
    await findByText("Add a project to begin.");

    const dockAfter = getByTestId("chat-dock-slot");
    // The SAME DOM node — navigation swapped only the outlet, never the dock slot.
    expect(dockAfter).toBe(dockBefore);
  });

  it("a genuinely missing review renders not-found (the daemon's typed signal)", async () => {
    // The daemon's contract for an unknown reviewId is a `Review not found` rejection
    // (server dispatch.ts). ONLY that maps to not-found — modelled here honestly.
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "review.load": () => {
        throw new Error("Review not found");
      },
    });
    const history = memoryHistory("/s/does-not-exist");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("Not found")).toBeTruthy();
  });

  it("a load FAILURE (disconnect / IPC fault) renders an honest error, not a false not-found", async () => {
    // Any rejection that is NOT the missing-review signal is a real error — it must not
    // masquerade as "Nothing here" (finding 5: every failure rendering not-found is a lie).
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "review.load": () => {
        throw new Error("daemon connection lost");
      },
    });
    const history = memoryHistory("/s/review-1");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText(/Couldn.t open this review/)).toBeTruthy();
    expect(await findByText(/daemon connection lost/)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The chat-only session (F1 cluster 4 + C21). `session.mint` creates a session and
// claims its target, but NOTHING attaches a review — so the front door lands on a
// session that has no diff. Before this, `/s/:slug` asked `review.load(slug)`, got the
// daemon's "Review not found", and rendered NotFound: a click that genuinely worked
// looked broken. These prove the three arms stay distinct — a real session, a genuinely
// unknown slug, and a real fault are three different surfaces, not one.
// ─────────────────────────────────────────────────────────────────────────────

/** A bridge where `review.load` always answers the daemon's missing-review signal (no
 *  review is ever attached to a minted session today) and `session.list` is served. */
function mintedSessionBridge(extra: Record<string, unknown> = {}): MemoryBridge {
  return new MemoryBridge({
    ...frontDoorHandlers(),
    ...sessionHandlers([{ id: "sess-1", projectId: "proj-1", title: "Refactor the parser" }]),
    "review.load": () => {
      throw new Error("Review not found");
    },
    ...extra,
  } as never);
}

describe("/s/:slug for a review-less session (F1 cluster 4, C21 mint)", () => {
  it("renders the session honestly — not a not-found, not an error, not a spinner", async () => {
    const history = memoryHistory("/s/sess-1");
    const { findByText } = mount(
      <RennetRouterApp bridge={mintedSessionBridge()} history={history} />,
    );
    // The session is REAL and says so, by its own title.
    expect(await findByText("Refactor the parser")).toBeTruthy();
    // It states the actual situation: no review, so no diff — and does NOT promise one
    // is coming (no spinner, no "preparing", no skeleton board).
    expect(await findByText(/Nothing has been captured to review yet/)).toBeTruthy();
    expect(document.querySelector('[data-screen="chat-only-session"]')).toBeTruthy();
    // The three arms it must NOT be.
    expect(document.querySelector('[data-screen="not-found"]')).toBeNull();
    expect(document.querySelector('[data-screen="load-error"]')).toBeNull();
    expect(screen.queryByText("Opening…")).toBeNull();
    // And the chat dock is mounted alongside it — this is a session WITH chat.
    expect(document.querySelector('[data-testid="chat-dock-slot"]')).toBeTruthy();
  });

  it("a slug that is neither a review nor a session is still an honest not-found", async () => {
    // POSITIVE CONTROL for the arm above: the chat-only surface must not swallow a
    // genuinely unknown slug. Same bridge, a slug no session owns.
    const history = memoryHistory("/s/nobody");
    const { findByText } = mount(
      <RennetRouterApp bridge={mintedSessionBridge()} history={history} />,
    );
    expect(await findByText("Not found")).toBeTruthy();
    expect(document.querySelector('[data-screen="chat-only-session"]')).toBeNull();
  });

  // GONE with Rennet's own composer (t3-lens-threads 4.2). New Chat's `?ask=` seeded the
  // dock's textarea; the dock now hosts T3's composer, which this change does not reach into.
  // The query parameter is still minted and still parsed — nothing renders it. That is a real
  // loss of the typed question, written down here rather than quietly dropped: seeding the T3
  // composer is its own change, not part of this deletion.
});

describe("/s/:slug during New Chat preparation (#668)", () => {
  const lanes = [
    { id: "design", label: "Design", status: "done", verdict: "reworked" },
    { id: "sequence", label: "Sequence", status: "running" },
    { id: "decisions", label: "Decisions", status: "queued" },
    { id: "flagged", label: "Flagged", status: "queued" },
    { id: "noise", label: "Noise", status: "queued" },
  ] as const;

  it("renders the daemon's real lens snapshot and cancels without leaving the session", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([
        {
          id: "sess-progress",
          projectId: "proj-1",
          title: "feat/progress",
          reviewId: "rev-1",
          preparation: { status: "drafting", reviewId: "rev-1", lanes: [...lanes] },
        },
      ]),
      "review.load": () => ({ review: REVIEW }),
    } as never);
    const history = memoryHistory("/s/sess-progress");
    const { user, findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);

    expect(await findByText("Generating the Boards")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-screen="session-preparation"] [data-row]'),
    ).toHaveLength(5);
    expect(document.querySelector('[data-row="design"]')?.getAttribute("data-status")).toBe("done");
    expect(document.querySelector('[data-row="sequence"]')?.getAttribute("data-status")).toBe(
      "running",
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-screen="session-preparation"]')?.getAttribute("data-status"),
      ).toBe("cancelled"),
    );
    expect(history.history.at(-1)).toBe("/s/sess-progress");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says cross-lens coverage is pending on the initial generation's reveal too", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([
        {
          id: "sess-coverage",
          projectId: "proj-1",
          title: "feat/coverage",
          reviewId: "rev-1",
          preparation: {
            status: "drafting",
            reviewId: "rev-1",
            lanes: [...lanes],
            coverage: { state: "pending" },
          },
        },
      ]),
      "review.load": () => ({ review: REVIEW }),
    } as never);
    const history = memoryHistory("/s/sess-coverage");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);

    expect(await findByText("Generating the Boards")).toBeTruthy();
    // The settled Design lane is on screen while coverage is still pending — coverage is a
    // state the surface reports, never a reason to withhold a board (#725 D4).
    expect(document.querySelector('[data-row="design"]')?.getAttribute("data-status")).toBe("done");
    const coverage = document.querySelector('[data-testid="cross-lens-coverage"]');
    expect(coverage?.getAttribute("data-coverage")).toBe("pending");
    expect(coverage?.textContent).toContain("still running");
  });

  it("names the failed stage and reason while retaining retry", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([
        {
          id: "sess-failed",
          projectId: "proj-1",
          title: "feat/failed",
          preparation: {
            status: "failed",
            stage: "capture",
            reason: "Branch feat/failed no longer exists.",
          },
        },
      ]),
      "review.load": () => {
        throw new Error("Review not found");
      },
    } as never);

    mount(<RennetRouterApp bridge={bridge} history={memoryHistory("/s/sess-failed")} />);
    expect(await screen.findByText("Capture failed")).toBeTruthy();
    expect(await screen.findByText("Branch feat/failed no longer exists.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

/** A review the daemon can serve for `/s/rev-1`, minimal but schema-real. */
const REVIEW = {
  id: "rev-1",
  repositoryRoot: "/repo",
  patchsets: [
    {
      id: "ps-1",
      createdAt: "2026-08-28T00:00:00.000Z",
      repository: {
        id: "repo",
        root: "/repo",
        commonDir: "/repo/.git",
        baseRef: "main",
        baseOid: "b0",
        headOid: "h0",
      },
      files: [],
      rawDiff: "X",
      byteLength: 1,
      truncated: false,
    },
  ],
  activePatchsetId: "ps-1",
  dispositions: [],
  status: "current",
};

describe("the lazy welcome chunk", () => {
  it("renders the same calm blank when its chunk fails to load, instead of blanking the app", async () => {
    // `Suspense` catches the WAIT, not the rejection: without a boundary this rejection
    // throws through `fallback={null}` and unmounts everything — the first screen an
    // install ever renders becomes an empty window.
    const errors: unknown[][] = [];
    const console_ = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
    const Broken = lazy(() => Promise.reject(new Error("chunk 404")));
    try {
      const view = mount(
        <div data-testid="app-shell">
          <WelcomeChunkBoundary>
            <Suspense fallback={null}>
              <Broken />
            </Suspense>
          </WelcomeChunkBoundary>
        </div>,
      );
      // CONTROL: drop `<WelcomeChunkBoundary>` from `FirstRunWelcome` and the equivalent
      // here, and this `waitFor` never settles — the rejection escapes and the surrounding
      // tree comes down with it.
      await waitFor(() => expect(errors.length).toBeGreaterThan(0));
      // The app around the wizard survived, and the wizard's slot is simply empty — the
      // same nothing the fallback and the pre-claimed state render. No dialog, no retry.
      expect(view.getByTestId("app-shell").textContent).toBe("");
      expect(errors.some((args) => String(args[0]).includes("welcome chunk failed"))).toBe(true);
    } finally {
      console_.mockRestore();
    }
  });
});
