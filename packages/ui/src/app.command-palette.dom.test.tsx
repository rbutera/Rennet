// @vitest-environment happy-dom
//
// The ⌘K command palette, wired app-wide (wireframes screen 16). This mounts the
// WHOLE `RennetApp` over a fake bridge that lands on the review workspace, presses
// ⌘K (a window-level shortcut, so it fires regardless of focus), and drives a
// command end-to-end: filtering to "Show Files view" and running it must actually
// switch the app to the Files view. The assertion is behavioural (the Files surface
// renders), never a presence check on the palette alone.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

// A lenient bridge: bootstrap/freshness resolve the ready review; the flagged/noise
// fetches return honest empties; the canvases load rejects (→ the honest "failed"
// primer) so the test stays on the workspace screen without a full canvas set. The
// workspace's own commands are live regardless of the canvas load.
function bridge(): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    if (name === "app.bootstrap") return { review };
    if (name === "review.checkFreshness") return { review };
    if (name === "flagged.review") return { status: "ok", findings: [] };
    if (name === "noise.review") return { status: "ok", groups: [] };
    if (name === "openspec.change") return null;
    // review.canvases + anything else: unavailable in this test.
    throw new Error(`unhandled ${name}`);
  };
  return { invoke } as RennetBridge;
}

describe("RennetApp — ⌘K command palette", () => {
  it("opens on ⌘K and runs a command that switches the app to the Files view", async () => {
    const { user, container, getByLabelText, getByText, queryByText } = mount(
      <RennetApp bridge={bridge()} />,
    );

    // Land on the workspace (the view toggle appears once a review is open).
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());
    // The Files surface is not shown yet (default view is Canvases).
    expect(queryByText("Changes")).toBeNull();

    // ⌘K from anywhere opens the palette (window-level listener).
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).toBeTruthy());

    // Filter to the Files command and run it.
    await user.type(getByLabelText("Search commands"), "Files");
    await user.keyboard("{Enter}");

    // The real handler fired: the app is now on the Files view (its "Changes" panel).
    await waitFor(() => expect(getByText("Changes")).toBeTruthy());
    // The palette closed after running.
    expect(container.querySelector(".command-palette")).toBeNull();
  });

  it("toggles closed on a second ⌘K", async () => {
    const { container, getByText } = mount(<RennetApp bridge={bridge()} />);
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).toBeTruthy());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).toBeNull());
  });
});
