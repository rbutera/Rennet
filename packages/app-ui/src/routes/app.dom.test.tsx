// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { RennetRouterApp } from "./app";
import { memoryHistory } from "./history";

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
