// @vitest-environment happy-dom

import type { AskReviewResult, CommandInput, Project, SettingsView } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, mount, screen, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";
import { RennetRouterApp } from "./app";
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
      await findByText("You stopped writing the code. You still have to answer for it."),
    ).toBeTruthy();
    // The shell is NOT mounted beneath the welcome (D7). A hidden-but-mounted underlay
    // still registered coach anchors and still let the coachmark — which portals to
    // `document.body`, outside the underlay — paint over the wizard.
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
    expect(await findByText("No open branches or pull requests yet.")).toBeTruthy();
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
    expect(await findByText("No open branches or pull requests yet.")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p1"));
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
    "review.reattach": () => ({ threads: [], inFlight: [] }),
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

  it("seeds the composer from the mint's ?ask= so the typed question is not eaten", async () => {
    // New Chat's composer cannot send (the session does not exist until the click mints
    // it), so the typed ask rides the URL. The reviewer must land looking at their words.
    const history = memoryHistory("/s/sess-1?ask=does%20b%20get%20used%3F");
    const { findByText } = mount(
      <RennetRouterApp bridge={mintedSessionBridge()} history={history} />,
    );
    await findByText("Refactor the parser");
    // The words are preserved and shown back, not silently dropped on the floor —
    // even though this session has no review to send them against yet.
    await waitFor(() => {
      const box = screen.getByLabelText("Message the orchestrator") as HTMLTextAreaElement;
      expect(box.value).toBe("does b get used?");
    });
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

/** One persisted orchestrator turn, as `review.reattach` returns it. */
const transcriptOf = (body: string) => ({
  threads: [
    {
      threadId: "t-1",
      anchor: { kind: "fragment" as const, label: "conversation", key: "t-1" },
      messages: [{ id: "m-1", author: "harness" as const, body }],
    },
  ],
  inFlight: [],
});

describe("a reopened session shows the daemon's transcript, not the one it left with", () => {
  it("re-reads review.reattach on reopen, so a turn that landed while away is not hidden", async () => {
    // Codex P1. The dock's reattach `commandId` is stable per review by design (two readers,
    // one fetch), so the cache key is the SAME one the reviewer left behind. Nothing evicted
    // or staled it, so `ensure` saw fresh data and skipped the server read: the transcript
    // silently omitted everything that arrived while the route was closed, and only a full
    // reload — which resets both the ids and the cache — brought it back.
    let body = "the answer you were reading";
    let reads = 0;
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([{ id: "rev-1", projectId: "proj-1" }]),
      "review.load": () => ({ review: REVIEW }),
      "review.reattach": () => {
        reads += 1;
        return transcriptOf(body);
      },
    } as never);
    const history = memoryHistory("/s/rev-1");
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await screen.findByText("the answer you were reading")).toBeTruthy();
    expect(reads).toBe(1);

    // Leave the session. The orchestrator finishes a turn on the daemon while it is closed.
    act(() => history.navigate("/settings/appearance"));
    body = "the turn that landed while you were away";

    // Come back. This is a REOPEN, not a reload — the renderer never restarted.
    act(() => history.navigate("/s/rev-1"));
    expect(await screen.findByText("the turn that landed while you were away")).toBeTruthy();
    expect(reads).toBe(2);
  });
});

describe("the chat dock resolves its review from the route (F1 cluster 4)", () => {
  it("does not double the reviewer's own message when the ask beats the first reattach", async () => {
    // Codex P1 (duplicate message). The optimistic echo is keyed `you-${turnId}` while the
    // daemon persists the same turn as `${turnId}::you` (server dispatch/review.ts). Those
    // are two ids for one message, so `appendMessage`'s id-guard cannot see they are the
    // same — and on the pre-settle path (ask sent while the initial reattach is still in
    // flight, then flushed onto the settled snapshot) the reviewer's message renders twice.
    let turnId = "";
    let threadId = "";
    let settle: (() => void) | undefined;
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([{ id: "rev-1", projectId: "proj-1" }]),
      "review.load": () => ({ review: REVIEW }),
      "review.reattach": () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({
              // The snapshot the daemon serves ALREADY carries the just-persisted turn.
              threads: [
                {
                  threadId,
                  anchor: { kind: "fragment" as const, label: "conversation", key: threadId },
                  messages: [{ id: `${turnId}::you`, author: "you" as const, body: "does b?" }],
                },
              ],
              inFlight: [],
            });
        }),
      "review.ask": (input: CommandInput<"review.ask">): AskReviewResult => {
        turnId = input.turnId ?? "";
        threadId = input.threadId ?? "";
        return { mode: "orchestrator", primary: { model: "opus", answer: "no impact" } };
      },
    } as never);
    const history = memoryHistory("/s/rev-1");
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { user } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    const box = await screen.findByLabelText("Message the orchestrator");
    await user.type(box, "does b?");
    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(turnId).not.toBe(""));

    // Now the reattach lands, and the buffered echo is flushed onto it.
    await act(async () => {
      settle?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByText("does b?").length).toBeGreaterThan(0));
    expect(screen.getAllByText("does b?")).toHaveLength(1);
  });

  it("sends review.ask for the route's review with NO SessionTranscriptProvider mounted", async () => {
    // THE FIX. `useChatDock` read its reviewId from a test-only context that the app
    // never mounted, so in the real product reviewId was undefined and `send()` returned
    // at its guard BEFORE the mutation fired — the message reached nothing at all. The
    // dock now resolves the review from the route itself. No provider is mounted here,
    // exactly as `layout.tsx` renders `<ChatDock />` bare.
    const asks: Array<CommandInput<"review.ask">> = [];
    const review = {
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
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      ...sessionHandlers([{ id: "rev-1", projectId: "proj-1" }]),
      "review.load": () => ({ review }),
      "review.reattach": () => ({ threads: [], inFlight: [] }),
      "review.ask": (input: CommandInput<"review.ask">): AskReviewResult => {
        asks.push(input);
        return { mode: "orchestrator", primary: { model: "opus", answer: "no impact" } };
      },
    } as never);
    const history = memoryHistory("/s/rev-1");
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { user } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    const box = await screen.findByLabelText("Message the orchestrator");
    await user.type(box, "any public routes affected?");
    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(asks.length).toBe(1));
    // Keyed on the ROUTE's review — the whole point of the resolution.
    expect(asks[0]?.reviewId).toBe("rev-1");
    expect(asks[0]?.question).toBe("any public routes affected?");
    // And still anchored, so the answer persists across a reload (F1 cluster 5).
    expect(asks[0]?.anchor?.kind).toBe("fragment");
  });

  it("on a review-less session the dock does NOT invoke review.ask against a phantom review", async () => {
    // POSITIVE CONTROL for the resolution: guessing `reviewId = slug` would point the
    // dock at a review that does not exist and turn silence into "Review not found".
    // A chat-only session must resolve to NO review at all.
    const loads: unknown[] = [];
    const asks: unknown[] = [];
    const bridge = mintedSessionBridge({
      "review.ask": (input: unknown) => {
        asks.push(input);
        return { mode: "orchestrator", primary: { model: "opus", answer: "x" } };
      },
      "review.reattach": (input: unknown) => {
        loads.push(input);
        return { threads: [], inFlight: [] };
      },
    });
    const history = memoryHistory("/s/sess-1");
    act(() => useRennetStore.getState().uiActions.setChatOpen(true));
    const { user } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    await screen.findByText("Refactor the parser");
    const box = screen.getByLabelText("Message the orchestrator");
    await user.type(box, "hello?");
    // The composer REFUSES the text rather than swallowing it: with no review there is
    // nothing to ask about, so an enabled box that accepted this and dropped it would be
    // the very lie this dock is being repaired for.
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
    // And it says WHY, rather than looking broken.
    expect(screen.getByText(/no change to ask about/)).toBeTruthy();
    await user.click(screen.getByLabelText("Send"));
    await act(async () => {
      await Promise.resolve();
    });
    // No review read and no ask were ever addressed to the session id.
    expect(asks).toEqual([]);
    expect(loads).toEqual([]);
  });
});
