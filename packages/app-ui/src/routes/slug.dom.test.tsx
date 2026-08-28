// @vitest-environment happy-dom
//
// `useSlugResolution` decides which of five surfaces `/s/:slug` is. Two of the five are
// claims the resolver is NOT entitled to make from the evidence it had:
//
//  • "not found" is a claim about ABSENCE, and only a settled, current `session.list` can
//    support it. The mint invalidates that list and navigates in the same act, so the list
//    in hand at the front door is populated and one session out of date — the reviewer's
//    click worked, and the route said Not found.
//  • a `session.list` that FAILED says nothing about whether the slug exists. Rendering
//    not-found there blames the reviewer's url for the daemon's fault.
//
// Both are driven here through the real seam (a real invalidation, a real refetch), not by
// hand-setting a status.
import type { SidebarSession } from "@rennet/protocol";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { BridgeProvider, useCommand, useMutation } from "../data";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { useSlugResolution } from "./slug";

const MINTED: SidebarSession = {
  id: "sess-2",
  projectId: "p1",
  title: "Refactor the parser",
  target: "your-branch",
  createdAt: 0,
};

function Probe({ slug }: { readonly slug: string }) {
  return <span data-testid="status">{useSlugResolution(slug).status}</span>;
}

describe("useSlugResolution never claims not-found it cannot support", () => {
  it("the mint's own session does not flash Not found while the stale list refetches", async () => {
    let minted = false;
    const bridge = new MemoryBridge({
      "session.list": () => ({ sessions: minted ? [MINTED] : [] }),
      "session.mint": () => {
        minted = true;
        return { session: MINTED };
      },
      "review.load": () => {
        // A freshly minted session has no review — the daemon's typed missing signal.
        throw new Error("Review not found");
      },
    });

    // The sidebar is ALREADY mounted and has ALREADY read the list before the mint — which
    // is what makes this different from a cold load, and is the whole reason the old
    // `!sessions.data` guard did not fire.
    function Harness() {
      const sessions = useCommand("session.list", {});
      const { mutate } = useMutation("session.mint", { invalidates: ["session.list"] });
      const [route, setRoute] = useState<string>();
      return (
        <>
          <span data-testid="sidebar">{sessions.data ? "loaded" : "pending"}</span>
          <button
            type="button"
            onClick={() => void mutate({ projectId: "p1" }).then((r) => setRoute(r.session?.id))}
          >
            mint
          </button>
          {route === undefined ? null : <Probe slug={route} />}
        </>
      );
    }

    const { getByTestId, getByText, user } = mount(
      <BridgeProvider bridge={bridge}>
        <Harness />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByTestId("sidebar").textContent).toBe("loaded"));

    await user.click(getByText("mint"));
    // The instant the route mounts, the cached list is populated AND one session out of
    // date. "I have a list and it does not contain you" is not true here, and saying it is
    // the front door reporting a click that worked as broken.
    await waitFor(() => expect(getByTestId("status")).toBeTruthy());
    expect(getByTestId("status").textContent).not.toBe("not-found");
    // And it settles on the real answer once the refetch lands.
    await waitFor(() => expect(getByTestId("status").textContent).toBe("session"));
  });

  it("a session.list FAILURE is reported as the failure it is, not as not-found", async () => {
    const bridge = new MemoryBridge({
      "session.list": () => {
        throw new Error("daemon connection lost");
      },
      "review.load": () => {
        throw new Error("Review not found");
      },
    });
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridge}>
        <Probe slug="sess-2" />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByTestId("status").textContent).toBe("error"));
  });

  it("POSITIVE CONTROL: a settled list that truly lacks the slug IS not-found", async () => {
    // The guards above must not turn every unknown slug into a permanent "Opening…".
    const bridge = new MemoryBridge({
      "session.list": () => ({ sessions: [] }),
      "review.load": () => {
        throw new Error("Review not found");
      },
    });
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridge}>
        <Probe slug="nobody" />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByTestId("status").textContent).toBe("not-found"));
  });
});
