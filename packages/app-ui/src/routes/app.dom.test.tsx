// @vitest-environment happy-dom

import type { AskReviewResult, CommandInput } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
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
  it("boots over a MemoryBridge + memory history to the front door (4.8 runtime proof)", async () => {
    const history = memoryHistory("/"); // "/" redirects to /new-chat
    const { findByText, getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    // The front door renders its real content, read through the seam.
    expect(await findByText("Start a review.")).toBeTruthy();
    // The persistent chat-dock slot is mounted from the layout, not a route.
    expect(getByTestId("chat-dock-slot")).toBeTruthy();
  });

  it("chat-dock DOM node survives a settings route round-trip (risk 4)", async () => {
    const history = memoryHistory("/new-chat");
    const { getByTestId, findByText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await findByText("Start a review.");
    const dockBefore = getByTestId("chat-dock-slot");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(document.querySelector('[data-screen="settings"]')).toBeTruthy());

    act(() => history.navigate("/new-chat"));
    await findByText("Start a review.");

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

describe("the chat dock resolves its review from the route (F1 cluster 4)", () => {
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
