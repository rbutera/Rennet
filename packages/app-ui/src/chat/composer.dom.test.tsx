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
import { act, cleanup, fireEvent, mount, screen } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { SessionTranscriptProvider } from "./chat-data";
import { ChatDock } from "./chat-dock";
import { Composer } from "./composer";

// happy-dom does not implement object URLs; the composer mints/revokes them on image badges.
beforeEachStubObjectUrl();
afterEach(() => {
  cleanup();
  act(() => useRennetStore.getState().reviewActions.resetReview());
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

  it("surfaces a quote badge from review.quoteThreads and clears it on remove", async () => {
    act(() =>
      useRennetStore.getState().reviewActions.addQuoteComment("scoped middleware", "why here?"),
    );
    const { user } = mount(<Composer onSend={() => undefined} />);
    expect(screen.getByText(/scoped middleware/)).toBeTruthy();

    await user.click(screen.getByLabelText(/Remove quoted-text comment reference/));
    expect(Object.keys(useRennetStore.getState().review.quoteThreads).length).toBe(0);
  });
});

describe("composer send + image + presence (task 4.3)", () => {
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
  });
});
