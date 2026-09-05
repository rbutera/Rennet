// @vitest-environment happy-dom
import type { Review, SettingsProject } from "@rennet/protocol";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { T3ChatSlotProvider, type T3NativeChatProps, type T3ThreadViewProps } from "./t3-chat-slot";

// The chat slot (t3-lens-threads 4.1 and 4.4): there is no engine choice and no rung-one
// <webview> left — every session's slot is the host-mounted native T3 thread view. The
// project row below carries NO engine pref, which is exactly the fixture that used to
// yield Rennet's own dock, so mounting T3 anyway is the converted proof that the switch
// is gone rather than a default flipped the other way.
//
// And which THREAD it shows (#823, lens-board-tools 6.3): the SESSION'S, in every state
// of every lane, and there is no longer any way to make it show another. The dock used to
// carry a lens-thread arm driven by `ui.lensThread`; that field, its action, the arm and
// its "← Back to the session" button are deleted, and a seat's transcript opens in the
// board region's own drawer instead.

afterEach(() => {
  cleanup();
  act(() => useRennetStore.getState().uiActions.openSeatTranscript(null));
});

const layered = (value: string) => ({ value, layer: "builtin" as const });

function projectRow(): SettingsProject {
  return {
    projectId: "p1",
    name: "checkout",
    repoPath: "/repos/acme/checkout",
    visibility: "local",
    visibilityProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "local", effective: true }],
    },
    promoted: false,
    promotedProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "not promoted", effective: true }],
    },
    locus: { kind: "host" },
    locusProvenance: {
      layer: "detected",
      contributions: [{ layer: "detected", value: "host", effective: true }],
    },
    configMalformed: false,
    prefs: {
      glyph: layered(""),
      worktreeRoot: layered(""),
      worktreePattern: layered(""),
      tracker: {
        kind: layered("none"),
        projectKey: layered(""),
        baseUrl: layered(""),
        tokenEnv: layered(""),
      },
      guidance: [],
    },
  };
}

function mountDock(slot?: {
  readonly session: ComponentType<T3NativeChatProps>;
  readonly thread: ComponentType<T3ThreadViewProps>;
}) {
  const asks: unknown[] = [];
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": () => ({ ...emptySettings(), projects: [projectRow()] }),
    // The slug resolves to a review only when the review loads; the minimal shape the
    // workspace tests use is enough for the dock to learn its review id. TWO reviews,
    // because the store slice that names the open lens transcript is global and the bug
    // it hid was only visible across a navigation (review finding 4).
    "review.load": (input) => ({
      review: {
        id: (input as { reviewId?: string }).reviewId ?? "review-1",
        repositoryRoot: "/repos/acme/checkout",
        status: "current",
        activePatchsetId: "ps-1",
        patchsets: [{ id: "ps-1", source: "local" }],
      } as unknown as Review,
      repositoryPresent: true,
    }),
    "session.list": () => ({
      sessions: [
        { id: "review-1", projectId: "p1", title: "main", target: "your-branch", createdAt: 1 },
        { id: "review-2", projectId: "p1", title: "feat/x", target: "your-branch", createdAt: 2 },
      ],
    }),
    "chat.t3Session": (input) => {
      asks.push(input);
      const reviewId = (input as { reviewId?: string }).reviewId ?? "review-1";
      return {
        origin: "http://127.0.0.1:43117",
        wsUrl: "ws://127.0.0.1:43117/ws",
        accessToken: "bearer-never-in-the-guest",
        environmentId: "env-1",
        thread: {
          status: "bound",
          threadId: reviewId === "review-2" ? "thread-2" : "thread-1",
          threadUrl: "http://127.0.0.1:43117/env-1/thread-1",
        },
      };
    },
  });
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(false);
    useRennetStore.getState().uiActions.setChatOpen(true);
  });
  // `?lens=sequence` so the seat transcript the control below opens is the SELECTED lens's.
  // Selecting a lens moves board, widget and transcript together (6.2), so a ref pointed at
  // a lens the route is not on is legitimately re-pointed or closed — which would make the
  // control's own premise disappear rather than test the dock.
  const history = memoryHistory("/s/review-1?lens=sequence");
  const app = <RennetRouterApp bridge={bridge} history={history} />;
  const view = mount(
    slot ? (
      <T3ChatSlotProvider session={slot.session} thread={slot.thread}>
        {app}
      </T3ChatSlotProvider>
    ) : (
      app
    ),
  );
  return { ...view, asks, history };
}

/**
 * A CHAT-ONLY SESSION — the New Chat route as the daemon actually publishes it (#872).
 *
 * The fixture is written from the daemon's side, not the dock's: `session.list` carries a
 * real session with NO `reviewId`, and `review.load` throws the daemon's own literal
 * "Review not found" for it (the sentence `routes/slug.ts` matches on). That is the shape
 * `/s/<slug>` has for a New Chat mint before its capture attaches and for a session that
 * never gets one, and it is a SESSION route — so the dock is open, not hidden.
 *
 * A fixture that simply omitted the review would have resolved to `not-found` and passed
 * this test while the real route (a session that exists and holds no review) still showed
 * the sidecar-starting line.
 */
function mountChatOnly() {
  const asks: unknown[] = [];
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": () => ({ ...emptySettings(), projects: [projectRow()] }),
    "session.list": () => ({
      sessions: [
        {
          id: "chat-only",
          projectId: "p1",
          title: "New review",
          target: "your-branch",
          createdAt: 1,
        },
      ],
    }),
    "review.load": () => {
      throw new Error("Review not found");
    },
    "chat.t3Session": (input) => {
      asks.push(input);
      return {
        origin: "http://127.0.0.1:43117",
        wsUrl: "ws://127.0.0.1:43117/ws",
        accessToken: "bearer-never-in-the-guest",
        environmentId: "env-1",
      };
    },
  });
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(false);
    useRennetStore.getState().uiActions.setChatOpen(true);
  });
  const history = memoryHistory("/s/chat-only");
  const view = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return { ...view, asks };
}

/** Both rung-two components provided, each recording its props. */
function mountWithSlot() {
  const seen: T3NativeChatProps["session"][] = [];
  const opened: T3ThreadViewProps[] = [];
  const Session = ({ session }: T3NativeChatProps) => {
    seen.push(session);
    return (
      <div data-slot="t3-native-stub">
        {session.thread?.status === "bound" ? session.thread.threadId : ""}
      </div>
    );
  };
  const Thread = (props: T3ThreadViewProps) => {
    opened.push(props);
    return <div data-slot="t3-thread-stub">{props.thread.threadId}</div>;
  };
  return { ...mountDock({ session: Session, thread: Thread }), seen, opened };
}

describe("the chat slot is always the T3 thread", () => {
  // The rung-one <webview> is deleted (t3-lens-threads 4.4). This is the case that used to
  // render it: the daemon answers, no host provides the native components, and the slot has
  // to show SOMETHING. LOAD-BEARING on the guest never returning — restoring the <webview>
  // branch reddens both the honest-message assertion and the `t3-chat-view` miss. It is NOT
  // load-bearing on the pairing token: `pairingUrl` is off the wire schema entirely, so the
  // fixture below cannot even offer one.
  it("shows an honest line, and no <webview>, when the host mounts nothing", async () => {
    const { getByTestId, asks } = mountDock();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-chat-unmounted"]')).not.toBeNull(),
    );
    expect(dock.querySelector('[data-slot="t3-chat-unmounted"]')?.textContent).toContain(
      "does not mount the chat view",
    );
    expect(dock.querySelector('[data-slot="t3-chat-view"]')).toBeNull();
    expect(dock.querySelector("webview")).toBeNull();
    // The ask carried the review, so the daemon bound this review's thread.
    expect(asks).toEqual([{ reviewId: "review-1" }]);
    // The bearer never reaches the DOM.
    expect(dock.innerHTML).not.toContain("bearer-never-in-the-guest");
  });

  it("mounts the host-provided native view with the session, and no <webview>", async () => {
    const { getByTestId, seen } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());
    expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1");
    expect(dock.querySelector('[data-slot="t3-chat-view"]')).toBeNull();
    expect(seen.at(-1)?.environmentId).toBe("env-1");
    // With nothing open, the read-only thread view is absent — so the control below,
    // which asserts it is STILL absent with a seat transcript open, cannot pass merely
    // because this stub is never mounted anywhere.
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
  });

  // ── #823, the control (6.3): there is no way to point the slot at a seat ──────
  //
  // "we take over the orchestrator's chat with the lens agent's chat thread.. thats a big
  // nono" (Rai, 2026-09-04). The test the task asks for is one that TRIES and finds no way
  // to, so it does two things a single assertion could not:
  //
  //   1. It enumerates the store's whole UI action surface and finds nothing that names a
  //      thread the dock could be retargeted at. That is the half that catches a rename —
  //      an `openLensThread` restored under any other name would have to appear here.
  //   2. It then does the closest thing the surviving API allows — opens a SEAT transcript,
  //      the successor field, pointing at a seat's thread on this very review — and finds
  //      the dock still on the session's own thread with its composer.
  //
  // Deleting the arm is what makes 2 pass; without 1, a future arm reading a differently
  // named field would pass 2 as well, since 2 only writes `seatTranscript`.
  it("offers no way to point the chat slot at a seat's thread", async () => {
    const { getByTestId, opened } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());

    // 1. Nothing in the action surface names a thread for the chat slot. HARD-CODED count:
    //    deriving it from the object under test would be satisfied by an empty surface.
    const actions = Object.keys(useRennetStore.getState().uiActions);
    expect(actions).toHaveLength(15);
    expect(actions.filter((name) => /thread/i.test(name))).toEqual([]);
    expect(Object.keys(useRennetStore.getState().ui)).not.toContain("lensThread");

    // 2. The successor field, aimed at a seat on this review — the exact ref the deleted
    //    arm consumed. The dock does not move.
    act(() =>
      useRennetStore.getState().uiActions.openSeatTranscript({
        reviewId: "review-1",
        lens: "sequence",
        seat: "sequence",
        thread: { environmentId: "env-1", threadId: "seat-sequence" },
      }),
    );
    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1"),
    );
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
    expect(dock.querySelector('[data-slot="t3-thread-back"]')).toBeNull();
    // The transcript DID open — in the board region's own drawer, which is the surface
    // that replaced the dock's arm. Asserting that too is what stops this passing over a
    // build where the transcript opens nowhere at all: "the dock did not take it" and
    // "nothing shows it" would otherwise be the same green bar.
    await waitFor(() =>
      expect(
        document.querySelector('[data-kind="seat-transcript-drawer"] [data-slot="t3-thread-stub"]'),
      ).not.toBeNull(),
    );
    expect(opened.at(-1)?.thread.threadId).toBe("seat-sequence");
    expect(opened.at(-1)?.readOnly).toBe(true);
    // …and the dock is STILL on the session's thread after the drawer arrived, so this is
    // not merely a race the assertion above won.
    expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1");
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
  });

  // The dock survives a navigation with the session's own thread — the old arm's failure
  // mode (review finding 4) was a seat transcript from ANOTHER review rendering under this
  // session's header, and the two-review fixture is what makes that visible. There is no
  // arm to leak through now; this pins that the surviving path still follows the route.
  it("follows the route to the next session's own thread", async () => {
    const { getByTestId, history } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1"),
    );

    act(() => history.navigate("/s/review-2"));

    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-2"),
    );
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
  });

  // ── #872: the dock may only claim a bring-up it is actually waiting on ────────
  //
  // "Starting the T3 Code sidecar…" is the `pending || !data` arm of a read that is
  // DISABLED with no review, so `data` is undefined forever and the line never resolved.
  // It is not the copy that was wrong — it is that the arm was reachable at all from a
  // route where nothing is being started.
  it("never says the sidecar is starting on a session that holds no review", async () => {
    const { getByTestId, asks } = mountChatOnly();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-chat-no-review"]')).not.toBeNull(),
    );
    expect(dock.querySelector('[data-slot="t3-chat-no-review"]')?.textContent).toContain(
      "No review is attached to this session",
    );
    // The line the issue was filed about, gone from this route.
    expect(dock.querySelector('[data-slot="t3-chat-starting"]')).toBeNull();
    // And it is not merely unrendered: nothing was ASKED of the sidecar either, which is
    // the fact the copy was misreporting. A dock that still fired the read and hid the
    // line would pass the assertion above and keep lying about the same thing.
    expect(asks).toEqual([]);
    // The dock is on a session route, so it is open and this is really on screen.
    expect(dock.getAttribute("data-open")).toBe("true");
  });

  // The control for the pair above: the SAME assertions on a route that does hold a
  // review must find the opposite, or "no-review everywhere" would satisfy both.
  it("still reaches the sidecar on a session that holds one", async () => {
    const { getByTestId, asks } = mountDock();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() =>
      expect(dock.querySelector('[data-slot="t3-chat-unmounted"]')).not.toBeNull(),
    );
    expect(dock.querySelector('[data-slot="t3-chat-no-review"]')).toBeNull();
    expect(asks).toEqual([{ reviewId: "review-1" }]);
  });
});
