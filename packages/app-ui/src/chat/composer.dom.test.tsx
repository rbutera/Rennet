// @vitest-environment happy-dom
//
// C07 cluster 4 (task 4.3): the composer reads the REAL `review` slice (reconciliation 5)
// — a stored code comment surfaces a comment badge (removing it clears `review.codeComments`),
// a stored quote thread surfaces a quote badge; sending invokes `review.ask` with the typed
// body through the seam (reconciliation 8: no staging, no command effects); an image paste
// adds then removes a local badge; and the presence affordance follows the in-flight state.
import type { AskReviewResult, CommandInput } from "@rennet/protocol";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { SessionTranscriptProvider } from "./chat-data";
import { ChatDock } from "./chat-dock";
import { Composer } from "./composer";

// happy-dom does not implement object URLs; the composer mints/revokes them on image badges.
beforeEachStubObjectUrl();
afterEach(() => {
  cleanup();
  act(() => {
    useRennetStore.getState().reviewActions.resetReview();
    useRennetStore.getState().uiActions.setChatOpen(false);
  });
});

function beforeEachStubObjectUrl(): void {
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:stub";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => undefined;
  }
}

const REVIEW_ID = "review-1";

describe("composer badges read the real review slice (task 4.3)", () => {
  it("surfaces a comment badge from review.codeComments and clears it on remove", async () => {
    act(() => useRennetStore.getState().reviewActions.setCodeComment("src/a.ts", 12, "off by one"));
    const { user } = mount(<Composer onSend={() => undefined} />);
    expect(screen.getByText("1 comment")).toBeTruthy();

    await user.click(screen.getByLabelText(/Remove comment on line 12 reference/));
    expect(useRennetStore.getState().review.codeComments["src/a.ts"]?.[12]).toBeUndefined();
  });

  it("draws every glyph at Rennet's 1.6px line, not lucide's 2px default", () => {
    // The composer rendered its lucide elements RAW, so its icons sat a third heavier than
    // the ones beside them. Mixed weights on one surface is the defect; this asserts the
    // whole surface, not one icon, so a newly added raw element reddens it.
    act(() => useRennetStore.getState().reviewActions.setCodeComment("src/a.ts", 12, "off by one"));
    // WHAT THIS REACHES: the four glyphs a comment badge puts on screen (badge mark, its
    // remove X, the hover card's path icon, and the send arrow). It is asserted in both
    // in-flight states because the state changes what is mounted; the presence affordance
    // itself carries no lucide element (it is a pulsing dot), so nothing new arrives with it.
    // An icon on a path this never mounts — the image badge's <img>, for one — is an icon
    // this cannot check.
    const { container, rerender } = mount(<Composer onSend={() => undefined} inFlight={false} />);
    const widths = () =>
      [...container.querySelectorAll("svg.lucide")].map((svg) => svg.getAttribute("stroke-width"));
    expect(widths().length).toBeGreaterThan(2);
    expect(new Set(widths())).toEqual(new Set(["1.6"]));

    rerender(<Composer onSend={() => undefined} inFlight={true} />);
    expect(screen.getByText(/orchestrator is working/)).toBeTruthy();
    expect(new Set(widths())).toEqual(new Set(["1.6"]));
  });

  it("surfaces a quote badge from review.quoteThreads and clears it on remove", async () => {
    act(() =>
      useRennetStore.getState().reviewActions.addQuoteComment("scoped middleware", "why here?"),
    );
    const { user } = mount(<Composer onSend={() => undefined} />);
    expect(screen.getByText(/scoped middleware/)).toBeTruthy();

    await user.click(screen.getByLabelText(/Remove quoted-text comment reference/));
    expect(Object.keys(useRennetStore.getState().review.quoteThreads).length).toBe(0);
  });

  it("labels a detached quote badge instead of dropping the thread", () => {
    act(() => {
      const id = useRennetStore
        .getState()
        .reviewActions.addQuoteComment("removed prose", "where did this go?", "comment", {
          target: "old-prose",
          generation: "gen-1",
        });
      const state = useRennetStore.getState();
      const thread = state.review.quoteThreads[id];
      if (!thread || thread.target === undefined || thread.generation === undefined) return;
      useRennetStore.setState({
        review: {
          ...state.review,
          quoteThreads: { [id]: { ...thread, lifecycle: "detached" } },
        },
      });
    });

    mount(<Composer onSend={() => undefined} />);
    expect(screen.getByText("Detached")).toBeTruthy();
    expect(screen.getByText(/removed prose/)).toBeTruthy();
  });
});

describe("composer send + image + presence (task 4.3)", () => {
  it("focuses the existing composer when the chat focus action fires", async () => {
    mount(<Composer onSend={() => undefined} />);
    const textarea = screen.getByLabelText("Message the orchestrator");

    act(() => useRennetStore.getState().uiActions.focusChatComposer());

    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(useRennetStore.getState().ui.chatOpen).toBe(true);
  });

  it("sends the typed body and clears the input", async () => {
    const onSend = vi.fn();
    const { user } = mount(<Composer onSend={onSend} />);
    const textarea = screen.getByLabelText("Message the orchestrator");
    await user.type(textarea, "does the reorder touch public routes?");
    await user.click(screen.getByLabelText("Send"));
    expect(onSend).toHaveBeenCalledWith("does the reorder touch public routes?");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("adds then removes a local image badge on paste", async () => {
    const { user } = mount(<Composer onSend={() => undefined} />);
    const textarea = screen.getByLabelText("Message the orchestrator");
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] },
    });
    expect(await screen.findByText("shot.png")).toBeTruthy();

    await user.click(screen.getByLabelText(/Remove shot.png reference/));
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  it("shows the orchestrator-presence affordance only while in flight", () => {
    const { rerender } = mount(<Composer onSend={() => undefined} inFlight={false} />);
    expect(screen.queryByText(/orchestrator is working/)).toBeNull();
    rerender(<Composer onSend={() => undefined} inFlight={true} />);
    expect(screen.getByText(/orchestrator is working/)).toBeTruthy();
  });
});

function DockHarness({ bridge }: { readonly bridge: MemoryBridge }): ReactNode {
  return (
    <BridgeProvider bridge={bridge}>
      <SessionTranscriptProvider
        value={{ reviewId: REVIEW_ID, rows: [], trail: { title: "Alpha" } }}
      >
        <ChatDock />
      </SessionTranscriptProvider>
    </BridgeProvider>
  );
}

describe("send fires review.ask through the seam (task 4.3, reconciliation 8)", () => {
  it("invokes review.ask with the typed question for the live review", async () => {
    const asks: Array<CommandInput<"review.ask">> = [];
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "review.reattach": () => ({ threads: [], inFlight: [] }),
      "review.ask": (input): AskReviewResult => {
        asks.push(input);
        return { mode: "orchestrator", primary: { model: "opus", answer: "no impact" } };
      },
    });
    const { user } = mount(<DockHarness bridge={bridge} />);
    await act(async () => {
      await Promise.resolve();
    });
    await user.type(
      screen.getByLabelText("Message the orchestrator"),
      "any public routes affected?",
    );
    await user.click(screen.getByLabelText("Send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asks.length).toBe(1);
    expect(asks[0]?.reviewId).toBe(REVIEW_ID);
    expect(asks[0]?.question).toBe("any public routes affected?");
    // Its RAW turn body is persisted so a re-attach shows what was asked (#251).
    expect(asks[0]?.turnBody).toBe("any public routes affected?");
    // The ask carries a `fragment` anchor (F1, #570). Dispatch persists a turn ONLY
    // when the ask is anchored, so WITHOUT this the answer is lost on reload and
    // `review.reattach` — the dock's own read — comes back empty. A chat turn hangs
    // on the message, not on code, so it carries no `path`.
    expect(asks[0]?.anchor).toEqual({
      kind: "fragment",
      label: "any public routes affected?",
      key: asks[0]?.threadId,
    });
  });
});
