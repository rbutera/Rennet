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
import { T3ChatSlotProvider, type T3NativeChatProps } from "./t3-chat-slot";

// The chat slot's engine switch (t3code-sidecar-chat, 6.1): with the session's project
// resolved to `t3`, the slot mounts the rung-one <webview> at the daemon-brokered URLs;
// with `rennet` (or no resolved engine at all) it stays Rennet's own dock. Positive
// control: the `t3` mount only appears when the setting says so.

afterEach(() => cleanup());

const layered = (value: string) => ({ value, layer: "builtin" as const });

function projectRow(engine: "rennet" | "t3" | undefined): SettingsProject {
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
      ...(engine ? { chatEngine: { value: engine, layer: "repo" as const } } : {}),
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

function mountWithEngine(
  engine: "rennet" | "t3" | undefined,
  native?: ComponentType<T3NativeChatProps>,
) {
  const asks: unknown[] = [];
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": () => ({ ...emptySettings(), projects: [projectRow(engine)] }),
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
    native ? <T3ChatSlotProvider component={native}>{app}</T3ChatSlotProvider> : app,
  );
  return { ...view, asks };
}

describe("the chat slot follows the project's chat engine", () => {
  it("mounts the rung-one T3 view at the brokered URLs when the engine is t3", async () => {
    const { getByTestId, asks } = mountWithEngine("t3");
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
    const seen: T3NativeChatProps["session"][] = [];
    const Native = ({ session }: T3NativeChatProps) => {
      seen.push(session);
      return <div data-slot="t3-native-stub">{session.threadId}</div>;
    };
    const { getByTestId } = mountWithEngine("t3", Native);
    const dock = getByTestId("chat-dock-slot");
    await waitFor(() => expect(dock.querySelector('[data-slot="t3-native-stub"]')).not.toBeNull());
    expect(dock.querySelector('[data-slot="t3-native-stub"]')?.textContent).toBe("thread-1");
    expect(dock.querySelector('[data-slot="t3-chat-view"]')).toBeNull();
    expect(seen.at(-1)?.environmentId).toBe("env-1");
  });

  it.each([["rennet" as const], [undefined]])(
    "keeps Rennet's own dock when the engine is %s",
    async (engine) => {
      const { getByTestId, asks } = mountWithEngine(engine);
      const dock = getByTestId("chat-dock-slot");
      await waitFor(() => expect(dock.querySelector("header")).not.toBeNull());
      expect(dock.querySelector('[data-slot="t3-chat-view"]')).toBeNull();
      expect(dock.querySelector('[data-slot="t3-chat-dock"]')).toBeNull();
      expect(asks).toEqual([]);
    },
  );
});
