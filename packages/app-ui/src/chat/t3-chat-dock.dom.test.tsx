// @vitest-environment happy-dom
import type { Review, SettingsProject } from "@rennet/protocol";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { T3ChatSlotProvider, type T3NativeChatProps, type T3ThreadViewProps } from "./t3-chat-slot";

// The chat slot (t3-lens-threads 4.1): there is no engine choice left — every session's
// slot is the T3 thread. The project row below carries NO engine pref, which is exactly
// the fixture that used to yield Rennet's own dock, so "it mounts T3 anyway" is the
// converted proof that the switch is gone rather than merely defaulting the other way.
//
// And which THREAD the rung-two slot shows (t3-lens-threads 3.4): the review's own, or
// the lens seat the store's `lensThread` names, with a control back to the session.

afterEach(() => {
  cleanup();
  act(() => useRennetStore.getState().uiActions.openLensThread(null));
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
    // workspace tests use is enough for the dock to learn its review id.
    "review.load": () => ({
      review: {
        id: "review-1",
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
      ],
    }),
    "chat.t3Session": (input) => {
      asks.push(input);
      return {
        origin: "http://127.0.0.1:43117",
        wsUrl: "ws://127.0.0.1:43117/ws",
        accessToken: "bearer-never-in-the-guest",
        environmentId: "env-1",
        pairingUrl: "http://127.0.0.1:43117/pair#token=PAIR",
        threadId: "thread-1",
        threadUrl: "http://127.0.0.1:43117/env-1/thread-1",
      };
    },
  });
  act(() => {
    useRennetStore.getState().uiActions.setSidebarOpen(false);
    useRennetStore.getState().uiActions.setChatOpen(true);
  });
  const app = <RennetRouterApp bridge={bridge} history={memoryHistory("/s/review-1")} />;
  const view = mount(
    slot ? (
      <T3ChatSlotProvider session={slot.session} thread={slot.thread}>
        {app}
      </T3ChatSlotProvider>
    ) : (
      app
    ),
  );
  return { ...view, asks };
}

/** Both rung-two components provided, each recording its props. */
function mountWithSlot() {
  const seen: T3NativeChatProps["session"][] = [];
  const opened: T3ThreadViewProps[] = [];
  const Session = ({ session }: T3NativeChatProps) => {
    seen.push(session);
    return <div data-slot="t3-native-stub">{session.threadId}</div>;
  };
  const Thread = (props: T3ThreadViewProps) => {
    opened.push(props);
    return <div data-slot="t3-thread-stub">{props.thread.threadId}</div>;
  };
  return { ...mountDock({ session: Session, thread: Thread }), seen, opened };
}

describe("the chat slot is always the T3 thread", () => {
  it("mounts the rung-one T3 view at the brokered URLs, with no engine pref set", async () => {
    const { getByTestId, asks } = mountDock();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-chat-view"]')).not.toBeNull());
    const view = dock.querySelector('[data-slot="t3-chat-view"]');
    expect(view?.getAttribute("src")).toBe("http://127.0.0.1:43117/pair#token=PAIR");
    expect(view?.getAttribute("data-thread-url")).toBe("http://127.0.0.1:43117/env-1/thread-1");
    // The ask carried the review, so the daemon bound this review's thread.
    expect(asks).toEqual([{ reviewId: "review-1" }]);
    // The bearer is not written into the guest's attributes.
    expect(dock.innerHTML).not.toContain("bearer-never-in-the-guest");
  });

  it("mounts the host-provided native view (rung two) with the session, and no <webview>", async () => {
    const { getByTestId, seen } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());
    expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1");
    expect(dock.querySelector('[data-slot="t3-chat-view"]')).toBeNull();
    expect(seen.at(-1)?.environmentId).toBe("env-1");
    // The control half of the lens tests below: with no lens opened, the read-only
    // thread view is absent, so its presence there cannot be a mount-always artefact.
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
  });

  it("opens the lens seat's thread read-only in place of the session view", async () => {
    const { getByTestId, opened } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());
    act(() =>
      useRennetStore
        .getState()
        .uiActions.openLensThread({ environmentId: "env-1", threadId: "seat-sequence" }),
    );
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-thread-stub"]')).not.toBeNull());
    // The ref the store carried reached the view whole — both ids, not just the thread.
    expect(opened.at(-1)?.thread).toEqual({ environmentId: "env-1", threadId: "seat-sequence" });
    expect(opened.at(-1)?.readOnly).toBe(true);
    expect(opened.at(-1)?.session.environmentId).toBe("env-1");
    // The session's own thread is not also mounted: one view fills the slot.
    expect(dock.querySelector('[data-slot="t3-native-stub"]')).toBeNull();
  });

  it("returns to the session view when the back control clears the lens", async () => {
    const { getByTestId } = mountWithSlot();
    const dock = getByTestId("chat-dock-slot");
    act(() =>
      useRennetStore
        .getState()
        .uiActions.openLensThread({ environmentId: "env-1", threadId: "seat-design" }),
    );
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-thread-stub"]')).not.toBeNull());
    const back = dock.querySelector('[data-slot="t3-thread-back"]');
    expect(back?.textContent).toContain("Back to the session");
    act(() => {
      fireEvent.click(back as Element);
    });
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());
    expect(dock.querySelector('[data-slot="t3-thread-stub"]')).toBeNull();
    expect(useRennetStore.getState().ui.lensThread).toBeNull();
  });
});
