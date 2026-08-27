// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";
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

  it("an unresolvable session slug renders an honest not-found, never a crash", async () => {
    // frontDoorBridge has no review.load handler → the slug does not resolve.
    const history = memoryHistory("/s/does-not-exist");
    const { findByText } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);
    expect(await findByText("Not found")).toBeTruthy();
  });
});
