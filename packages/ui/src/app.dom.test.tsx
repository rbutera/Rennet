// @vitest-environment happy-dom
//
// App-level clear-on-sign (issue #80 MUT I; re-pointed for the R40 frame → draft →
// paper journey, issue #101). The dispose == staged journey ending — signing the
// paper clears the draft and closes the surfaces — is exercised end-to-end. This
// mounts the WHOLE `RennetApp` over a minimal fake `RennetBridge`, stages a
// disposition, opens the COLLATION DRAFT (frame → draft), signs the draft into the
// PAPER (draft → paper), completes a sign, and asserts the destination's collated
// count returns to zero and both surfaces close. The assertion is behavioural
// (data-staged-count → 0), never a presence check. Uses real timers + a keyboard
// sign so no clock control is needed and `waitFor` (real-timer polling) works.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

// A ready review with one changed, not-yet-disposed file, so ReviewWorkspace shows
// a "Mark read" button (the simplest staging path: `setFileRead` stages via
// `setStaged` synchronously, before it awaits the bridge).
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

// A minimal fake bridge: bootstrap returns the ready review; every command the app
// invokes (setDisposition, checkFreshness) resolves the same review. The app never
// opens the Canvases view in this test, so `review.canvases` is not exercised.
function fakeBridge(ready: Review): RennetBridge {
  const invoke = async (): Promise<{ review: Review }> => ({ review: ready });
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

describe("RennetApp — signing clears the staged paper at the app level (MUT I)", () => {
  it("stages a disposition, opens the sheet, and a sign empties the destination + closes the sheet", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={fakeBridge(review)} />);

    // The review loads (app.bootstrap resolves) → the destination chrome renders,
    // empty at review-open.
    const destination = () => container.querySelector(".destination-frame");
    await waitFor(() => expect(destination()).not.toBeNull());
    expect(destination()?.getAttribute("data-staged-count")).toBe("0");

    // Stage a disposition: Mark read stages toward the destination in the same act.
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(destination()?.getAttribute("data-staged-count")).toBe("1"));

    // Frame → DRAFT: the frame opens the collation draft canvas (not the paper).
    const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
    if (!openDraft) throw new Error("the open-draft control did not render");
    fireEvent.click(openDraft);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());

    // Draft → PAPER: signing the draft freezes it into the paper (the phase
    // transition). The paper renders; the draft is behind it.
    const signDraft = container.querySelector<HTMLButtonElement>(".collation-sign");
    if (!signDraft) throw new Error("the draft sign control did not render");
    fireEvent.click(signDraft);
    await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());

    // Complete a sign via the keyboard (deliberate Enter on the focused control).
    const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
    if (!sign) throw new Error("the sign control did not render");
    sign.focus();
    fireEvent.keyDown(sign, { key: "Enter" });

    // dispose == staged journey ending: the draft is cleared and BOTH surfaces
    // close. RED-proof: delete `setDraft([])` from the onSign handler → the count
    // stays "1" → this waitFor never satisfies.
    await waitFor(() => {
      expect(destination()?.getAttribute("data-staged-count")).toBe("0");
      expect(container.querySelector(".publish-sheet")).toBeNull();
      expect(container.querySelector(".collation-canvas")).toBeNull();
    });
  });
});
