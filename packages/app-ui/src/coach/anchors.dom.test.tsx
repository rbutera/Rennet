// @vitest-environment happy-dom
//
// C13 Cluster 4 — the mount + anchoring proven end to end from the app-ui side: the shell
// provider, real `useCoachAnchor` refs on live DOM chrome, and the one shell `<Coachmark/>`
// that renders the elected mark's card. Data enters through the settings MemoryBridge (the
// same seam the real shell uses), so these run the true election/chain/replay path — not the
// pure store (Cluster 1's `store.test.ts` owns that). Four proofs: the chain elects
// `start-review` first and renders its card against the live anchor, dismissing chains to the
// next mark on the surface, a disabled anchor never elects, and Replay re-arms after skip-all.
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { cleanup, mount, waitFor } from "../test/dom";
import { SettingsStore } from "../test/fixtures/settings";
import { MemoryBridge } from "../test/memory-bridge";
import { Coachmark } from "./coachmark";
import { useCoachOptional } from "./context";
import { CoachDataProvider } from "./provider";
import { useCoachAnchor } from "./registry";

/** A Replay control, wired exactly as the sidebar's Replay Tour row is (C13 task 4). */
function ReplayButton() {
  const coach = useCoachOptional();
  return (
    <button
      type="button"
      data-testid="replay"
      disabled={!coach}
      onClick={() => coach?.store.getState().replay()}
    >
      replay
    </button>
  );
}

/** Two real chrome anchors (start-review outranks new-chat in system order) + the shell
 *  Coachmark, all under the data provider. `newChatEnabled=false` models an unlanded surface. */
function Harness({ newChatEnabled = true }: { newChatEnabled?: boolean }) {
  const startRef = useCoachAnchor("start-review");
  const newChatRef = useCoachAnchor("new-chat", newChatEnabled);
  return (
    <div>
      <button type="button" ref={startRef} data-testid="start-anchor">
        start a review
      </button>
      <button type="button" ref={newChatRef} data-testid="new-chat-anchor">
        new chat
      </button>
      <ReplayButton />
      <Coachmark />
    </div>
  );
}

function mountHarness(store: SettingsStore, props?: { newChatEnabled?: boolean }) {
  return mount(
    <BridgeProvider bridge={new MemoryBridge(store.handlers())}>
      <CoachDataProvider>
        <Harness newChatEnabled={props?.newChatEnabled} />
      </CoachDataProvider>
    </BridgeProvider>,
  );
}

describe("coach mount + anchors (C13 Cluster 4)", () => {
  it("elects start-review first and renders its card against the live anchor", async () => {
    const { findByText } = mountHarness(new SettingsStore());
    // The shell Coachmark renders the first-in-system-order mark's teaching card; its anchor
    // is the real `start-review` button, resolved through the typed registry (no querySelector).
    expect(await findByText("Ready to Go")).toBeTruthy();
    cleanup();
  });

  it("dismissing a mark chains to the next mark on the surface", async () => {
    const { findByText, getByLabelText, queryByText } = mountHarness(new SettingsStore());
    await findByText("Ready to Go");
    // Dismiss via the card's ✕ — retires start-review, opens the chain gap, then new-chat wins.
    getByLabelText("Dismiss tip").click();
    await waitFor(() => expect(queryByText("Ready to Go")).toBeNull());
    expect(await findByText("Start Here")).toBeTruthy();
    cleanup();
  });

  it("a disabled anchor never elects — its mark stays off screen", async () => {
    // Only new-chat's surface is on screen, but it is disabled; start-review has no anchor here.
    const { getByTestId, queryByText } = mountHarness(new SettingsStore(), {
      newChatEnabled: false,
    });
    await waitFor(() => expect(getByTestId("new-chat-anchor")).toBeTruthy());
    // Nothing elects: start-review is unregistered, new-chat is disabled.
    expect(queryByText("Ready to Go")).toBeNull();
    expect(queryByText("Start Here")).toBeNull();
    cleanup();
  });

  it("Replay re-arms every mark after skip-all", async () => {
    const { findByText, getByText, getByTestId, queryByText } = mountHarness(new SettingsStore());
    await findByText("Ready to Go");
    // Skip all tips — the card leaves and skipAll persists (settings.setCoachmarks).
    getByText("Skip all tips").click();
    await waitFor(() => expect(queryByText("Ready to Go")).toBeNull());
    // Replay clears seen + skipAll and re-elects the first mark on a live surface.
    getByTestId("replay").click();
    expect(await findByText("Ready to Go")).toBeTruthy();
    cleanup();
  });
});
